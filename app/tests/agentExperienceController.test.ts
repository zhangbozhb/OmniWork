import { strict as assert } from "node:assert";
import { test } from "node:test";

import type {
  ExperienceCandidateSummary,
  ExperienceActivationSummary,
  ExperienceApplicationSummary,
  ExperienceApplicationEvaluationSummary,
  ExperienceProjectEffectSummary,
  ExperiencePromotionEligibilitySummary,
  ExperienceShadowRunSummary,
} from "@omni-work/protocol-ts";
import {
  agentExperienceReviewSet,
  agentExperienceActivationSet,
  agentExperienceLifecycleSet,
  agentExperienceShadowFeedbackSet,
  agentExperienceSyncRequest,
} from "../src/features/agent/agentMessages.ts";
import {
  mergeExperienceCandidates,
  mergeExperienceActivations,
  mergeExperienceApplications,
  mergeExperienceEvaluations,
  mergeExperienceEffects,
  mergeExperiencePromotions,
  mergeShadowRuns,
} from "../src/features/agent/useAgentExperienceController.ts";

function candidate(
  status: ExperienceCandidateSummary["status"] = "candidate",
): ExperienceCandidateSummary {
  return {
    candidate_id: "candidate-1",
    project_id: "project-1",
    kind: "user_correction",
    trigger: "When implementing the feature",
    guidance: "Add focused tests",
    status,
    support_count: 1,
    contradiction_count: 0,
    supporting_episode_ids: ["episode-1"],
    contradicting_episode_ids: [],
    created_at: "2026-08-15T00:00:00.000Z",
    updated_at: "2026-08-15T00:01:00.000Z",
  };
}

function activation(
  enabled = false,
): ExperienceActivationSummary {
  return {
    project_id: "project-1",
    requested_enabled: enabled,
    effective_enabled: enabled,
    activation_ready: true,
    reviewed_matches: 10,
    relevance_rate: 0.8,
    max_matches: 2,
    max_injected_bytes: 4096,
  };
}

function application(): ExperienceApplicationSummary {
  return {
    application_id: "application-1",
    run_id: "run-1",
    episode_id: "episode-2",
    project_id: "project-1",
    candidate_ids: ["candidate-1"],
    injected_bytes: 512,
    created_at: "2026-08-15T00:03:00.000Z",
  };
}

function evaluation(
  effect: "positive" | "negative" = "positive",
): ExperienceApplicationEvaluationSummary {
  return {
    evaluation_id: "evaluation-1",
    application_id: "application-1",
    episode_id: "episode-2",
    project_id: "project-1",
    candidate_ids: ["candidate-1"],
    outcome: effect === "positive" ? "accepted" : "revision_requested",
    effect,
    evaluated_at: "2026-08-15T00:04:00.000Z",
  };
}

function projectEffect(
  assistedAccepted: number,
): ExperienceProjectEffectSummary {
  return {
    project_id: "project-1",
    assisted_evaluated: 1,
    assisted_accepted: assistedAccepted,
    assisted_revision_requested: assistedAccepted ? 0 : 1,
    assisted_abandoned: 0,
    assisted_acceptance_rate: assistedAccepted,
    baseline_evaluated: 1,
    baseline_accepted: 0,
    baseline_acceptance_rate: 0,
    acceptance_rate_delta: assistedAccepted,
  };
}

function promotion(
  eligible: boolean,
): ExperiencePromotionEligibilitySummary {
  return {
    promotion_key: "promotion-1",
    candidate_ids: ["candidate-1", "candidate-2"],
    project_ids: ["project-1", "project-2"],
    project_count: 2,
    support_count: 3,
    contradiction_count: eligible ? 0 : 1,
    eligible,
  };
}

function shadowRun(
  feedback?: "relevant" | "not_relevant",
): ExperienceShadowRunSummary {
  return {
    run_id: "run-1",
    episode_id: "episode-2",
    project_id: "project-1",
    session_id: "session-1",
    surface_id: "surface-1",
    created_at: "2026-08-15T00:02:00.000Z",
    matches: [
      {
        candidate_id: "candidate-1",
        trigger: "When implementing the feature",
        guidance: "Add focused tests",
        rank: 1,
        score: 0.8,
        reason: "token_overlap",
        feedback,
      },
    ],
  };
}

test("mergeExperienceCandidates replaces reviewed candidates by id", () => {
  const merged = mergeExperienceCandidates(
    [candidate()],
    [candidate("approved")],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.status, "approved");
});

test("experience message helpers bind sync and review payloads", () => {
  const sync = agentExperienceSyncRequest("device-1", "session-1");
  const review = agentExperienceReviewSet(
    "device-1",
    candidate(),
    "approved",
    "  When coding  ",
    "  Add tests  ",
    "  Reviewed  ",
  );

  assert.equal(sync.type, "agent.experience");
  assert.equal(sync.session_id, "session-1");
  assert.equal(
    (review.payload as { decision?: string }).decision,
    "approved",
  );
  assert.equal(
    (review.payload as { trigger?: string }).trigger,
    "When coding",
  );
  assert.equal(
    (review.payload as { guidance?: string }).guidance,
    "Add tests",
  );
  assert.equal(
    (review.payload as { note?: string }).note,
    "Reviewed",
  );
  const feedback = agentExperienceShadowFeedbackSet(
    "device-1",
    "run-1",
    "candidate-1",
    "relevant",
  );
  assert.equal(
    (feedback.payload as { kind?: string }).kind,
    "shadow_feedback_set",
  );
  assert.equal(
    (feedback.payload as { feedback?: string }).feedback,
    "relevant",
  );
  const activationMessage = agentExperienceActivationSet(
    "device-1",
    "project-1",
    true,
  );
  assert.equal(
    (activationMessage.payload as { kind?: string }).kind,
    "activation_set",
  );
  assert.equal(
    (activationMessage.payload as { enabled?: boolean }).enabled,
    true,
  );
  const lifecycle = agentExperienceLifecycleSet(
    "device-1",
    candidate("active"),
    "pause",
    "Check next delivery",
  );
  assert.equal(
    (lifecycle.payload as { action?: string }).action,
    "pause",
  );
});

test("mergeShadowRuns replaces feedback revisions by run id", () => {
  const merged = mergeShadowRuns(
    [shadowRun()],
    [shadowRun("relevant")],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.matches[0]?.feedback, "relevant");
});

test("experience activation and application merges replace records by stable ids", () => {
  const activations = mergeExperienceActivations(
    [activation(false)],
    [activation(true)],
  );
  const applications = mergeExperienceApplications(
    [application()],
    [{ ...application(), injected_bytes: 768 }],
  );

  assert.equal(activations.length, 1);
  assert.equal(activations[0]?.effective_enabled, true);
  assert.equal(applications.length, 1);
  assert.equal(applications[0]?.injected_bytes, 768);
});

test("experience evaluation and effect merges replace records by stable ids", () => {
  const evaluations = mergeExperienceEvaluations(
    [evaluation("negative")],
    [evaluation("positive")],
  );
  const effects = mergeExperienceEffects(
    [projectEffect(0)],
    [projectEffect(1)],
  );

  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0]?.effect, "positive");
  assert.equal(effects.length, 1);
  assert.equal(effects[0]?.acceptance_rate_delta, 1);
  const promotions = mergeExperiencePromotions(
    [promotion(false)],
    [promotion(true)],
  );
  assert.equal(promotions.length, 1);
  assert.equal(promotions[0]?.eligible, true);
});
