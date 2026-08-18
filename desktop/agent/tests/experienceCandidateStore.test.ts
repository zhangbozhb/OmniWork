import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentSurfaceEventPayload } from "@omni-work/protocol-ts";
import { AgentObservationStore } from "../src/learning/agentObservationStore.ts";
import {
  DeliveryEpisodeStore,
  type DeliveryEpisode,
} from "../src/learning/deliveryEpisodeStore.ts";
import { ExperienceCandidateStore } from "../src/learning/experienceCandidateStore.ts";

async function fixture(): Promise<{
  observations: AgentObservationStore;
  episodes: DeliveryEpisodeStore;
  candidates: ExperienceCandidateStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "omniwork-candidates-"));
  const path = join(directory, "sessions.sqlite");
  return {
    observations: new AgentObservationStore(path),
    episodes: new DeliveryEpisodeStore(path),
    candidates: new ExperienceCandidateStore(path),
  };
}

function event(input: {
  id: string;
  eventType: AgentSurfaceEventPayload["event_type"];
  provider: string;
  rawEventId: string;
  prompt?: string;
  createdAt: string;
}): AgentSurfaceEventPayload {
  return {
    session_id: "session-1",
    surface_id: "surface-1",
    provider: input.provider,
    event_id: input.id,
    event_type: input.eventType,
    title:
      input.eventType === "agent.completed"
        ? "Codex turn completed"
        : "User prompt submitted",
    payload: input.prompt ? { prompt: input.prompt } : undefined,
    source: { kind: "process", raw_event_id: input.rawEventId },
    created_at: input.createdAt,
  };
}

function deliveredEpisode(
  observations: AgentObservationStore,
  episodes: DeliveryEpisodeStore,
  suffix: string,
  prompt = "Implement the feature",
  workspace = "/tmp/project",
): DeliveryEpisode {
  const episode = episodes.apply(
    observations.putSurfaceEvent(
      event({
        id: `prompt-${suffix}`,
        eventType: "agent.user_prompt_submitted",
        provider: "user",
        rawEventId: `prompt-${suffix}`,
        prompt,
        createdAt: `2026-08-15T00:00:0${suffix}.000Z`,
      }),
      workspace,
    ),
  );
  episodes.apply(
    observations.putSurfaceEvent(
      event({
        id: `turn-${suffix}`,
        eventType: "agent.completed",
        provider: "codex",
        rawEventId: `turn:${suffix}:completed`,
        createdAt: `2026-08-15T00:00:1${suffix}.000Z`,
      }),
      workspace,
    ),
  );
  return episodes.get(episode?.episodeId ?? "") as DeliveryEpisode;
}

function revise(
  episodes: DeliveryEpisodeStore,
  episode: DeliveryEpisode,
  actionId: string,
  note = "Add focused tests",
): DeliveryEpisode {
  const result = episodes.setOutcome({
    kind: "outcome_set",
    episode_id: episode.episodeId,
    session_id: episode.sessionId,
    surface_id: episode.surfaceId,
    client_action_id: actionId,
    outcome: "revision_requested",
    note,
    created_at: "2026-08-15T00:01:00.000Z",
  });
  assert.equal(result.result, "applied");
  return episodes.get(episode.episodeId) as DeliveryEpisode;
}

test("ExperienceCandidateStore creates project candidates from explicit corrections", async () => {
  const { observations, episodes, candidates } = await fixture();
  const first = revise(
    episodes,
    deliveredEpisode(observations, episodes, "1"),
    "outcome-1",
  );
  const firstChanges = candidates.reconcileEpisode(first);
  const second = revise(
    episodes,
    deliveredEpisode(observations, episodes, "2"),
    "outcome-2",
  );
  candidates.reconcileEpisode(second);

  assert.equal(firstChanges.length, 1);
  const result = candidates.list({ projectId: first.projectId });
  assert.equal(result.length, 1);
  assert.equal(result[0]?.kind, "user_correction");
  assert.equal(result[0]?.trigger, "Implement the feature");
  assert.equal(result[0]?.guidance, "Add focused tests");
  assert.equal(result[0]?.status, "candidate");
  assert.equal(result[0]?.support_count, 2);
  assert.deepEqual(result[0]?.supporting_episode_ids, [
    first.episodeId,
    second.episodeId,
  ]);
  assert.deepEqual(result[0]?.contradicting_episode_ids, []);
});

test("ExperienceCandidateStore removes unreviewed candidates when feedback is retracted", async () => {
  const { observations, episodes, candidates } = await fixture();
  const episode = revise(
    episodes,
    deliveredEpisode(observations, episodes, "1"),
    "outcome-revise",
  );
  const updated = candidates.reconcileEpisode(episode);
  assert.equal(updated[0]?.kind, "updated");

  episodes.setOutcome({
    kind: "outcome_set",
    episode_id: episode.episodeId,
    session_id: episode.sessionId,
    surface_id: episode.surfaceId,
    client_action_id: "outcome-accept",
    outcome: "accepted",
    created_at: "2026-08-15T00:02:00.000Z",
  });
  const removed = candidates.reconcileEpisode(
    episodes.get(episode.episodeId) as DeliveryEpisode,
  );

  assert.equal(removed[0]?.kind, "removed");
  assert.equal(candidates.list().length, 0);
});

test("ExperienceCandidateStore audits idempotent reviews and preserves approved evidence", async () => {
  const { observations, episodes, candidates } = await fixture();
  const episode = revise(
    episodes,
    deliveredEpisode(observations, episodes, "1"),
    "outcome-revise",
  );
  const changes = candidates.reconcileEpisode(episode);
  const candidate =
    changes[0]?.kind === "updated" ? changes[0].candidate : undefined;
  assert.ok(candidate);
  const review = {
    kind: "review_set" as const,
    candidate_id: candidate.candidate_id,
    project_id: candidate.project_id,
    client_action_id: "review-1",
    decision: "approved" as const,
    trigger: "When implementing this feature",
    guidance: "Add focused unit tests",
    note: "Project rule",
    created_at: "2026-08-15T00:03:00.000Z",
  };

  const applied = candidates.setReview(review);
  const duplicate = candidates.setReview(review);
  const conflict = candidates.setReview({
    ...review,
    decision: "rejected",
  });

  assert.equal(applied.result, "applied");
  assert.equal(duplicate.result, "duplicate");
  assert.equal(conflict.result, "conflict");
  const approved = candidates.get(candidate.candidate_id);
  assert.equal(approved?.status, "approved");
  assert.equal(approved?.trigger, "When implementing this feature");
  assert.equal(approved?.guidance, "Add focused unit tests");
  assert.equal(approved?.review_note, "Project rule");
  candidates.reconcileEpisode(
    episodes.get(episode.episodeId) as DeliveryEpisode,
  );
  assert.equal(candidates.list().length, 1);
  assert.equal(candidates.get(candidate.candidate_id)?.support_count, 1);

  episodes.setOutcome({
    kind: "outcome_set",
    episode_id: episode.episodeId,
    session_id: episode.sessionId,
    surface_id: episode.surfaceId,
    client_action_id: "outcome-accept",
    outcome: "accepted",
    created_at: "2026-08-15T00:04:00.000Z",
  });
  candidates.reconcileEpisode(
    episodes.get(episode.episodeId) as DeliveryEpisode,
  );
  assert.equal(candidates.get(candidate.candidate_id)?.status, "deprecated");
});

test("ExperienceCandidateStore audits pause, resume, and deprecate lifecycle actions", async () => {
  const { observations, episodes, candidates } = await fixture();
  const episode = revise(
    episodes,
    deliveredEpisode(observations, episodes, "1"),
    "outcome-revise",
  );
  const changes = candidates.reconcileEpisode(episode);
  const candidate =
    changes[0]?.kind === "updated" ? changes[0].candidate : undefined;
  assert.ok(candidate);
  candidates.setReview({
    kind: "review_set",
    candidate_id: candidate.candidate_id,
    project_id: candidate.project_id,
    client_action_id: "review-approve",
    decision: "approved",
    created_at: "2026-08-15T00:02:00.000Z",
  });
  const pause = {
    kind: "lifecycle_set" as const,
    candidate_id: candidate.candidate_id,
    project_id: candidate.project_id,
    client_action_id: "lifecycle-pause",
    action: "pause" as const,
    note: "Check the next delivery",
    created_at: "2026-08-15T00:03:00.000Z",
  };

  assert.equal(candidates.setLifecycle(pause).result, "applied");
  assert.equal(candidates.setLifecycle(pause).result, "duplicate");
  assert.equal(
    candidates.setLifecycle({ ...pause, action: "deprecate" }).result,
    "conflict",
  );
  assert.equal(candidates.get(candidate.candidate_id)?.status, "paused");
  assert.equal(
    candidates.setLifecycle({
      ...pause,
      client_action_id: "lifecycle-resume",
      action: "resume",
      created_at: "2026-08-15T00:04:00.000Z",
    }).result,
    "applied",
  );
  assert.equal(candidates.get(candidate.candidate_id)?.status, "approved");
  assert.equal(
    candidates.setLifecycle({
      ...pause,
      client_action_id: "lifecycle-deprecate",
      action: "deprecate",
      created_at: "2026-08-15T00:05:00.000Z",
    }).result,
    "applied",
  );
  assert.equal(candidates.get(candidate.candidate_id)?.status, "deprecated");
  assert.equal(
    candidates.setLifecycle({
      ...pause,
      client_action_id: "lifecycle-invalid-resume",
      action: "resume",
      created_at: "2026-08-15T00:06:00.000Z",
    }).result,
    "invalid_state",
  );
});

test("ExperienceCandidateStore pauses stale approved experience with an audit action", async () => {
  const { observations, episodes, candidates } = await fixture();
  const episode = revise(
    episodes,
    deliveredEpisode(observations, episodes, "1"),
    "outcome-stale",
  );
  const changes = candidates.reconcileEpisode(episode);
  const candidate =
    changes[0]?.kind === "updated" ? changes[0].candidate : undefined;
  assert.ok(candidate);
  candidates.setReview({
    kind: "review_set",
    candidate_id: candidate.candidate_id,
    project_id: candidate.project_id,
    client_action_id: "review-stale",
    decision: "approved",
    created_at: "2026-08-15T00:02:00.000Z",
  });

  const stale = candidates.applyStaleness(
    "2027-03-01T00:00:00.000Z",
  );

  assert.equal(stale.length, 1);
  assert.equal(stale[0]?.kind, "updated");
  assert.equal(candidates.get(candidate.candidate_id)?.status, "paused");
  assert.equal(
    candidates.applyStaleness("2027-03-02T00:00:00.000Z").length,
    0,
  );
});

test("ExperienceCandidateStore reports but does not auto-apply cross-project promotion eligibility", async () => {
  const { observations, episodes, candidates } = await fixture();
  const first = revise(
    episodes,
    deliveredEpisode(
      observations,
      episodes,
      "1",
      "Implement the feature",
      "/tmp/project-a",
    ),
    "outcome-project-a",
  );
  const second = revise(
    episodes,
    deliveredEpisode(
      observations,
      episodes,
      "2",
      "Implement the feature",
      "/tmp/project-b",
    ),
    "outcome-project-b",
  );
  const firstCandidate = candidates.reconcileEpisode(first);
  const secondCandidate = candidates.reconcileEpisode(second);
  for (const [index, change] of [
    firstCandidate[0],
    secondCandidate[0],
  ].entries()) {
    assert.equal(change?.kind, "updated");
    if (change?.kind === "updated") {
      candidates.setReview({
        kind: "review_set",
        candidate_id: change.candidate.candidate_id,
        project_id: change.candidate.project_id,
        client_action_id: `review-project-${index}`,
        decision: "approved",
        created_at: "2026-08-15T00:02:00.000Z",
      });
    }
  }

  const promotions = candidates.listPromotionEligibility();
  assert.equal(promotions.length, 1);
  assert.equal(promotions[0]?.project_count, 2);
  assert.equal(promotions[0]?.eligible, true);
  assert.equal(promotions[0]?.candidate_ids.length, 2);
  assert.equal(
    candidates.list({ projectId: first.projectId })[0]?.status,
    "approved",
  );
});

test("ExperienceCandidateStore ignores inferred Git review outcomes", async () => {
  const { observations, episodes, candidates } = await fixture();
  deliveredEpisode(observations, episodes, "1");
  const review = event({
    id: "review-prompt",
    eventType: "agent.user_prompt_submitted",
    provider: "user",
    rawEventId: "review-prompt",
    prompt: "Please address the review notes.",
    createdAt: "2026-08-15T00:02:00.000Z",
  });
  review.payload = {
    prompt: "Please address the review notes.",
    prompt_origin: "git_review",
  };
  const inferred = episodes.recordGitReviewRevision(
    observations.putSurfaceEvent(review, "/tmp/project"),
  );

  assert.equal(inferred?.outcomeSource, "git_review");
  assert.deepEqual(
    candidates.reconcileEpisode(inferred as DeliveryEpisode),
    [],
  );
  assert.equal(candidates.list().length, 0);
});
