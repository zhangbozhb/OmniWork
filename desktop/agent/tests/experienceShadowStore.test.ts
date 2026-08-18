import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type {
  AgentSurfaceEventPayload,
  ExperienceCandidateSummary,
} from "@omni-work/protocol-ts";
import { AgentObservationStore } from "../src/learning/agentObservationStore.ts";
import {
  DeliveryEpisodeStore,
  type DeliveryEpisode,
} from "../src/learning/deliveryEpisodeStore.ts";
import { ExperienceCandidateStore } from "../src/learning/experienceCandidateStore.ts";
import {
  ExperienceShadowStore,
  isShadowActivationReady,
  retrieveShadowMatches,
} from "../src/learning/experienceShadowStore.ts";

async function fixture(): Promise<{
  path: string;
  observations: AgentObservationStore;
  episodes: DeliveryEpisodeStore;
  candidates: ExperienceCandidateStore;
  shadow: ExperienceShadowStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "omniwork-shadow-"));
  const path = join(directory, "sessions.sqlite");
  const observations = new AgentObservationStore(path);
  const episodes = new DeliveryEpisodeStore(path);
  const candidates = new ExperienceCandidateStore(path);
  return {
    path,
    observations,
    episodes,
    candidates,
    shadow: new ExperienceShadowStore(path, candidates),
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

function createApprovedCandidate(input: {
  observations: AgentObservationStore;
  episodes: DeliveryEpisodeStore;
  candidates: ExperienceCandidateStore;
  suffix: string;
  workspace: string;
  trigger: string;
  guidance: string;
}): ExperienceCandidateSummary {
  const started = input.episodes.apply(
    input.observations.putSurfaceEvent(
      event({
        id: `prompt-${input.suffix}`,
        eventType: "agent.user_prompt_submitted",
        provider: "user",
        rawEventId: `prompt-${input.suffix}`,
        prompt: input.trigger,
        createdAt: `2026-08-15T00:00:0${input.suffix}.000Z`,
      }),
      input.workspace,
    ),
  );
  input.episodes.apply(
    input.observations.putSurfaceEvent(
      event({
        id: `turn-${input.suffix}`,
        eventType: "agent.completed",
        provider: "codex",
        rawEventId: `turn:${input.suffix}:completed`,
        createdAt: `2026-08-15T00:00:1${input.suffix}.000Z`,
      }),
      input.workspace,
    ),
  );
  input.episodes.setOutcome({
    kind: "outcome_set",
    episode_id: started?.episodeId ?? "",
    session_id: "session-1",
    surface_id: "surface-1",
    client_action_id: `outcome-${input.suffix}`,
    outcome: "revision_requested",
    note: input.guidance,
    created_at: "2026-08-15T00:01:00.000Z",
  });
  const episode = input.episodes.get(
    started?.episodeId ?? "",
  ) as DeliveryEpisode;
  const changes = input.candidates.reconcileEpisode(episode);
  const candidate =
    changes[0]?.kind === "updated" ? changes[0].candidate : undefined;
  assert.ok(candidate);
  const reviewed = input.candidates.setReview({
    kind: "review_set",
    candidate_id: candidate.candidate_id,
    project_id: candidate.project_id,
    client_action_id: `review-${input.suffix}`,
    decision: "approved",
    created_at: "2026-08-15T00:02:00.000Z",
  });
  assert.ok(
    reviewed.result === "applied" || reviewed.result === "duplicate",
  );
  return reviewed.candidate;
}

function startQueryEpisode(input: {
  observations: AgentObservationStore;
  episodes: DeliveryEpisodeStore;
  suffix: string;
  workspace: string;
  prompt: string;
}): DeliveryEpisode {
  return input.episodes.apply(
    input.observations.putSurfaceEvent(
      event({
        id: `query-${input.suffix}`,
        eventType: "agent.user_prompt_submitted",
        provider: "user",
        rawEventId: `query-${input.suffix}`,
        prompt: input.prompt,
        createdAt: "2026-08-15T00:03:00.000Z",
      }),
      input.workspace,
    ),
  ) as DeliveryEpisode;
}

test("ExperienceShadowStore matches approved candidates within one project", async () => {
  const data = await fixture();
  const candidate = createApprovedCandidate({
    ...data,
    suffix: "1",
    workspace: "/tmp/project",
    trigger: "Implement authentication retry handling",
    guidance: "Add tests for retry exhaustion",
  });
  createApprovedCandidate({
    ...data,
    suffix: "2",
    workspace: "/tmp/other-project",
    trigger: "Implement authentication retry handling",
    guidance: "Use the other project rule",
  });

  const query = startQueryEpisode({
    ...data,
    suffix: "match",
    workspace: "/tmp/project",
    prompt: "Implement authentication retry handling for the API",
  });
  const evaluation = data.shadow.evaluate({
    episodeId: query.episodeId,
    projectId: query.projectId as string,
    sessionId: query.sessionId,
    surfaceId: query.surfaceId,
    prompt: query.objective as string,
    createdAt: query.startedAt,
  });

  assert.equal(evaluation.run.matches.length, 1);
  assert.equal(
    evaluation.run.matches[0]?.candidate_id,
    candidate.candidate_id,
  );
  assert.equal(evaluation.run.matches[0]?.reason, "exact_trigger");
  assert.equal(data.candidates.get(candidate.candidate_id)?.status, "shadow");
  assert.equal(evaluation.updatedCandidates[0]?.status, "shadow");

  const db = new DatabaseSync(data.path);
  const stored = db
    .prepare(
      "SELECT prompt_hash FROM experience_shadow_runs WHERE run_id = ?",
    )
    .get(evaluation.run.run_id) as { prompt_hash: string };
  assert.equal(stored.prompt_hash.length, 64);
  assert.notEqual(
    stored.prompt_hash,
    "Implement authentication retry handling for the API",
  );

  const rejected = data.candidates.setReview({
    kind: "review_set",
    candidate_id: candidate.candidate_id,
    project_id: candidate.project_id,
    client_action_id: "review-reject-shadow",
    decision: "rejected",
    created_at: "2026-08-15T00:04:00.000Z",
  });
  assert.equal(rejected.result, "applied");
  const nextQuery = startQueryEpisode({
    ...data,
    suffix: "after-reject",
    workspace: "/tmp/project",
    prompt: "Implement authentication retry handling",
  });
  assert.equal(
    data.shadow.evaluate({
      episodeId: nextQuery.episodeId,
      projectId: nextQuery.projectId as string,
      sessionId: nextQuery.sessionId,
      surfaceId: nextQuery.surfaceId,
      prompt: nextQuery.objective as string,
      createdAt: nextQuery.startedAt,
    }).run.matches.length,
    0,
  );
});

test("ExperienceShadowStore records idempotent feedback and scoped stats", async () => {
  const data = await fixture();
  const candidate = createApprovedCandidate({
    ...data,
    suffix: "1",
    workspace: "/tmp/project",
    trigger: "Fix authentication retry handling",
    guidance: "Add retry tests",
  });
  const query = startQueryEpisode({
    ...data,
    suffix: "feedback",
    workspace: "/tmp/project",
    prompt: "Fix authentication retry handling",
  });
  const evaluation = data.shadow.evaluate({
    episodeId: query.episodeId,
    projectId: query.projectId as string,
    sessionId: query.sessionId,
    surfaceId: query.surfaceId,
    prompt: query.objective as string,
    createdAt: query.startedAt,
  });
  const input = {
    kind: "shadow_feedback_set" as const,
    run_id: evaluation.run.run_id,
    candidate_id: candidate.candidate_id,
    client_action_id: "feedback-1",
    feedback: "relevant" as const,
    created_at: "2026-08-15T00:04:00.000Z",
  };

  assert.equal(data.shadow.setFeedback(input).result, "applied");
  assert.equal(data.shadow.setFeedback(input).result, "duplicate");
  assert.equal(
    data.shadow.setFeedback({ ...input, feedback: "not_relevant" }).result,
    "conflict",
  );
  assert.deepEqual(data.shadow.stats({ sessionId: query.sessionId }), {
    total_matches: 1,
    reviewed_matches: 1,
    relevant_matches: 1,
    not_relevant_matches: 0,
    relevance_rate: 1,
    activation_ready: false,
  });
  assert.equal(
    data.shadow.get(evaluation.run.run_id)?.matches[0]?.feedback,
    "relevant",
  );
});

test("ExperienceShadowStore suppresses candidates without positive evidence balance", async () => {
  const data = await fixture();
  const candidate = createApprovedCandidate({
    ...data,
    suffix: "1",
    workspace: "/tmp/project",
    trigger: "Fix authentication retry handling",
    guidance: "Add retry tests",
  });
  const db = new DatabaseSync(data.path);
  db.prepare(
    `
      UPDATE experience_candidates
      SET contradiction_count = support_count
      WHERE candidate_id = ?
    `,
  ).run(candidate.candidate_id);
  const query = startQueryEpisode({
    ...data,
    suffix: "conflict",
    workspace: "/tmp/project",
    prompt: "Fix authentication retry handling",
  });

  const evaluation = data.shadow.evaluate({
    episodeId: query.episodeId,
    projectId: query.projectId as string,
    sessionId: query.sessionId,
    surfaceId: query.surfaceId,
    prompt: query.objective as string,
    createdAt: query.startedAt,
  });

  assert.deepEqual(evaluation.run.matches, []);
  assert.equal(data.candidates.get(candidate.candidate_id)?.status, "approved");
});

test("retrieveShadowMatches supports CJK overlap and rejects weak matches", () => {
  const candidate: ExperienceCandidateSummary = {
    candidate_id: "candidate-1",
    project_id: "project-1",
    kind: "user_correction",
    trigger: "修复登录重试流程",
    guidance: "补充重试耗尽测试",
    status: "approved",
    support_count: 2,
    contradiction_count: 0,
    supporting_episode_ids: ["episode-1"],
    contradicting_episode_ids: [],
    created_at: "2026-08-15T00:00:00.000Z",
    updated_at: "2026-08-15T00:00:00.000Z",
  };

  assert.equal(
    retrieveShadowMatches("请修复登录重试的异常处理", [candidate]).length,
    1,
  );
  assert.equal(
    retrieveShadowMatches("调整文件列表排序", [candidate]).length,
    0,
  );
});

test("Shadow activation requires enough reviewed matches and 70 percent relevance", () => {
  assert.equal(isShadowActivationReady(9, 9), false);
  assert.equal(isShadowActivationReady(10, 6), false);
  assert.equal(isShadowActivationReady(10, 7), true);
});
