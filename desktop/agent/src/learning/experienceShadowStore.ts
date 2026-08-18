import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AgentExperienceShadowFeedbackSetPayload,
  ExperienceCandidateSummary,
  ExperienceShadowFeedback,
  ExperienceShadowMatchSummary,
  ExperienceShadowRunSummary,
  ExperienceShadowStats,
} from "@omni-work/protocol-ts";
import type { ExperienceCandidateStore } from "./experienceCandidateStore.ts";
import { initializeLearningSchema } from "./learningSchema.ts";

export const SHADOW_ACTIVATION_MIN_REVIEWS = 10;
export const SHADOW_ACTIVATION_MIN_RELEVANCE = 0.7;

interface ShadowRunRow {
  run_id: string;
  episode_id: string;
  project_id: string;
  session_id: string;
  surface_id: string | null;
  created_at: string;
}

interface FeedbackRow {
  client_action_id: string;
  run_id: string;
  candidate_id: string;
  feedback: ExperienceShadowFeedback;
}

export interface ExperienceShadowEvaluation {
  run: ExperienceShadowRunSummary;
  updatedCandidates: ExperienceCandidateSummary[];
}

export type ExperienceShadowFeedbackWriteResult =
  | {
      result: "applied" | "duplicate";
      run: ExperienceShadowRunSummary;
    }
  | { result: "not_found" | "conflict" };

export class ExperienceShadowStore {
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

  evaluate(input: {
    episodeId: string;
    projectId: string;
    sessionId: string;
    surfaceId?: string;
    prompt: string;
    createdAt: string;
  }): ExperienceShadowEvaluation {
    const existing = this.getByEpisode(input.episodeId);
    if (existing) {
      return { run: existing, updatedCandidates: [] };
    }
    const matches = retrieveShadowMatches(
      input.prompt,
      this.candidates.listShadowEligible(input.projectId),
    );
    const runId = `shadow_${createHash("sha256")
      .update(input.episodeId)
      .digest("hex")
      .slice(0, 24)}`;
    this.transaction(() => {
      this.db
        .prepare(
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
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          runId,
          input.episodeId,
          input.projectId,
          input.sessionId,
          input.surfaceId ?? null,
          createHash("sha256").update(input.prompt).digest("hex"),
          input.createdAt,
        );
      const insert = this.db.prepare(
        `
          INSERT INTO experience_shadow_matches (
            run_id,
            candidate_id,
            rank,
            score,
            reason,
            trigger_snapshot,
            guidance_snapshot
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      );
      for (const match of matches) {
        insert.run(
          runId,
          match.candidate.candidate_id,
          match.rank,
          match.score,
          match.reason,
          match.candidate.trigger,
          match.candidate.guidance,
        );
      }
    });

    const updatedCandidates = matches.flatMap((match) => {
      const candidate = this.candidates.markShadow(
        match.candidate.candidate_id,
        input.createdAt,
      );
      return candidate ? [candidate] : [];
    });
    return {
      run: this.get(runId) as ExperienceShadowRunSummary,
      updatedCandidates,
    };
  }

  get(runId: string): ExperienceShadowRunSummary | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM experience_shadow_runs WHERE run_id = ?",
      )
      .get(runId) as unknown as ShadowRunRow | undefined;
    return row ? this.toSummary(row) : undefined;
  }

  list(input: {
    projectId?: string;
    sessionId?: string;
    limit?: number;
  } = {}): ExperienceShadowRunSummary[] {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (input.projectId) {
      conditions.push("project_id = ?");
      values.push(input.projectId);
    }
    if (input.sessionId) {
      conditions.push("session_id = ?");
      values.push(input.sessionId);
    }
    values.push(normalizeLimit(input.limit));
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM experience_shadow_runs
          ${where}
          ORDER BY created_at DESC, run_id ASC
          LIMIT ?
        `,
      )
      .all(...values) as unknown as ShadowRunRow[];
    return rows.map((row) => this.toSummary(row));
  }

  stats(input: {
    projectId?: string;
    sessionId?: string;
  } = {}): ExperienceShadowStats {
    const conditions: string[] = [];
    const values: string[] = [];
    if (input.projectId) {
      conditions.push("run.project_id = ?");
      values.push(input.projectId);
    }
    if (input.sessionId) {
      conditions.push("run.session_id = ?");
      values.push(input.sessionId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const row = this.db
      .prepare(
        `
          SELECT
            COUNT(match.candidate_id) AS total_matches,
            SUM(CASE WHEN match.feedback IS NOT NULL THEN 1 ELSE 0 END)
              AS reviewed_matches,
            SUM(CASE WHEN match.feedback = 'relevant' THEN 1 ELSE 0 END)
              AS relevant_matches,
            SUM(CASE WHEN match.feedback = 'not_relevant' THEN 1 ELSE 0 END)
              AS not_relevant_matches
          FROM experience_shadow_runs run
          LEFT JOIN experience_shadow_matches match ON match.run_id = run.run_id
          ${where}
        `,
      )
      .get(...values) as {
      total_matches: number;
      reviewed_matches: number | null;
      relevant_matches: number | null;
      not_relevant_matches: number | null;
    };
    const reviewedMatches = row.reviewed_matches ?? 0;
    const relevantMatches = row.relevant_matches ?? 0;
    const relevanceRate =
      reviewedMatches > 0
        ? Math.round((relevantMatches / reviewedMatches) * 10_000) / 10_000
        : undefined;
    return {
      total_matches: row.total_matches,
      reviewed_matches: reviewedMatches,
      relevant_matches: relevantMatches,
      not_relevant_matches: row.not_relevant_matches ?? 0,
      relevance_rate: relevanceRate,
      activation_ready: isShadowActivationReady(
        reviewedMatches,
        relevantMatches,
      ),
    };
  }

  setFeedback(
    input: AgentExperienceShadowFeedbackSetPayload,
  ): ExperienceShadowFeedbackWriteResult {
    const existingAction = this.db
      .prepare(
        `
          SELECT client_action_id, run_id, candidate_id, feedback
          FROM experience_shadow_feedbacks
          WHERE client_action_id = ?
        `,
      )
      .get(input.client_action_id) as unknown as FeedbackRow | undefined;
    if (existingAction) {
      const sameAction =
        existingAction.run_id === input.run_id &&
        existingAction.candidate_id === input.candidate_id &&
        existingAction.feedback === input.feedback;
      const run = this.get(existingAction.run_id);
      return sameAction && run
        ? { result: "duplicate", run }
        : { result: "conflict" };
    }
    const match = this.db
      .prepare(
        `
          SELECT candidate_id
          FROM experience_shadow_matches
          WHERE run_id = ? AND candidate_id = ?
        `,
      )
      .get(input.run_id, input.candidate_id);
    if (!match) {
      return { result: "not_found" };
    }
    this.transaction(() => {
      this.db
        .prepare(
          `
            INSERT INTO experience_shadow_feedbacks (
              client_action_id,
              run_id,
              candidate_id,
              feedback,
              created_at
            )
            VALUES (?, ?, ?, ?, ?)
          `,
        )
        .run(
          input.client_action_id,
          input.run_id,
          input.candidate_id,
          input.feedback,
          input.created_at,
        );
      this.db
        .prepare(
          `
            UPDATE experience_shadow_matches
            SET feedback = ?, feedback_at = ?
            WHERE run_id = ? AND candidate_id = ?
              AND (feedback_at IS NULL OR feedback_at <= ?)
          `,
        )
        .run(
          input.feedback,
          input.created_at,
          input.run_id,
          input.candidate_id,
          input.created_at,
        );
    });
    return {
      result: "applied",
      run: this.get(input.run_id) as ExperienceShadowRunSummary,
    };
  }

  private getByEpisode(
    episodeId: string,
  ): ExperienceShadowRunSummary | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM experience_shadow_runs WHERE episode_id = ?",
      )
      .get(episodeId) as unknown as ShadowRunRow | undefined;
    return row ? this.toSummary(row) : undefined;
  }

  private toSummary(row: ShadowRunRow): ExperienceShadowRunSummary {
    const matches = this.db
      .prepare(
        `
          SELECT
            candidate_id,
            trigger_snapshot,
            guidance_snapshot,
            rank,
            score,
            reason,
            feedback,
            feedback_at
          FROM experience_shadow_matches
          WHERE run_id = ?
          ORDER BY rank ASC
        `,
      )
      .all(row.run_id) as unknown as Array<{
      candidate_id: string;
      trigger_snapshot: string;
      guidance_snapshot: string;
      rank: number;
      score: number;
      reason: ExperienceShadowMatchSummary["reason"];
      feedback: ExperienceShadowFeedback | null;
      feedback_at: string | null;
    }>;
    return {
      run_id: row.run_id,
      episode_id: row.episode_id,
      project_id: row.project_id,
      session_id: row.session_id,
      surface_id: row.surface_id ?? undefined,
      created_at: row.created_at,
      matches: matches.map((match) => ({
        candidate_id: match.candidate_id,
        trigger: match.trigger_snapshot,
        guidance: match.guidance_snapshot,
        rank: match.rank,
        score: match.score,
        reason: match.reason,
        feedback: match.feedback ?? undefined,
        feedback_at: match.feedback_at ?? undefined,
      })),
    };
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

export function retrieveShadowMatches(
  prompt: string,
  candidates: readonly ExperienceCandidateSummary[],
  limit = 3,
): Array<{
  candidate: ExperienceCandidateSummary;
  rank: number;
  score: number;
  reason: ExperienceShadowMatchSummary["reason"];
}> {
  const normalizedPrompt = normalizeSearchText(prompt);
  const promptTokens = searchTokens(normalizedPrompt);
  const matches = candidates.flatMap((candidate) => {
    const normalizedTrigger = normalizeSearchText(candidate.trigger);
    const exact =
      normalizedTrigger.length >= 4 &&
      (normalizedPrompt.includes(normalizedTrigger) ||
        normalizedTrigger.includes(normalizedPrompt));
    const triggerTokens = searchTokens(normalizedTrigger);
    const overlap = [...triggerTokens].filter((token) =>
      promptTokens.has(token),
    ).length;
    const coverage =
      triggerTokens.size > 0 ? overlap / triggerTokens.size : 0;
    const precision =
      promptTokens.size > 0 ? overlap / promptTokens.size : 0;
    const score = exact ? 1 : 0.75 * coverage + 0.25 * precision;
    if (!exact && (overlap < 2 || score < 0.35)) {
      return [];
    }
    return [
      {
        candidate,
        score: Math.round(score * 10_000) / 10_000,
        reason: exact
          ? ("exact_trigger" as const)
          : ("token_overlap" as const),
      },
    ];
  });
  return matches
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.candidate.support_count - left.candidate.support_count ||
        left.candidate.contradiction_count -
          right.candidate.contradiction_count ||
        left.candidate.candidate_id.localeCompare(
          right.candidate.candidate_id,
        ),
    )
    .slice(0, Math.max(0, Math.min(limit, 3)))
    .map((match, index) => ({ ...match, rank: index + 1 }));
}

export function isShadowActivationReady(
  reviewedMatches: number,
  relevantMatches: number,
): boolean {
  return (
    reviewedMatches >= SHADOW_ACTIVATION_MIN_REVIEWS &&
    relevantMatches / reviewedMatches >= SHADOW_ACTIVATION_MIN_RELEVANCE
  );
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function searchTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  const words = value.match(/[a-z0-9_]+/gu) ?? [];
  for (const word of words) {
    if (word.length >= 2 && !SEARCH_STOP_WORDS.has(word)) {
      tokens.add(word);
    }
  }
  const han = [...value].filter((character) =>
    /\p{Script=Han}/u.test(character),
  );
  if (han.length === 1) {
    tokens.add(han[0] as string);
  }
  for (let index = 0; index < han.length - 1; index += 1) {
    tokens.add(`${han[index]}${han[index + 1]}`);
  }
  return tokens;
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit) || (limit ?? 0) <= 0) {
    return 100;
  }
  return Math.min(limit as number, 100);
}

const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "of",
  "on",
  "the",
  "to",
  "with",
]);
