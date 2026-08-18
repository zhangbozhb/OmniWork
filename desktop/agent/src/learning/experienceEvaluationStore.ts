import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  ExperienceApplicationEvaluationSummary,
  ExperienceApplicationOutcome,
  ExperienceProjectEffectSummary,
} from "@omni-work/protocol-ts";
import type {
  ExperienceCandidateChange,
  ExperienceCandidateStore,
} from "./experienceCandidateStore.ts";
import { initializeLearningSchema } from "./learningSchema.ts";

interface ApplicationRow {
  application_id: string;
  episode_id: string;
  project_id: string;
  candidate_ids: string;
}

interface EvaluationRow {
  evaluation_id: string;
  application_id: string;
  episode_id: string;
  project_id: string;
  candidate_ids: string;
  outcome: ExperienceApplicationOutcome;
  effect: "positive" | "negative";
  evaluated_at: string;
}

export interface ExperienceEvaluationResult {
  evaluation: ExperienceApplicationEvaluationSummary;
  effect: ExperienceProjectEffectSummary;
  candidateChanges: ExperienceCandidateChange[];
}

export class ExperienceEvaluationStore {
  private readonly db: DatabaseSync;
  private readonly candidates: ExperienceCandidateStore;

  constructor(path: string, candidates: ExperienceCandidateStore) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.candidates = candidates;
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    initializeLearningSchema(this.db);
  }

  evaluateEpisode(input: {
    episodeId: string;
    outcome: ExperienceApplicationOutcome;
    outcomeAt: string;
    sourceActionId: string;
  }): ExperienceEvaluationResult | undefined {
    const application = this.db
      .prepare(
        `
          SELECT application_id, episode_id, project_id, candidate_ids
          FROM experience_applications
          WHERE episode_id = ?
        `,
      )
      .get(input.episodeId) as unknown as ApplicationRow | undefined;
    if (!application) {
      return undefined;
    }
    const candidateIds = parseCandidateIds(application.candidate_ids);
    if (candidateIds.length === 0) {
      return undefined;
    }
    const evaluationId = `evaluation_${createHash("sha256")
      .update(application.application_id)
      .digest("hex")
      .slice(0, 24)}`;
    const effect = outcomeEffect(input.outcome);
    this.transaction(() => {
      this.db
        .prepare(
          `
            INSERT OR IGNORE INTO experience_application_evaluation_events (
              source_action_id,
              application_id,
              outcome,
              created_at
            )
            VALUES (?, ?, ?, ?)
          `,
        )
        .run(
          input.sourceActionId,
          application.application_id,
          input.outcome,
          input.outcomeAt,
        );
      this.db
        .prepare(
          `
            INSERT INTO experience_application_evaluations (
              evaluation_id,
              application_id,
              episode_id,
              project_id,
              candidate_ids,
              outcome,
              effect,
              evaluated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(application_id) DO UPDATE SET
              outcome = CASE
                WHEN experience_application_evaluations.evaluated_at <= excluded.evaluated_at
                  THEN excluded.outcome
                ELSE experience_application_evaluations.outcome
              END,
              effect = CASE
                WHEN experience_application_evaluations.evaluated_at <= excluded.evaluated_at
                  THEN excluded.effect
                ELSE experience_application_evaluations.effect
              END,
              evaluated_at = CASE
                WHEN experience_application_evaluations.evaluated_at <= excluded.evaluated_at
                  THEN excluded.evaluated_at
                ELSE experience_application_evaluations.evaluated_at
              END
          `,
        )
        .run(
          evaluationId,
          application.application_id,
          application.episode_id,
          application.project_id,
          application.candidate_ids,
          input.outcome,
          effect,
          input.outcomeAt,
        );
    });
    const evaluation = this.getByApplication(application.application_id);
    if (!evaluation) {
      return undefined;
    }
    const candidateChanges = this.candidates.recordApplicationOutcome({
      candidateIds: evaluation.candidate_ids,
      episodeId: evaluation.episode_id,
      relation:
        evaluation.effect === "positive" ? "supporting" : "contradicting",
      createdAt: evaluation.evaluated_at,
    });
    return {
      evaluation,
      effect: this.effect(application.project_id),
      candidateChanges,
    };
  }

  backfill(): ExperienceEvaluationResult[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            application.application_id,
            application.episode_id,
            episode.outcome,
            episode.outcome_at
          FROM experience_applications application
          JOIN delivery_episodes episode
            ON episode.episode_id = application.episode_id
          WHERE episode.outcome IN (
            'accepted',
            'revision_requested',
            'abandoned'
          )
            AND episode.outcome_at IS NOT NULL
          ORDER BY episode.outcome_at ASC, application.application_id ASC
        `,
      )
      .all() as unknown as Array<{
      application_id: string;
      episode_id: string;
      outcome: ExperienceApplicationOutcome;
      outcome_at: string;
    }>;
    return rows.flatMap((row) => {
      const result = this.evaluateEpisode({
        episodeId: row.episode_id,
        outcome: row.outcome,
        outcomeAt: row.outcome_at,
        sourceActionId: `backfill:${row.application_id}:${row.outcome_at}`,
      });
      return result ? [result] : [];
    });
  }

  list(input: {
    projectId?: string;
    sessionId?: string;
    limit?: number;
  } = {}): ExperienceApplicationEvaluationSummary[] {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (input.projectId) {
      conditions.push("evaluation.project_id = ?");
      values.push(input.projectId);
    }
    if (input.sessionId) {
      conditions.push("episode.session_id = ?");
      values.push(input.sessionId);
    }
    values.push(normalizeLimit(input.limit));
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `
          SELECT evaluation.*
          FROM experience_application_evaluations evaluation
          JOIN delivery_episodes episode
            ON episode.episode_id = evaluation.episode_id
          ${where}
          ORDER BY evaluation.evaluated_at DESC, evaluation.evaluation_id ASC
          LIMIT ?
        `,
      )
      .all(...values) as unknown as EvaluationRow[];
    return rows.flatMap((row) => {
      const evaluation = toEvaluation(row);
      return evaluation ? [evaluation] : [];
    });
  }

  listEffects(input: {
    projectId?: string;
    sessionId?: string;
  } = {}): ExperienceProjectEffectSummary[] {
    const projectIds = new Set<string>();
    if (input.projectId) {
      projectIds.add(input.projectId);
    }
    if (input.sessionId) {
      const rows = this.db
        .prepare(
          `
            SELECT DISTINCT project_id
            FROM delivery_episodes
            WHERE session_id = ? AND project_id IS NOT NULL
          `,
        )
        .all(input.sessionId) as unknown as Array<{ project_id: string }>;
      for (const row of rows) {
        projectIds.add(row.project_id);
      }
    }
    if (!input.projectId && !input.sessionId) {
      const rows = this.db
        .prepare(
          `
            SELECT DISTINCT project_id
            FROM delivery_episodes
            WHERE project_id IS NOT NULL
          `,
        )
        .all() as unknown as Array<{ project_id: string }>;
      for (const row of rows) {
        projectIds.add(row.project_id);
      }
    }
    return [...projectIds].sort().map((projectId) => this.effect(projectId));
  }

  effect(projectId: string): ExperienceProjectEffectSummary {
    const assisted = this.db
      .prepare(
        `
          SELECT
            COUNT(*) AS evaluated,
            SUM(CASE WHEN episode.outcome = 'accepted' THEN 1 ELSE 0 END)
              AS accepted,
            SUM(CASE WHEN episode.outcome = 'revision_requested' THEN 1 ELSE 0 END)
              AS revision_requested,
            SUM(CASE WHEN episode.outcome = 'abandoned' THEN 1 ELSE 0 END)
              AS abandoned
          FROM delivery_episodes episode
          JOIN experience_applications application
            ON application.episode_id = episode.episode_id
          WHERE episode.project_id = ?
            AND episode.outcome IN (
              'accepted',
              'revision_requested',
              'abandoned'
            )
        `,
      )
      .get(projectId) as unknown as CountRow;
    const baseline = this.db
      .prepare(
        `
          SELECT
            COUNT(*) AS evaluated,
            SUM(CASE WHEN episode.outcome = 'accepted' THEN 1 ELSE 0 END)
              AS accepted
          FROM delivery_episodes episode
          LEFT JOIN experience_applications application
            ON application.episode_id = episode.episode_id
          WHERE episode.project_id = ?
            AND application.application_id IS NULL
            AND episode.outcome IN (
              'accepted',
              'revision_requested',
              'abandoned'
            )
        `,
      )
      .get(projectId) as unknown as CountRow;
    const assistedRate = rate(assisted.accepted, assisted.evaluated);
    const baselineRate = rate(baseline.accepted, baseline.evaluated);
    return {
      project_id: projectId,
      assisted_evaluated: assisted.evaluated,
      assisted_accepted: assisted.accepted ?? 0,
      assisted_revision_requested: assisted.revision_requested ?? 0,
      assisted_abandoned: assisted.abandoned ?? 0,
      assisted_acceptance_rate: assistedRate,
      baseline_evaluated: baseline.evaluated,
      baseline_accepted: baseline.accepted ?? 0,
      baseline_acceptance_rate: baselineRate,
      acceptance_rate_delta:
        assistedRate === undefined || baselineRate === undefined
          ? undefined
          : roundRate(assistedRate - baselineRate),
    };
  }

  private getByApplication(
    applicationId: string,
  ): ExperienceApplicationEvaluationSummary | undefined {
    const row = this.db
      .prepare(
        `
          SELECT *
          FROM experience_application_evaluations
          WHERE application_id = ?
        `,
      )
      .get(applicationId) as unknown as EvaluationRow | undefined;
    return row ? toEvaluation(row) : undefined;
  }

  private transaction(task: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      task();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

interface CountRow {
  evaluated: number;
  accepted: number | null;
  revision_requested?: number | null;
  abandoned?: number | null;
}

function toEvaluation(
  row: EvaluationRow,
): ExperienceApplicationEvaluationSummary | undefined {
  const candidateIds = parseCandidateIds(row.candidate_ids);
  return candidateIds.length > 0
    ? {
        evaluation_id: row.evaluation_id,
        application_id: row.application_id,
        episode_id: row.episode_id,
        project_id: row.project_id,
        candidate_ids: candidateIds,
        outcome: row.outcome,
        effect: row.effect,
        evaluated_at: row.evaluated_at,
      }
    : undefined;
}

function parseCandidateIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function outcomeEffect(
  outcome: ExperienceApplicationOutcome,
): "positive" | "negative" {
  return outcome === "accepted" ? "positive" : "negative";
}

function rate(
  accepted: number | null,
  evaluated: number,
): number | undefined {
  return evaluated > 0 ? roundRate((accepted ?? 0) / evaluated) : undefined;
}

function roundRate(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit) || (limit ?? 0) <= 0) {
    return 100;
  }
  return Math.min(limit as number, 100);
}
