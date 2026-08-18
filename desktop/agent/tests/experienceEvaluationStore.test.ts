import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type {
  AgentSurfaceEventPayload,
  DeliveryOutcome,
} from "@omni-work/protocol-ts";
import { AgentObservationStore } from "../src/learning/agentObservationStore.ts";
import {
  DeliveryEpisodeStore,
  type DeliveryEpisode,
} from "../src/learning/deliveryEpisodeStore.ts";
import { ExperienceActivationStore } from "../src/learning/experienceActivationStore.ts";
import { ExperienceCandidateStore } from "../src/learning/experienceCandidateStore.ts";
import { ExperienceEvaluationStore } from "../src/learning/experienceEvaluationStore.ts";
import { ExperienceShadowStore } from "../src/learning/experienceShadowStore.ts";

async function fixture(): Promise<{
  path: string;
  observations: AgentObservationStore;
  episodes: DeliveryEpisodeStore;
  candidates: ExperienceCandidateStore;
  evaluations: ExperienceEvaluationStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "omniwork-evaluation-"));
  const path = join(directory, "sessions.sqlite");
  const observations = new AgentObservationStore(path);
  const episodes = new DeliveryEpisodeStore(path);
  const candidates = new ExperienceCandidateStore(path);
  const shadow = new ExperienceShadowStore(path, candidates);
  new ExperienceActivationStore(path, shadow, candidates);
  return {
    path,
    observations,
    episodes,
    candidates,
    evaluations: new ExperienceEvaluationStore(path, candidates),
  };
}

function createEpisode(input: {
  observations: AgentObservationStore;
  episodes: DeliveryEpisodeStore;
  suffix: string;
  outcome: DeliveryOutcome;
}): DeliveryEpisode {
  const event = (
    id: string,
    eventType: AgentSurfaceEventPayload["event_type"],
    provider: string,
    rawEventId: string,
    prompt?: string,
  ): AgentSurfaceEventPayload => ({
    session_id: "session-1",
    surface_id: "surface-1",
    provider,
    event_id: id,
    event_type: eventType,
    title:
      eventType === "agent.completed"
        ? "Codex turn completed"
        : "User prompt submitted",
    payload: prompt ? { prompt } : undefined,
    source: { kind: "process", raw_event_id: rawEventId },
    created_at: `2026-08-15T00:00:${input.suffix}.000Z`,
  });
  const started = input.episodes.apply(
    input.observations.putSurfaceEvent(
      event(
        `prompt-${input.suffix}`,
        "agent.user_prompt_submitted",
        "user",
        `prompt-${input.suffix}`,
        "Implement authentication retry handling",
      ),
      "/tmp/project",
    ),
  );
  input.episodes.apply(
    input.observations.putSurfaceEvent(
      event(
        `turn-${input.suffix}`,
        "agent.completed",
        "codex",
        `turn:${input.suffix}:completed`,
      ),
      "/tmp/project",
    ),
  );
  const result = input.episodes.setOutcome({
    kind: "outcome_set",
    episode_id: started?.episodeId ?? "",
    session_id: "session-1",
    surface_id: "surface-1",
    client_action_id: `outcome-${input.suffix}`,
    outcome: input.outcome,
    created_at: `2026-08-15T00:01:${input.suffix}.000Z`,
  });
  assert.equal(result.result, "applied");
  return input.episodes.get(started?.episodeId ?? "") as DeliveryEpisode;
}

function seedCandidateAndApplication(input: {
  path: string;
  sourceEpisode: DeliveryEpisode;
  applicationEpisodes: DeliveryEpisode[];
}): void {
  const db = new DatabaseSync(input.path);
  db.prepare(
    `
      INSERT INTO experience_candidates (
        candidate_id,
        fingerprint,
        project_id,
        kind,
        trigger_text,
        guidance_text,
        status,
        support_count,
        contradiction_count,
        created_at,
        updated_at
      )
      VALUES (
        'candidate-1',
        'fingerprint-1',
        ?,
        'user_correction',
        'Implement authentication retry handling',
        'Add focused retry tests',
        'active',
        1,
        0,
        '2026-08-15T00:00:00.000Z',
        '2026-08-15T00:00:00.000Z'
      )
    `,
  ).run(input.sourceEpisode.projectId as string);
  db.prepare(
    `
      INSERT INTO experience_candidate_evidence (
        candidate_id,
        episode_id,
        relation,
        source_kind,
        created_at
      )
      VALUES (
        'candidate-1',
        ?,
        'supporting',
        'explicit_user_correction',
        '2026-08-15T00:00:00.000Z'
      )
    `,
  ).run(input.sourceEpisode.episodeId);
  const insertRun = db.prepare(
    `
      INSERT INTO experience_shadow_runs (
        run_id,
        episode_id,
        project_id,
        session_id,
        surface_id,
        prompt_hash,
        created_at
      )
      VALUES (?, ?, ?, 'session-1', 'surface-1', ?, ?)
    `,
  );
  const insertApplication = db.prepare(
    `
      INSERT INTO experience_applications (
        application_id,
        run_id,
        episode_id,
        project_id,
        candidate_ids,
        original_prompt_hash,
        injected_prompt_hash,
        injected_bytes,
        created_at
      )
      VALUES (?, ?, ?, ?, '["candidate-1"]', ?, ?, 256, ?)
    `,
  );
  for (const [index, episode] of input.applicationEpisodes.entries()) {
    const id = index + 1;
    insertRun.run(
      `run-${id}`,
      episode.episodeId,
      episode.projectId as string,
      `hash-${id}`,
      episode.startedAt,
    );
    insertApplication.run(
      `application-${id}`,
      `run-${id}`,
      episode.episodeId,
      episode.projectId as string,
      `original-${id}`,
      `injected-${id}`,
      episode.startedAt,
    );
  }
}

test("ExperienceEvaluationStore pauses then deprecates repeatedly contradicted active experience", async () => {
  const data = await fixture();
  const baseline = createEpisode({
    ...data,
    suffix: "01",
    outcome: "accepted",
  });
  const first = createEpisode({
    ...data,
    suffix: "02",
    outcome: "revision_requested",
  });
  const second = createEpisode({
    ...data,
    suffix: "03",
    outcome: "revision_requested",
  });
  seedCandidateAndApplication({
    path: data.path,
    sourceEpisode: baseline,
    applicationEpisodes: [first, second],
  });

  const firstResult = data.evaluations.evaluateEpisode({
    episodeId: first.episodeId,
    outcome: "revision_requested",
    outcomeAt: first.outcomeAt as string,
    sourceActionId: "evaluate-1",
  });
  assert.equal(firstResult?.evaluation.effect, "negative");
  assert.equal(data.candidates.get("candidate-1")?.status, "paused");
  assert.equal(data.candidates.get("candidate-1")?.contradiction_count, 1);
  assert.equal(
    data.candidates.setLifecycle({
      kind: "lifecycle_set",
      candidate_id: "candidate-1",
      project_id: first.projectId as string,
      client_action_id: "resume-without-balance",
      action: "resume",
      created_at: "2026-08-15T00:02:30.000Z",
    }).result,
    "invalid_state",
  );

  const secondResult = data.evaluations.evaluateEpisode({
    episodeId: second.episodeId,
    outcome: "revision_requested",
    outcomeAt: second.outcomeAt as string,
    sourceActionId: "evaluate-2",
  });
  assert.equal(secondResult?.evaluation.effect, "negative");
  assert.equal(data.candidates.get("candidate-1")?.status, "deprecated");
  assert.equal(data.candidates.get("candidate-1")?.contradiction_count, 2);
  assert.deepEqual(secondResult?.effect, {
    project_id: baseline.projectId,
    assisted_evaluated: 2,
    assisted_accepted: 0,
    assisted_revision_requested: 2,
    assisted_abandoned: 0,
    assisted_acceptance_rate: 0,
    baseline_evaluated: 1,
    baseline_accepted: 1,
    baseline_acceptance_rate: 1,
    acceptance_rate_delta: -1,
  });
});

test("ExperienceEvaluationStore records positive effects without auto-resuming paused candidates", async () => {
  const data = await fixture();
  const baseline = createEpisode({
    ...data,
    suffix: "01",
    outcome: "revision_requested",
  });
  const assisted = createEpisode({
    ...data,
    suffix: "02",
    outcome: "accepted",
  });
  seedCandidateAndApplication({
    path: data.path,
    sourceEpisode: baseline,
    applicationEpisodes: [assisted],
  });
  data.candidates.setLifecycle({
    kind: "lifecycle_set",
    candidate_id: "candidate-1",
    project_id: assisted.projectId as string,
    client_action_id: "pause-1",
    action: "pause",
    created_at: "2026-08-15T00:02:00.000Z",
  });

  const result = data.evaluations.evaluateEpisode({
    episodeId: assisted.episodeId,
    outcome: "accepted",
    outcomeAt: assisted.outcomeAt as string,
    sourceActionId: "evaluate-positive",
  });

  assert.equal(result?.evaluation.effect, "positive");
  assert.equal(data.candidates.get("candidate-1")?.status, "paused");
  assert.equal(data.candidates.get("candidate-1")?.support_count, 2);
  assert.equal(result?.effect.assisted_acceptance_rate, 1);
  assert.equal(result?.effect.baseline_acceptance_rate, 0);
  assert.equal(result?.effect.acceptance_rate_delta, 1);
  assert.equal(data.evaluations.backfill().length, 1);
  assert.equal(data.evaluations.list({ sessionId: "session-1" }).length, 1);
});
