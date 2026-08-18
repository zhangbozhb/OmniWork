import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import type {
  AgentSurfaceEventPayload,
  ExperienceShadowStats,
} from "@omni-work/protocol-ts";
import { AgentObservationStore } from "../src/learning/agentObservationStore.ts";
import { DeliveryEpisodeStore } from "../src/learning/deliveryEpisodeStore.ts";
import { ExperienceCandidateStore } from "../src/learning/experienceCandidateStore.ts";
import {
  EXPERIENCE_MAX_INJECTED_BYTES,
  EXPERIENCE_MAX_ACTIVE_MATCHES,
  ExperienceActivationStore,
  formatExperienceInjection,
} from "../src/learning/experienceActivationStore.ts";
import { ExperienceShadowStore } from "../src/learning/experienceShadowStore.ts";

async function fixture(activationReady: boolean): Promise<{
  path: string;
  candidates: ExperienceCandidateStore;
  activation: ExperienceActivationStore;
  run: ReturnType<ExperienceShadowStore["evaluate"]>["run"];
  setReady(value: boolean): void;
}> {
  const directory = await mkdtemp(join(tmpdir(), "omniwork-activation-"));
  const path = join(directory, "sessions.sqlite");
  const observations = new AgentObservationStore(path);
  const episodes = new DeliveryEpisodeStore(path);
  const candidates = new ExperienceCandidateStore(path);
  const shadow = new ExperienceShadowStore(path, candidates);
  const promptEvent: AgentSurfaceEventPayload = {
    session_id: "session-1",
    surface_id: "surface-1",
    provider: "user",
    event_id: "prompt-1",
    event_type: "agent.user_prompt_submitted",
    title: "User prompt submitted",
    payload: { prompt: "Implement authentication retry handling" },
    source: { kind: "process", raw_event_id: "prompt-1" },
    created_at: "2026-08-15T00:00:00.000Z",
  };
  const episode = episodes.apply(
    observations.putSurfaceEvent(promptEvent, "/tmp/project"),
  );
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
        'candidate-1',
        'fingerprint-1',
        ?,
        'user_correction',
        'Implement authentication retry handling',
        'Add focused retry exhaustion tests',
        'approved',
        2,
        0,
        '2026-08-15T00:00:00.000Z',
        '2026-08-15T00:00:00.000Z'
      )
    `,
  ).run(episode.projectId);
  const run = shadow.evaluate({
    episodeId: episode.episodeId,
    projectId: episode.projectId,
    sessionId: episode.sessionId,
    surfaceId: episode.surfaceId,
    prompt: episode.objective as string,
    createdAt: episode.startedAt,
  }).run;
  let ready = activationReady;
  const statsReader = {
    stats(): ExperienceShadowStats {
      return {
        total_matches: 10,
        reviewed_matches: ready ? 10 : 9,
        relevant_matches: ready ? 7 : 9,
        not_relevant_matches: ready ? 3 : 0,
        relevance_rate: ready ? 0.7 : 1,
        activation_ready: ready,
      };
    },
  };
  return {
    path,
    candidates,
    run,
    activation: new ExperienceActivationStore(
      path,
      statsReader,
      candidates,
    ),
    setReady(value) {
      ready = value;
    },
  };
}

test("ExperienceActivationStore rejects enablement before the Shadow gate", async () => {
  const data = await fixture(false);
  const enable = {
    kind: "activation_set" as const,
    project_id: data.run.project_id,
    client_action_id: "activation-1",
    enabled: true,
    created_at: "2026-08-15T00:01:00.000Z",
  };

  assert.equal(data.activation.setActivation(enable).result, "gate_not_ready");
  const disabled = data.activation.setActivation({
    ...enable,
    client_action_id: "activation-disable",
    enabled: false,
  });
  assert.equal(disabled.result, "applied");
  assert.equal(
    disabled.result === "applied" &&
      disabled.activation.effective_enabled,
    false,
  );
});

test("ExperienceActivationStore injects bounded reviewed guidance and audits it", async () => {
  const data = await fixture(true);
  const defaultPrepared = data.activation.prepareApplication({
    run: data.run,
    prompt: "Original before opt-in",
    createdAt: "2026-08-15T00:00:30.000Z",
  });
  assert.equal(defaultPrepared.prompt, "Original before opt-in");
  assert.equal(defaultPrepared.application, undefined);
  const input = {
    kind: "activation_set" as const,
    project_id: data.run.project_id,
    client_action_id: "activation-1",
    enabled: true,
    created_at: "2026-08-15T00:01:00.000Z",
  };
  const enabled = data.activation.setActivation(input);
  assert.equal(enabled.result, "applied");
  assert.equal(data.activation.setActivation(input).result, "duplicate");
  assert.equal(
    enabled.result === "applied" && enabled.activation.effective_enabled,
    true,
  );

  const prepared = data.activation.prepareApplication({
    run: data.run,
    prompt: "Implement authentication retry handling",
    createdAt: "2026-08-15T00:02:00.000Z",
  });

  assert.match(prepared.prompt, /<project_experience/u);
  assert.match(prepared.prompt, /Add focused retry exhaustion tests/u);
  assert.match(
    prepared.prompt,
    /Implement authentication retry handling$/u,
  );
  assert.ok(prepared.application);
  assert.equal(prepared.application?.candidate_ids.length, 1);
  assert.ok(
    (prepared.application?.injected_bytes ?? Infinity) <=
      EXPERIENCE_MAX_INJECTED_BYTES,
  );
  assert.equal(data.candidates.get("candidate-1")?.status, "active");
  assert.equal(
    data.activation.listApplications({ sessionId: "session-1" }).length,
    1,
  );

  const db = new DatabaseSync(data.path);
  const hashes = db
    .prepare(
      `
        SELECT original_prompt_hash, injected_prompt_hash
        FROM experience_applications
      `,
    )
    .get() as {
    original_prompt_hash: string;
    injected_prompt_hash: string;
  };
  assert.equal(hashes.original_prompt_hash.length, 64);
  assert.equal(hashes.injected_prompt_hash.length, 64);
  assert.notEqual(hashes.original_prompt_hash, hashes.injected_prompt_hash);
  const rejected = data.candidates.setReview({
    kind: "review_set",
    candidate_id: "candidate-1",
    project_id: data.run.project_id,
    client_action_id: "review-active-reject",
    decision: "rejected",
    created_at: "2026-08-15T00:02:30.000Z",
  });
  assert.equal(rejected.result, "applied");
  assert.equal(data.candidates.get("candidate-1")?.status, "rejected");

  const disabled = data.activation.setActivation({
    ...input,
    client_action_id: "activation-disable",
    enabled: false,
    created_at: "2026-08-15T00:03:00.000Z",
  });
  assert.equal(disabled.result, "applied");
  assert.equal(
    disabled.result === "applied" &&
      disabled.activation.effective_enabled,
    false,
  );
});

test("ExperienceActivationStore stops injection when the live gate drops", async () => {
  const data = await fixture(true);
  data.activation.setActivation({
    kind: "activation_set",
    project_id: data.run.project_id,
    client_action_id: "activation-1",
    enabled: true,
    created_at: "2026-08-15T00:01:00.000Z",
  });
  data.setReady(false);

  const prepared = data.activation.prepareApplication({
    run: data.run,
    prompt: "Original prompt",
    createdAt: "2026-08-15T00:02:00.000Z",
  });

  assert.equal(data.activation.get(data.run.project_id).requested_enabled, true);
  assert.equal(data.activation.get(data.run.project_id).effective_enabled, false);
  assert.equal(prepared.prompt, "Original prompt");
  assert.equal(prepared.application, undefined);
});

test("formatExperienceInjection escapes content and enforces count and byte budgets", () => {
  const injection = formatExperienceInjection([
    { trigger: "Use <auth>", guidance: "Check A & B" },
    { trigger: "Second", guidance: "Second guidance" },
    { trigger: "Third", guidance: "Must not be included" },
  ]);
  assert.ok(injection);
  assert.match(injection, /Use &lt;auth&gt;/u);
  assert.match(injection, /Check A &amp; B/u);
  assert.doesNotMatch(injection, /Third/u);
  assert.equal(EXPERIENCE_MAX_ACTIVE_MATCHES, 2);
  assert.equal(
    formatExperienceInjection([
      { trigger: "Oversized", guidance: "x".repeat(10_000) },
    ]),
    undefined,
  );
});
