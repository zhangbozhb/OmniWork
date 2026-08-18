import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createMessage,
  type AgentExperiencePayload,
  type AgentSurfaceEventPayload,
  type MessageEnvelope,
} from "@omni-work/protocol-ts";
import { AgentExperienceHandler } from "../src/core/agentExperienceHandler.ts";
import { AgentObservationStore } from "../src/learning/agentObservationStore.ts";
import {
  DeliveryEpisodeStore,
  type DeliveryEpisode,
} from "../src/learning/deliveryEpisodeStore.ts";
import { ExperienceCandidateStore } from "../src/learning/experienceCandidateStore.ts";
import { ExperienceShadowStore } from "../src/learning/experienceShadowStore.ts";
import { ExperienceActivationStore } from "../src/learning/experienceActivationStore.ts";
import { ExperienceEvaluationStore } from "../src/learning/experienceEvaluationStore.ts";

async function fixture(): Promise<{
  candidateId: string;
  projectId: string;
  handler: AgentExperienceHandler;
  sent: MessageEnvelope[];
}> {
  const directory = await mkdtemp(join(tmpdir(), "omniwork-experience-handler-"));
  const path = join(directory, "sessions.sqlite");
  const observations = new AgentObservationStore(path);
  const episodes = new DeliveryEpisodeStore(path);
  const candidates = new ExperienceCandidateStore(path);
  const shadowStore = new ExperienceShadowStore(path, candidates);
  const activationStore = new ExperienceActivationStore(
    path,
    shadowStore,
    candidates,
  );
  const evaluationStore = new ExperienceEvaluationStore(path, candidates);
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
  const started = episodes.apply(
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
  episodes.setOutcome({
    kind: "outcome_set",
    episode_id: started?.episodeId ?? "",
    session_id: "session-1",
    surface_id: "surface-1",
    client_action_id: "outcome-1",
    outcome: "revision_requested",
    note: "Add tests",
    created_at: "2026-08-15T00:01:00.000Z",
  });
  const changes = candidates.reconcileEpisode(
    episodes.get(started?.episodeId ?? "") as DeliveryEpisode,
  );
  const candidate =
    changes[0]?.kind === "updated" ? changes[0].candidate : undefined;
  assert.ok(candidate);
  const sent: MessageEnvelope[] = [];
  return {
    candidateId: candidate.candidate_id,
    projectId: candidate.project_id,
    sent,
    handler: new AgentExperienceHandler({
      deviceId: "device-1",
      store: candidates,
      shadowStore,
      activationStore,
      evaluationStore,
      onExperienceChange: () => undefined,
      sendToApp: (_context, message) => sent.push(message),
    }),
  };
}

test("AgentExperienceHandler synchronizes and reviews candidates", async () => {
  const { candidateId, projectId, handler, sent } = await fixture();
  handler.handle(
    createMessage(
      "agent.experience",
      { kind: "sync_request", session_id: "session-1" },
      { device_id: "device-1" },
    ) as MessageEnvelope<AgentExperiencePayload>,
  );
  handler.handle(
    createMessage(
      "agent.experience",
      {
        kind: "review_set",
        candidate_id: candidateId,
        project_id: projectId,
        client_action_id: "review-1",
        decision: "approved",
        trigger: "When shipping",
        guidance: "Add focused tests",
        created_at: "2026-08-15T00:02:00.000Z",
      },
      { device_id: "device-1" },
    ) as MessageEnvelope<AgentExperiencePayload>,
  );

  assert.equal(
    (sent[0]?.payload as { candidates?: unknown[] }).candidates?.length,
    1,
  );
  assert.deepEqual(
    (sent[0]?.payload as { shadow_runs?: unknown[] }).shadow_runs,
    [],
  );
  assert.deepEqual(
    (sent[0]?.payload as { evaluations?: unknown[] }).evaluations,
    [],
  );
  assert.equal(
    (sent[0]?.payload as { effects?: unknown[] }).effects?.length,
    1,
  );
  assert.equal(
    (
      sent[0]?.payload as {
        shadow_stats?: { total_matches?: number };
      }
    ).shadow_stats?.total_matches,
    0,
  );
  assert.equal(
    (sent[0]?.payload as { activations?: unknown[] }).activations?.length,
    1,
  );
  assert.deepEqual(
    (sent[0]?.payload as { applications?: unknown[] }).applications,
    [],
  );
  assert.equal(
    (sent[1]?.payload as { candidate?: { status?: string } }).candidate
      ?.status,
    "approved",
  );
});

test("AgentExperienceHandler rejects activation before the Shadow gate", async () => {
  const { projectId, handler, sent } = await fixture();
  handler.handle(
    createMessage(
      "agent.experience",
      {
        kind: "activation_set",
        project_id: projectId,
        client_action_id: "activation-1",
        enabled: true,
        created_at: "2026-08-15T00:03:00.000Z",
      },
      { device_id: "device-1" },
    ) as MessageEnvelope<AgentExperiencePayload>,
  );

  assert.equal(
    (sent[0]?.payload as { code?: string }).code,
    "gate_not_ready",
  );
});

test("AgentExperienceHandler applies lifecycle actions after review", async () => {
  const { candidateId, projectId, handler, sent } = await fixture();
  handler.handle(
    createMessage(
      "agent.experience",
      {
        kind: "review_set",
        candidate_id: candidateId,
        project_id: projectId,
        client_action_id: "review-approve",
        decision: "approved",
        created_at: "2026-08-15T00:02:00.000Z",
      },
      { device_id: "device-1" },
    ) as MessageEnvelope<AgentExperiencePayload>,
  );
  handler.handle(
    createMessage(
      "agent.experience",
      {
        kind: "lifecycle_set",
        candidate_id: candidateId,
        project_id: projectId,
        client_action_id: "lifecycle-pause",
        action: "pause",
        created_at: "2026-08-15T00:03:00.000Z",
      },
      { device_id: "device-1" },
    ) as MessageEnvelope<AgentExperiencePayload>,
  );

  assert.equal(
    (sent[1]?.payload as { candidate?: { status?: string } }).candidate
      ?.status,
    "paused",
  );
});

test("AgentExperienceHandler rejects cross-project reviews", async () => {
  const { candidateId, handler, sent } = await fixture();
  handler.handle(
    createMessage(
      "agent.experience",
      {
        kind: "review_set",
        candidate_id: candidateId,
        project_id: "other-project",
        client_action_id: "review-1",
        decision: "approved",
        created_at: "2026-08-15T00:02:00.000Z",
      },
      { device_id: "device-1" },
    ) as MessageEnvelope<AgentExperiencePayload>,
  );

  assert.equal((sent[0]?.payload as { code?: string }).code, "not_found");
});
