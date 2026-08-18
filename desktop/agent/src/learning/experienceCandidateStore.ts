import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AgentExperienceLifecycleSetPayload,
  AgentExperienceReviewSetPayload,
  ExperienceCandidateKind,
  ExperienceCandidateStatus,
  ExperienceCandidateSummary,
  ExperiencePromotionEligibilitySummary,
} from "@omni-work/protocol-ts";
import type { DeliveryEpisode } from "./deliveryEpisodeStore.ts";
import { initializeLearningSchema } from "./learningSchema.ts";

export const EXPERIENCE_STALE_AFTER_DAYS = 180;

interface CandidateRow {
  candidate_id: string;
  project_id: string;
  kind: ExperienceCandidateKind;
  trigger_text: string;
  guidance_text: string;
  status: ExperienceCandidateStatus;
  support_count: number;
  contradiction_count: number;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  review_note: string | null;
}

interface LifecycleRow {
  client_action_id: string;
  candidate_id: string;
  action: "pause" | "resume" | "deprecate";
  note: string | null;
}

interface ReviewRow {
  client_action_id: string;
  candidate_id: string;
  decision: "approved" | "rejected";
  trigger_text: string;
  guidance_text: string;
  note: string | null;
}

export type ExperienceCandidateChange =
  | { kind: "updated"; candidate: ExperienceCandidateSummary }
  | { kind: "removed"; candidateId: string; projectId: string };

export type ExperienceReviewWriteResult =
  | {
      result: "applied" | "duplicate";
      candidate: ExperienceCandidateSummary;
    }
  | { result: "not_found" | "invalid_state" | "conflict" };

export type ExperienceLifecycleWriteResult =
  | {
      result: "applied" | "duplicate";
      candidate: ExperienceCandidateSummary;
    }
  | { result: "not_found" | "invalid_state" | "conflict" };

export class ExperienceCandidateStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    initializeLearningSchema(this.db);
  }

  reconcileEpisode(episode: DeliveryEpisode): ExperienceCandidateChange[] {
    const existingEvidence = this.db
      .prepare(
        `
          SELECT candidate_id, source_fingerprint
          FROM experience_candidate_evidence
          WHERE episode_id = ?
            AND source_kind = 'explicit_user_correction'
        `,
      )
      .all(episode.episodeId) as unknown as Array<{
      candidate_id: string;
      source_fingerprint: string | null;
    }>;
    const affected = new Set(
      existingEvidence.map((row) => row.candidate_id),
    );
    const input = candidateInput(episode);
    const sourceFingerprint = input
      ? candidateFingerprint(
          input.projectId,
          input.trigger,
          input.guidance,
        )
      : undefined;

    this.transaction(() => {
      this.db
        .prepare(
          `
            DELETE FROM experience_candidate_evidence
            WHERE episode_id = ?
              AND source_kind = 'explicit_user_correction'
          `,
        )
        .run(episode.episodeId);

      if (input && sourceFingerprint) {
        const retainedCandidateId = existingEvidence.find(
          (evidence) =>
            evidence.source_fingerprint === sourceFingerprint &&
            this.candidateExists(evidence.candidate_id),
        )?.candidate_id;
        let targetCandidateId = retainedCandidateId;
        if (!targetCandidateId) {
          const candidateId = candidateIdForFingerprint(sourceFingerprint);
          this.db
            .prepare(
              `
              INSERT INTO experience_candidates (
                candidate_id,
                fingerprint,
                project_id,
                kind,
                trigger_text,
                guidance_text,
                status,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, 'user_correction', ?, ?, 'candidate', ?, ?)
              ON CONFLICT(fingerprint) DO UPDATE SET
                trigger_text = CASE
                  WHEN experience_candidates.status = 'candidate'
                    THEN excluded.trigger_text
                  ELSE experience_candidates.trigger_text
                END,
                guidance_text = CASE
                  WHEN experience_candidates.status = 'candidate'
                    THEN excluded.guidance_text
                  ELSE experience_candidates.guidance_text
                END,
                updated_at = CASE
                  WHEN experience_candidates.updated_at > excluded.updated_at
                    THEN experience_candidates.updated_at
                  ELSE excluded.updated_at
                END
              `,
            )
            .run(
              candidateId,
              sourceFingerprint,
              input.projectId,
              input.trigger,
              input.guidance,
              episode.outcomeAt ?? episode.updatedAt,
              episode.outcomeAt ?? episode.updatedAt,
            );
          const stored = this.db
            .prepare(
              "SELECT candidate_id FROM experience_candidates WHERE fingerprint = ?",
            )
            .get(sourceFingerprint) as { candidate_id: string };
          targetCandidateId = stored.candidate_id;
        }
        this.db
          .prepare(
            `
              INSERT OR IGNORE INTO experience_candidate_evidence (
                candidate_id,
                episode_id,
                relation,
                source_kind,
                source_fingerprint,
                created_at
              )
              VALUES (?, ?, 'supporting', 'explicit_user_correction', ?, ?)
            `,
          )
          .run(
            targetCandidateId,
            episode.episodeId,
            sourceFingerprint,
            episode.outcomeAt ?? episode.updatedAt,
          );
        affected.add(targetCandidateId);
      }
    });

    return [...affected].flatMap((candidateId) =>
      this.recountCandidate(candidateId),
    );
  }

  get(candidateId: string): ExperienceCandidateSummary | undefined {
    const row = this.db
      .prepare("SELECT * FROM experience_candidates WHERE candidate_id = ?")
      .get(candidateId) as unknown as CandidateRow | undefined;
    return row ? this.toSummary(row) : undefined;
  }

  list(input: {
    projectId?: string;
    sessionId?: string;
    limit?: number;
  } = {}): ExperienceCandidateSummary[] {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (input.projectId) {
      conditions.push("candidate.project_id = ?");
      values.push(input.projectId);
    }
    if (input.sessionId) {
      conditions.push(`
        EXISTS (
          SELECT 1
          FROM experience_candidate_evidence evidence
          JOIN delivery_episodes episode
            ON episode.episode_id = evidence.episode_id
          WHERE evidence.candidate_id = candidate.candidate_id
            AND episode.session_id = ?
        )
      `);
      values.push(input.sessionId);
    }
    values.push(normalizeLimit(input.limit));
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `
          SELECT candidate.*
          FROM experience_candidates candidate
          ${where}
          ORDER BY candidate.updated_at DESC, candidate.candidate_id ASC
          LIMIT ?
        `,
      )
      .all(...values) as unknown as CandidateRow[];
    return rows.map((row) => this.toSummary(row));
  }

  listShadowEligible(projectId: string): ExperienceCandidateSummary[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM experience_candidates
          WHERE project_id = ?
            AND status IN ('approved', 'shadow', 'active', 'paused')
            AND support_count > 0
            AND support_count > contradiction_count
          ORDER BY updated_at DESC, candidate_id ASC
          LIMIT 200
        `,
      )
      .all(projectId) as unknown as CandidateRow[];
    return rows.map((row) => this.toSummary(row));
  }

  markShadow(
    candidateId: string,
    timestamp: string,
  ): ExperienceCandidateSummary | undefined {
    this.db
      .prepare(
        `
          UPDATE experience_candidates
          SET
            status = 'shadow',
            updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
          WHERE candidate_id = ? AND status = 'approved'
        `,
      )
      .run(timestamp, timestamp, candidateId);
    return this.get(candidateId);
  }

  markActive(
    candidateIds: readonly string[],
    timestamp: string,
  ): ExperienceCandidateSummary[] {
    const update = this.db.prepare(
      `
        UPDATE experience_candidates
        SET
          status = 'active',
          updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
        WHERE candidate_id = ?
          AND status IN ('approved', 'shadow', 'active')
          AND support_count > contradiction_count
      `,
    );
    for (const candidateId of candidateIds) {
      update.run(timestamp, timestamp, candidateId);
    }
    return candidateIds.flatMap((candidateId) => {
      const candidate = this.get(candidateId);
      return candidate ? [candidate] : [];
    });
  }

  listActivationEligible(projectId: string): ExperienceCandidateSummary[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM experience_candidates
          WHERE project_id = ?
            AND status IN ('approved', 'shadow', 'active')
            AND support_count > 0
            AND support_count > contradiction_count
          ORDER BY updated_at DESC, candidate_id ASC
          LIMIT 200
        `,
      )
      .all(projectId) as unknown as CandidateRow[];
    return rows.map((row) => this.toSummary(row));
  }

  recordApplicationOutcome(input: {
    candidateIds: readonly string[];
    episodeId: string;
    relation: "supporting" | "contradicting";
    createdAt: string;
  }): ExperienceCandidateChange[] {
    const affected = new Set<string>();
    const statement = this.db.prepare(
      `
        INSERT INTO experience_candidate_evidence (
          candidate_id,
          episode_id,
          relation,
          source_kind,
          source_fingerprint,
          created_at
        )
        VALUES (?, ?, ?, 'active_application_outcome', NULL, ?)
        ON CONFLICT(candidate_id, episode_id, source_kind) DO UPDATE SET
          relation = excluded.relation,
          created_at = excluded.created_at
      `,
    );
    this.transaction(() => {
      for (const candidateId of input.candidateIds) {
        if (!this.candidateExists(candidateId)) {
          continue;
        }
        statement.run(
          candidateId,
          input.episodeId,
          input.relation,
          input.createdAt,
        );
        affected.add(candidateId);
      }
    });
    return [...affected].flatMap((candidateId) =>
      this.recountCandidate(candidateId),
    );
  }

  setLifecycle(
    input: AgentExperienceLifecycleSetPayload,
  ): ExperienceLifecycleWriteResult {
    const existingAction = this.db
      .prepare(
        `
          SELECT client_action_id, candidate_id, action, note
          FROM experience_candidate_lifecycle_actions
          WHERE client_action_id = ?
        `,
      )
      .get(input.client_action_id) as unknown as LifecycleRow | undefined;
    const note = normalizeNote(input.note);
    if (existingAction) {
      const candidate = this.get(existingAction.candidate_id);
      const sameAction =
        existingAction.candidate_id === input.candidate_id &&
        existingAction.action === input.action &&
        (existingAction.note ?? undefined) === note;
      return sameAction && candidate
        ? { result: "duplicate", candidate }
        : { result: "conflict" };
    }
    const current = this.get(input.candidate_id);
    if (!current || current.project_id !== input.project_id) {
      return { result: "not_found" };
    }
    if (
      input.action === "resume" &&
      current.support_count <= current.contradiction_count
    ) {
      return { result: "invalid_state" };
    }
    const nextStatus = lifecycleStatus(current.status, input.action);
    if (!nextStatus) {
      return { result: "invalid_state" };
    }
    this.transaction(() => {
      this.db
        .prepare(
          `
            INSERT INTO experience_candidate_lifecycle_actions (
              client_action_id,
              candidate_id,
              action,
              note,
              created_at
            )
            VALUES (?, ?, ?, ?, ?)
          `,
        )
        .run(
          input.client_action_id,
          input.candidate_id,
          input.action,
          note ?? null,
          input.created_at,
        );
      this.db
        .prepare(
          `
            UPDATE experience_candidates
            SET
              status = ?,
              review_note = COALESCE(?, review_note),
              lifecycle_at = ?,
              updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
            WHERE candidate_id = ?
              AND (lifecycle_at IS NULL OR lifecycle_at <= ?)
          `,
        )
        .run(
          nextStatus,
          note ?? null,
          input.created_at,
          input.created_at,
          input.created_at,
          input.candidate_id,
          input.created_at,
        );
    });
    return {
      result: "applied",
      candidate: this.get(input.candidate_id) as ExperienceCandidateSummary,
    };
  }

  applyStaleness(
    now: string,
    staleAfterDays = EXPERIENCE_STALE_AFTER_DAYS,
  ): ExperienceCandidateChange[] {
    const cutoff = new Date(
      Date.parse(now) - staleAfterDays * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const rows = this.db
      .prepare(
        `
          SELECT
            candidate.candidate_id,
            COALESCE(MAX(evidence.created_at), candidate.created_at)
              AS last_evidence_at
          FROM experience_candidates candidate
          LEFT JOIN experience_candidate_evidence evidence
            ON evidence.candidate_id = candidate.candidate_id
          WHERE candidate.status IN ('approved', 'shadow', 'active')
          GROUP BY candidate.candidate_id
          HAVING last_evidence_at < ?
        `,
      )
      .all(cutoff) as unknown as Array<{
      candidate_id: string;
      last_evidence_at: string;
    }>;
    for (const row of rows) {
      const actionId = `auto-stale:${row.candidate_id}:${row.last_evidence_at}`;
      this.transaction(() => {
        this.db
          .prepare(
            `
              INSERT OR IGNORE INTO experience_candidate_lifecycle_actions (
                client_action_id,
                candidate_id,
                action,
                note,
                created_at
              )
              VALUES (?, ?, 'pause', 'stale_evidence', ?)
            `,
          )
          .run(actionId, row.candidate_id, now);
        this.db
          .prepare(
            `
              UPDATE experience_candidates
              SET status = 'paused', lifecycle_at = ?, updated_at = ?
              WHERE candidate_id = ?
                AND status IN ('approved', 'shadow', 'active')
            `,
          )
          .run(now, now, row.candidate_id);
      });
    }
    return rows.flatMap((row) => {
      const candidate = this.get(row.candidate_id);
      return candidate ? [{ kind: "updated" as const, candidate }] : [];
    });
  }

  listPromotionEligibility(
    projectId?: string,
  ): ExperiencePromotionEligibilitySummary[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM experience_candidates
          WHERE status IN ('approved', 'shadow', 'active')
            AND support_count > contradiction_count
          ORDER BY candidate_id ASC
        `,
      )
      .all() as unknown as CandidateRow[];
    const groups = new Map<
      string,
      {
        candidateIds: string[];
        projectIds: Set<string>;
        supportCount: number;
        contradictionCount: number;
      }
    >();
    for (const row of rows) {
      const promotionKey = createHash("sha256")
        .update(
          [
            normalizeFingerprintText(row.trigger_text),
            normalizeFingerprintText(row.guidance_text),
          ].join("\n"),
        )
        .digest("hex");
      const group = groups.get(promotionKey) ?? {
        candidateIds: [],
        projectIds: new Set<string>(),
        supportCount: 0,
        contradictionCount: 0,
      };
      group.candidateIds.push(row.candidate_id);
      group.projectIds.add(row.project_id);
      group.supportCount += row.support_count;
      group.contradictionCount += row.contradiction_count;
      groups.set(promotionKey, group);
    }
    return [...groups.entries()]
      .filter(
        ([, group]) =>
          group.projectIds.size >= 2 &&
          (!projectId || group.projectIds.has(projectId)),
      )
      .map(([promotionKey, group]) => ({
        promotion_key: promotionKey,
        candidate_ids: group.candidateIds,
        project_ids: [...group.projectIds].sort(),
        project_count: group.projectIds.size,
        support_count: group.supportCount,
        contradiction_count: group.contradictionCount,
        eligible:
          group.projectIds.size >= 2 &&
          group.contradictionCount === 0,
      }))
      .sort((left, right) =>
        left.promotion_key.localeCompare(right.promotion_key),
      );
  }

  setReview(
    input: AgentExperienceReviewSetPayload,
  ): ExperienceReviewWriteResult {
    const existingAction = this.db
      .prepare(
        `
          SELECT
            client_action_id,
            candidate_id,
            decision,
            trigger_text,
            guidance_text,
            note
          FROM experience_candidate_reviews
          WHERE client_action_id = ?
        `,
      )
      .get(input.client_action_id) as unknown as ReviewRow | undefined;
    if (existingAction) {
      const candidate = this.get(existingAction.candidate_id);
      const sameAction =
        existingAction.candidate_id === input.candidate_id &&
        existingAction.decision === input.decision &&
        existingAction.trigger_text ===
          normalizeCandidateText(
            input.trigger ?? existingAction.trigger_text,
          ) &&
        existingAction.guidance_text ===
          normalizeCandidateText(
            input.guidance ?? existingAction.guidance_text,
          ) &&
        (existingAction.note ?? undefined) === normalizeNote(input.note);
      return sameAction && candidate
        ? { result: "duplicate", candidate }
        : { result: "conflict" };
    }

    const current = this.get(input.candidate_id);
    if (!current || current.project_id !== input.project_id) {
      return { result: "not_found" };
    }
    if (
      current.status !== "candidate" &&
      current.status !== "approved" &&
      current.status !== "rejected" &&
      current.status !== "shadow" &&
      current.status !== "active"
    ) {
      return { result: "invalid_state" };
    }
    const trigger = normalizeCandidateText(input.trigger ?? current.trigger);
    const guidance = normalizeCandidateText(
      input.guidance ?? current.guidance,
    );
    if (!trigger || !guidance) {
      return { result: "invalid_state" };
    }
    const fingerprint = candidateFingerprint(
      current.project_id,
      trigger,
      guidance,
    );
    const conflicting = this.db
      .prepare(
        `
          SELECT candidate_id
          FROM experience_candidates
          WHERE fingerprint = ? AND candidate_id <> ?
        `,
      )
      .get(fingerprint, current.candidate_id) as
      | { candidate_id: string }
      | undefined;
    if (conflicting) {
      return { result: "conflict" };
    }

    const note = normalizeNote(input.note);
    this.transaction(() => {
      this.db
        .prepare(
          `
            INSERT INTO experience_candidate_reviews (
              client_action_id,
              candidate_id,
              decision,
              trigger_text,
              guidance_text,
              note,
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          input.client_action_id,
          input.candidate_id,
          input.decision,
          trigger,
          guidance,
          note ?? null,
          input.created_at,
        );
      this.db
        .prepare(
          `
            UPDATE experience_candidates
            SET
              fingerprint = ?,
              trigger_text = ?,
              guidance_text = ?,
              status = ?,
              review_note = ?,
              reviewed_at = ?,
              updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
            WHERE candidate_id = ?
              AND (reviewed_at IS NULL OR reviewed_at <= ?)
          `,
        )
        .run(
          fingerprint,
          trigger,
          guidance,
          input.decision,
          note ?? null,
          input.created_at,
          input.created_at,
          input.created_at,
          input.candidate_id,
          input.created_at,
        );
    });
    return {
      result: "applied",
      candidate: this.get(input.candidate_id) as ExperienceCandidateSummary,
    };
  }

  private recountCandidate(
    candidateId: string,
  ): ExperienceCandidateChange[] {
    const current = this.get(candidateId);
    if (!current) {
      return [];
    }
    const counts = this.db
      .prepare(
        `
          SELECT
            SUM(CASE WHEN relation = 'supporting' THEN 1 ELSE 0 END) AS support_count,
            SUM(CASE WHEN relation = 'contradicting' THEN 1 ELSE 0 END) AS contradiction_count
          FROM experience_candidate_evidence
          WHERE candidate_id = ?
        `,
      )
      .get(candidateId) as {
      support_count: number | null;
      contradiction_count: number | null;
    };
    const supportCount = counts.support_count ?? 0;
    const contradictionCount = counts.contradiction_count ?? 0;
    if (supportCount === 0 && current.status === "candidate") {
      this.db
        .prepare("DELETE FROM experience_candidates WHERE candidate_id = ?")
        .run(candidateId);
      return [
        {
          kind: "removed",
          candidateId,
          projectId: current.project_id,
        },
      ];
    }
    const nextStatus = nextEvidenceStatus(
      current.status,
      supportCount,
      contradictionCount,
    );
    this.db
      .prepare(
        `
          UPDATE experience_candidates
          SET support_count = ?, contradiction_count = ?, status = ?
          WHERE candidate_id = ?
        `,
      )
      .run(supportCount, contradictionCount, nextStatus, candidateId);
    const candidate = this.get(candidateId);
    return candidate ? [{ kind: "updated", candidate }] : [];
  }

  private toSummary(row: CandidateRow): ExperienceCandidateSummary {
    const evidence = (
      this.db
        .prepare(
          `
            SELECT episode_id, relation
            FROM experience_candidate_evidence
            WHERE candidate_id = ?
            ORDER BY created_at ASC, episode_id ASC
            LIMIT 200
          `,
        )
        .all(row.candidate_id) as unknown as Array<{
        episode_id: string;
        relation: "supporting" | "contradicting";
      }>
    );
    return {
      candidate_id: row.candidate_id,
      project_id: row.project_id,
      kind: row.kind,
      trigger: row.trigger_text,
      guidance: row.guidance_text,
      status: row.status,
      support_count: row.support_count,
      contradiction_count: row.contradiction_count,
      supporting_episode_ids: evidence
        .filter((item) => item.relation === "supporting")
        .map((item) => item.episode_id),
      contradicting_episode_ids: evidence
        .filter((item) => item.relation === "contradicting")
        .map((item) => item.episode_id),
      created_at: row.created_at,
      updated_at: row.updated_at,
      reviewed_at: row.reviewed_at ?? undefined,
      review_note: row.review_note ?? undefined,
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

  private candidateExists(candidateId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT candidate_id FROM experience_candidates WHERE candidate_id = ?",
        )
        .get(candidateId),
    );
  }

}

function candidateInput(episode: DeliveryEpisode):
  | {
      projectId: string;
      trigger: string;
      guidance: string;
    }
  | undefined {
  if (
    episode.outcome !== "revision_requested" ||
    episode.outcomeSource !== "user" ||
    !episode.projectId ||
    !episode.objective ||
    !episode.outcomeNote
  ) {
    return undefined;
  }
  const trigger = normalizeCandidateText(episode.objective);
  const guidance = normalizeCandidateText(episode.outcomeNote);
  return trigger && guidance
    ? { projectId: episode.projectId, trigger, guidance }
    : undefined;
}

function candidateFingerprint(
  projectId: string,
  trigger: string,
  guidance: string,
): string {
  return createHash("sha256")
    .update(
      [
        projectId,
        normalizeFingerprintText(trigger),
        normalizeFingerprintText(guidance),
      ].join("\n"),
    )
    .digest("hex");
}

function candidateIdForFingerprint(fingerprint: string): string {
  return `experience_${fingerprint.slice(0, 24)}`;
}

function normalizeCandidateText(value: string): string {
  return value.trim().slice(0, 8_000);
}

function normalizeFingerprintText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function normalizeNote(note: string | undefined): string | undefined {
  const trimmed = note?.trim();
  return trimmed || undefined;
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit) || (limit ?? 0) <= 0) {
    return 100;
  }
  return Math.min(limit as number, 200);
}

function lifecycleStatus(
  current: ExperienceCandidateStatus,
  action: AgentExperienceLifecycleSetPayload["action"],
): ExperienceCandidateStatus | undefined {
  if (
    action === "pause" &&
    (current === "approved" ||
      current === "shadow" ||
      current === "active")
  ) {
    return "paused";
  }
  if (action === "resume" && current === "paused") {
    return "approved";
  }
  if (action === "deprecate" && current !== "deprecated") {
    return "deprecated";
  }
  return undefined;
}

function nextEvidenceStatus(
  current: ExperienceCandidateStatus,
  supportCount: number,
  contradictionCount: number,
): ExperienceCandidateStatus {
  if (current === "deprecated" || current === "rejected") {
    return current;
  }
  if (supportCount === 0) {
    return "deprecated";
  }
  if (
    contradictionCount >= 2 &&
    contradictionCount >= supportCount
  ) {
    return "deprecated";
  }
  if (current === "active" && contradictionCount > 0) {
    return "paused";
  }
  return current;
}
