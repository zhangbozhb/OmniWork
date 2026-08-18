import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  createMessage,
  type AgentDeliveryPayload,
  type AgentSurfaceEventPayload,
  type MessageEnvelope,
} from "@omni-work/protocol-ts";
import { AgentDeliveryHandler } from "../src/core/agentDeliveryHandler.ts";
import { AgentObservationStore } from "../src/learning/agentObservationStore.ts";
import { DeliveryEpisodeStore } from "../src/learning/deliveryEpisodeStore.ts";
import {
  ExperienceCandidateStore,
  type ExperienceCandidateChange,
} from "../src/learning/experienceCandidateStore.ts";
import { ExperienceShadowStore } from "../src/learning/experienceShadowStore.ts";
import { ExperienceActivationStore } from "../src/learning/experienceActivationStore.ts";
import {
  ExperienceEvaluationStore,
  type ExperienceEvaluationResult,
} from "../src/learning/experienceEvaluationStore.ts";

async function fixture(): Promise<{
  episodeId: string;
  path: string;
  episodes: DeliveryEpisodeStore;
  candidateStore: ExperienceCandidateStore;
  handler: AgentDeliveryHandler;
  sent: MessageEnvelope[];
  experienceChanges: ExperienceCandidateChange[];
  evaluations: ExperienceEvaluationResult[];
}> {
  const directory = await mkdtemp(join(tmpdir(), "omniwork-delivery-handler-"));
  const path = join(directory, "sessions.sqlite");
  const observations = new AgentObservationStore(path);
  const episodes = new DeliveryEpisodeStore(path);
  const candidateStore = new ExperienceCandidateStore(path);
  const shadowStore = new ExperienceShadowStore(path, candidateStore);
  new ExperienceActivationStore(path, shadowStore, candidateStore);
  const evaluationStore = new ExperienceEvaluationStore(
    path,
    candidateStore,
  );
  const event = (
    id: string,
    eventType: AgentSurfaceEventPayload["event_type"],
    provider: string,
    rawEventId: string,
    payload?: Record<string, unknown>,
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
    payload,
    source: { kind: "process", raw_event_id: rawEventId },
    created_at: "2026-08-15T00:00:00.000Z",
  });
  const episode = episodes.apply(
    observations.putSurfaceEvent(
      event(
        "prompt",
        "agent.user_prompt_submitted",
        "user",
        "prompt",
        { prompt: "Ship it" },
      ),
      "/tmp/project",
    ),
  );
  episodes.apply(
    observations.putSurfaceEvent(
      event(
        "completed",
        "agent.completed",
        "codex",
        "turn:1:completed",
      ),
      "/tmp/project",
    ),
  );
  const sent: MessageEnvelope[] = [];
  const experienceChanges: ExperienceCandidateChange[] = [];
  const evaluations: ExperienceEvaluationResult[] = [];
  return {
    episodeId: episode?.episodeId ?? "",
    path,
    episodes,
    candidateStore,
    sent,
    experienceChanges,
    evaluations,
    handler: new AgentDeliveryHandler({
      deviceId: "device-1",
      store: episodes,
      candidateStore,
      evaluationStore,
      onExperienceChange: (change) => experienceChanges.push(change),
      onEvaluation: (evaluation) => evaluations.push(evaluation),
      sendToApp: (_context, message) => sent.push(message),
    }),
  };
}

test("AgentDeliveryHandler synchronizes episodes and persists outcomes", async () => {
  const { episodeId, handler, sent } = await fixture();
  handler.handle(
    createMessage(
      "agent.delivery",
      {
        kind: "sync_request",
        session_id: "session-1",
        surface_id: "surface-1",
      },
      { device_id: "device-1" },
    ) as MessageEnvelope<AgentDeliveryPayload>,
  );
  handler.handle(
    createMessage(
      "agent.delivery",
      {
        kind: "outcome_set",
        episode_id: episodeId,
        session_id: "session-1",
        surface_id: "surface-1",
        client_action_id: "action-1",
        outcome: "accepted",
        created_at: "2026-08-15T00:01:00.000Z",
      },
      { device_id: "device-1" },
    ) as MessageEnvelope<AgentDeliveryPayload>,
  );

  assert.equal((sent[0]?.payload as { kind?: string }).kind, "sync_response");
  assert.equal(
    (sent[0]?.payload as { episodes?: unknown[] }).episodes?.length,
    1,
  );
  assert.equal(
    (sent[1]?.payload as { kind?: string }).kind,
    "outcome_result",
  );
  assert.equal(
    (
      sent[1]?.payload as {
        episode?: { outcome?: string; status?: string };
      }
    ).episode?.outcome,
    "accepted",
  );
  assert.equal(
    (
      sent[1]?.payload as {
        episode?: { outcome?: string; status?: string };
      }
    ).episode?.status,
    "delivered",
  );
});

test("AgentDeliveryHandler evaluates outcomes for applied experience", async () => {
  const {
    episodeId,
    path,
    episodes,
    candidateStore,
    handler,
    evaluations,
  } = await fixture();
  const episode = episodes.get(episodeId);
  assert.ok(episode?.projectId);
  const db = new DatabaseSync(path);
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
        'candidate-applied',
        'fingerprint-applied',
        ?,
        'user_correction',
        'Ship it',
        'Add tests',
        'active',
        1,
        0,
        '2026-08-15T00:00:00.000Z',
        '2026-08-15T00:00:00.000Z'
      )
    `,
  ).run(episode.projectId);
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
        'candidate-applied',
        ?,
        'supporting',
        'seed_support',
        '2026-08-15T00:00:00.000Z'
      )
    `,
  ).run(episodeId);
  db.prepare(
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
      VALUES (
        'run-applied',
        ?,
        ?,
        'session-1',
        'surface-1',
        'prompt-hash',
        '2026-08-15T00:00:00.000Z'
      )
    `,
  ).run(episodeId, episode.projectId);
  db.prepare(
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
      VALUES (
        'application-applied',
        'run-applied',
        ?,
        ?,
        '["candidate-applied"]',
        'original-hash',
        'injected-hash',
        256,
        '2026-08-15T00:00:00.000Z'
      )
    `,
  ).run(episodeId, episode.projectId);

  handler.handle(
    createMessage(
      "agent.delivery",
      {
        kind: "outcome_set",
        episode_id: episodeId,
        session_id: "session-1",
        surface_id: "surface-1",
        client_action_id: "outcome-applied",
        outcome: "revision_requested",
        note: "Still missing tests",
        created_at: "2026-08-15T00:02:00.000Z",
      },
      { device_id: "device-1" },
    ) as MessageEnvelope<AgentDeliveryPayload>,
  );

  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0]?.evaluation.effect, "negative");
  assert.equal(candidateStore.get("candidate-applied")?.status, "paused");
  assert.ok(
    evaluations[0]?.candidateChanges.some(
      (change) =>
        change.kind === "updated" &&
        change.candidate.candidate_id === "candidate-applied" &&
        change.candidate.status === "paused",
    ),
  );
});

test("AgentDeliveryHandler derives a candidate from revision feedback", async () => {
  const { episodeId, handler, experienceChanges } = await fixture();
  handler.handle(
    createMessage(
      "agent.delivery",
      {
        kind: "outcome_set",
        episode_id: episodeId,
        session_id: "session-1",
        surface_id: "surface-1",
        client_action_id: "action-revision",
        outcome: "revision_requested",
        note: "Add focused tests",
        created_at: "2026-08-15T00:01:00.000Z",
      },
      { device_id: "device-1" },
    ) as MessageEnvelope<AgentDeliveryPayload>,
  );

  assert.equal(experienceChanges.length, 1);
  assert.equal(experienceChanges[0]?.kind, "updated");
  if (experienceChanges[0]?.kind === "updated") {
    assert.equal(experienceChanges[0].candidate.trigger, "Ship it");
    assert.equal(
      experienceChanges[0].candidate.guidance,
      "Add focused tests",
    );
  }
});

test("AgentDeliveryHandler rejects outcomes outside the episode binding", async () => {
  const { episodeId, handler, sent } = await fixture();
  handler.handle(
    createMessage(
      "agent.delivery",
      {
        kind: "outcome_set",
        episode_id: episodeId,
        session_id: "other-session",
        surface_id: "surface-1",
        client_action_id: "action-1",
        outcome: "accepted",
        created_at: "2026-08-15T00:01:00.000Z",
      },
      { device_id: "device-1" },
    ) as MessageEnvelope<AgentDeliveryPayload>,
  );

  assert.equal((sent[0]?.payload as { kind?: string }).kind, "error");
  assert.equal((sent[0]?.payload as { code?: string }).code, "not_found");
});
