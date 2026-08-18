import { useState } from "react";
import type {
  AgentExperiencePayload,
  ExperienceCandidateSummary,
  ExperienceActivationSummary,
  ExperienceApplicationSummary,
  ExperienceApplicationEvaluationSummary,
  ExperienceProjectEffectSummary,
  ExperiencePromotionEligibilitySummary,
  ExperienceShadowRunSummary,
  ExperienceShadowStats,
} from "@omni-work/protocol-ts";

export function useAgentExperienceController() {
  const [experienceCandidates, setExperienceCandidates] = useState<
    ExperienceCandidateSummary[]
  >([]);
  const [experienceShadowRuns, setExperienceShadowRuns] = useState<
    ExperienceShadowRunSummary[]
  >([]);
  const [experienceShadowStatsBySessionId, setExperienceShadowStatsBySessionId] =
    useState<Record<string, ExperienceShadowStats>>({});
  const [experienceActivations, setExperienceActivations] = useState<
    ExperienceActivationSummary[]
  >([]);
  const [experienceApplications, setExperienceApplications] = useState<
    ExperienceApplicationSummary[]
  >([]);
  const [experienceEvaluations, setExperienceEvaluations] = useState<
    ExperienceApplicationEvaluationSummary[]
  >([]);
  const [experienceEffects, setExperienceEffects] = useState<
    ExperienceProjectEffectSummary[]
  >([]);
  const [experiencePromotions, setExperiencePromotions] = useState<
    ExperiencePromotionEligibilitySummary[]
  >([]);

  function applyAgentExperience(payload: AgentExperiencePayload): void {
    if (payload.kind === "sync_response") {
      setExperienceCandidates((current) =>
        mergeExperienceCandidates(current, payload.candidates),
      );
      setExperienceShadowRuns((current) =>
        mergeShadowRuns(current, payload.shadow_runs),
      );
      setExperienceActivations((current) =>
        mergeExperienceActivations(current, payload.activations),
      );
      setExperienceApplications((current) =>
        mergeExperienceApplications(current, payload.applications),
      );
      setExperienceEvaluations((current) =>
        mergeExperienceEvaluations(current, payload.evaluations),
      );
      setExperienceEffects((current) =>
        mergeExperienceEffects(current, payload.effects),
      );
      setExperiencePromotions((current) =>
        mergeExperiencePromotions(current, payload.promotions),
      );
      if (payload.session_id) {
        setExperienceShadowStatsBySessionId((current) => ({
          ...current,
          [payload.session_id as string]: payload.shadow_stats,
        }));
      }
      return;
    }
    if (
      payload.kind === "candidate_updated" ||
      payload.kind === "review_result" ||
      payload.kind === "lifecycle_result"
    ) {
      setExperienceCandidates((current) =>
        mergeExperienceCandidates(current, [payload.candidate]),
      );
      return;
    }
    if (payload.kind === "candidate_removed") {
      setExperienceCandidates((current) =>
        current.filter(
          (candidate) => candidate.candidate_id !== payload.candidate_id,
        ),
      );
      return;
    }
    if (payload.kind === "shadow_result") {
      setExperienceShadowRuns((current) =>
        mergeShadowRuns(current, [payload.run]),
      );
      return;
    }
    if (payload.kind === "shadow_feedback_result") {
      setExperienceShadowRuns((current) =>
        mergeShadowRuns(current, [payload.run]),
      );
      setExperienceShadowStatsBySessionId((current) => ({
        ...current,
        [payload.run.session_id]: payload.shadow_stats,
      }));
      setExperienceActivations((current) =>
        mergeExperienceActivations(current, [payload.activation]),
      );
      return;
    }
    if (payload.kind === "activation_result") {
      setExperienceActivations((current) =>
        mergeExperienceActivations(current, [payload.activation]),
      );
      return;
    }
    if (payload.kind === "application_recorded") {
      setExperienceApplications((current) =>
        mergeExperienceApplications(current, [payload.application]),
      );
      return;
    }
    if (payload.kind === "evaluation_recorded") {
      setExperienceEvaluations((current) =>
        mergeExperienceEvaluations(current, [payload.evaluation]),
      );
      setExperienceEffects((current) =>
        mergeExperienceEffects(current, [payload.effect]),
      );
    }
  }

  function clearAgentExperiences(): void {
    setExperienceCandidates([]);
    setExperienceShadowRuns([]);
    setExperienceShadowStatsBySessionId({});
    setExperienceActivations([]);
    setExperienceApplications([]);
    setExperienceEvaluations([]);
    setExperienceEffects([]);
    setExperiencePromotions([]);
  }

  return {
    experienceCandidates,
    experienceShadowRuns,
    experienceShadowStatsBySessionId,
    experienceActivations,
    experienceApplications,
    experienceEvaluations,
    experienceEffects,
    experiencePromotions,
    applyAgentExperience,
    clearAgentExperiences,
  };
}

export function mergeExperiencePromotions(
  current: readonly ExperiencePromotionEligibilitySummary[],
  incoming: readonly ExperiencePromotionEligibilitySummary[],
): ExperiencePromotionEligibilitySummary[] {
  const merged = new Map(
    current.map((promotion) => [
      promotion.promotion_key,
      promotion,
    ]),
  );
  for (const promotion of incoming) {
    merged.set(promotion.promotion_key, promotion);
  }
  return [...merged.values()].sort((left, right) =>
    left.promotion_key.localeCompare(right.promotion_key),
  );
}

export function mergeExperienceEvaluations(
  current: readonly ExperienceApplicationEvaluationSummary[],
  incoming: readonly ExperienceApplicationEvaluationSummary[],
): ExperienceApplicationEvaluationSummary[] {
  const merged = new Map(
    current.map((evaluation) => [evaluation.evaluation_id, evaluation]),
  );
  for (const evaluation of incoming) {
    merged.set(evaluation.evaluation_id, evaluation);
  }
  return [...merged.values()].sort(
    (left, right) =>
      Date.parse(left.evaluated_at) - Date.parse(right.evaluated_at),
  );
}

export function mergeExperienceEffects(
  current: readonly ExperienceProjectEffectSummary[],
  incoming: readonly ExperienceProjectEffectSummary[],
): ExperienceProjectEffectSummary[] {
  const merged = new Map(
    current.map((effect) => [effect.project_id, effect]),
  );
  for (const effect of incoming) {
    merged.set(effect.project_id, effect);
  }
  return [...merged.values()].sort((left, right) =>
    left.project_id.localeCompare(right.project_id),
  );
}

export function mergeExperienceActivations(
  current: readonly ExperienceActivationSummary[],
  incoming: readonly ExperienceActivationSummary[],
): ExperienceActivationSummary[] {
  const merged = new Map(
    current.map((activation) => [activation.project_id, activation]),
  );
  for (const activation of incoming) {
    merged.set(activation.project_id, activation);
  }
  return [...merged.values()].sort((left, right) =>
    left.project_id.localeCompare(right.project_id),
  );
}

export function mergeExperienceApplications(
  current: readonly ExperienceApplicationSummary[],
  incoming: readonly ExperienceApplicationSummary[],
): ExperienceApplicationSummary[] {
  const merged = new Map(
    current.map((application) => [
      application.application_id,
      application,
    ]),
  );
  for (const application of incoming) {
    merged.set(application.application_id, application);
  }
  return [...merged.values()].sort(
    (left, right) =>
      Date.parse(left.created_at) - Date.parse(right.created_at),
  );
}

export function mergeShadowRuns(
  current: readonly ExperienceShadowRunSummary[],
  incoming: readonly ExperienceShadowRunSummary[],
): ExperienceShadowRunSummary[] {
  const merged = new Map(current.map((run) => [run.run_id, run]));
  for (const run of incoming) {
    merged.set(run.run_id, run);
  }
  return [...merged.values()].sort(
    (left, right) =>
      Date.parse(left.created_at) - Date.parse(right.created_at),
  );
}

export function mergeExperienceCandidates(
  current: readonly ExperienceCandidateSummary[],
  incoming: readonly ExperienceCandidateSummary[],
): ExperienceCandidateSummary[] {
  const merged = new Map(
    current.map((candidate) => [candidate.candidate_id, candidate]),
  );
  for (const candidate of incoming) {
    merged.set(candidate.candidate_id, candidate);
  }
  return [...merged.values()].sort(
    (left, right) =>
      Date.parse(right.updated_at) - Date.parse(left.updated_at),
  );
}
