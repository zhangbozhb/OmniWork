import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AgentExperienceActivationSetPayload,
  ExperienceActivationSummary,
  ExperienceApplicationSummary,
  ExperienceShadowRunSummary,
  ExperienceShadowStats,
} from "@omni-work/protocol-ts";
import type { ExperienceCandidateStore } from "./experienceCandidateStore.ts";
import { initializeLearningSchema } from "./learningSchema.ts";

export const EXPERIENCE_MAX_ACTIVE_MATCHES = 2;
export const EXPERIENCE_MAX_INJECTED_BYTES = 4_096;

interface ActivationRow {
  project_id: string;
  requested_enabled: number;
  updated_at: string;
}

interface ActivationActionRow {
  client_action_id: string;
  project_id: string;
  enabled: number;
}

interface ApplicationRow {
  application_id: string;
  run_id: string;
  episode_id: string;
  project_id: string;
  candidate_ids: string;
  injected_bytes: number;
  created_at: string;
}

interface ShadowStatsReader {
  stats(input: { projectId?: string; sessionId?: string }): ExperienceShadowStats;
}

export type ExperienceActivationWriteResult =
  | {
      result: "applied" | "duplicate";
      activation: ExperienceActivationSummary;
    }
  | { result: "conflict" | "gate_not_ready" };

export interface ExperienceApplicationPreparation {
  prompt: string;
  application?: ExperienceApplicationSummary;
  updatedCandidateIds: string[];
}

export class ExperienceActivationStore {
  private readonly db: DatabaseSync;
  private readonly shadow: ShadowStatsReader;
  private readonly candidates: ExperienceCandidateStore;

  constructor(
    path: string,
    shadow: ShadowStatsReader,
    candidates: ExperienceCandidateStore,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.shadow = shadow;
    this.candidates = candidates;
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    initializeLearningSchema(this.db);
  }

  get(projectId: string): ExperienceActivationSummary {
    const row = this.db
      .prepare(
        `
          SELECT project_id, requested_enabled, updated_at
          FROM experience_activation_settings
          WHERE project_id = ?
        `,
      )
      .get(projectId) as unknown as ActivationRow | undefined;
    return activationSummary(
      projectId,
      row?.requested_enabled === 1,
      row?.updated_at,
      this.shadow.stats({ projectId }),
    );
  }

  list(input: {
    projectId?: string;
    sessionId?: string;
  } = {}): ExperienceActivationSummary[] {
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
          "SELECT project_id FROM experience_activation_settings",
        )
        .all() as unknown as Array<{ project_id: string }>;
      for (const row of rows) {
        projectIds.add(row.project_id);
      }
    }
    return [...projectIds].sort().map((projectId) => this.get(projectId));
  }

  setActivation(
    input: AgentExperienceActivationSetPayload,
  ): ExperienceActivationWriteResult {
    const existingAction = this.db
      .prepare(
        `
          SELECT client_action_id, project_id, enabled
          FROM experience_activation_actions
          WHERE client_action_id = ?
        `,
      )
      .get(input.client_action_id) as unknown as
      | ActivationActionRow
      | undefined;
    if (existingAction) {
      const sameAction =
        existingAction.project_id === input.project_id &&
        existingAction.enabled === (input.enabled ? 1 : 0);
      return sameAction
        ? {
            result: "duplicate",
            activation: this.get(existingAction.project_id),
          }
        : { result: "conflict" };
    }
    if (
      input.enabled &&
      !this.shadow.stats({ projectId: input.project_id }).activation_ready
    ) {
      return { result: "gate_not_ready" };
    }

    this.transaction(() => {
      this.db
        .prepare(
          `
            INSERT INTO experience_activation_actions (
              client_action_id,
              project_id,
              enabled,
              created_at
            )
            VALUES (?, ?, ?, ?)
          `,
        )
        .run(
          input.client_action_id,
          input.project_id,
          input.enabled ? 1 : 0,
          input.created_at,
        );
      this.db
        .prepare(
          `
            INSERT INTO experience_activation_settings (
              project_id,
              requested_enabled,
              updated_at
            )
            VALUES (?, ?, ?)
            ON CONFLICT(project_id) DO UPDATE SET
              requested_enabled = CASE
                WHEN experience_activation_settings.updated_at <= excluded.updated_at
                  THEN excluded.requested_enabled
                ELSE experience_activation_settings.requested_enabled
              END,
              updated_at = CASE
                WHEN experience_activation_settings.updated_at <= excluded.updated_at
                  THEN excluded.updated_at
                ELSE experience_activation_settings.updated_at
              END
          `,
        )
        .run(
          input.project_id,
          input.enabled ? 1 : 0,
          input.created_at,
        );
    });
    return {
      result: "applied",
      activation: this.get(input.project_id),
    };
  }

  prepareApplication(input: {
    run: ExperienceShadowRunSummary;
    prompt: string;
    createdAt: string;
  }): ExperienceApplicationPreparation {
    const activation = this.get(input.run.project_id);
    if (!activation.effective_enabled || input.run.matches.length === 0) {
      return { prompt: input.prompt, updatedCandidateIds: [] };
    }
    const eligible = new Map(
      this.candidates
        .listActivationEligible(input.run.project_id)
        .map((candidate) => [candidate.candidate_id, candidate]),
    );
    const selected = input.run.matches
      .map((match) => eligible.get(match.candidate_id))
      .filter((candidate) => candidate !== undefined)
      .slice(0, EXPERIENCE_MAX_ACTIVE_MATCHES);
    const injection = formatExperienceInjection(selected);
    if (!injection) {
      return { prompt: input.prompt, updatedCandidateIds: [] };
    }
    const prompt = `${injection}\n\n${input.prompt}`;
    const candidateIds = selected.map((candidate) => candidate.candidate_id);
    const applicationId = `application_${createHash("sha256")
      .update(input.run.run_id)
      .digest("hex")
      .slice(0, 24)}`;
    this.db
      .prepare(
        `
          INSERT OR IGNORE INTO experience_applications (
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
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        applicationId,
        input.run.run_id,
        input.run.episode_id,
        input.run.project_id,
        JSON.stringify(candidateIds),
        createHash("sha256").update(input.prompt).digest("hex"),
        createHash("sha256").update(prompt).digest("hex"),
        Buffer.byteLength(injection, "utf8"),
        input.createdAt,
      );
    this.candidates.markActive(candidateIds, input.createdAt);
    return {
      prompt,
      application: this.getApplication(applicationId),
      updatedCandidateIds: candidateIds,
    };
  }

  listApplications(input: {
    projectId?: string;
    sessionId?: string;
    limit?: number;
  } = {}): ExperienceApplicationSummary[] {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (input.projectId) {
      conditions.push("application.project_id = ?");
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
          SELECT application.*
          FROM experience_applications application
          JOIN delivery_episodes episode
            ON episode.episode_id = application.episode_id
          ${where}
          ORDER BY application.created_at DESC, application.application_id ASC
          LIMIT ?
        `,
      )
      .all(...values) as unknown as ApplicationRow[];
    return rows.flatMap((row) => {
      const application = toApplication(row);
      return application ? [application] : [];
    });
  }

  private getApplication(
    applicationId: string,
  ): ExperienceApplicationSummary | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM experience_applications WHERE application_id = ?",
      )
      .get(applicationId) as unknown as ApplicationRow | undefined;
    return row ? toApplication(row) : undefined;
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

function activationSummary(
  projectId: string,
  requestedEnabled: boolean,
  updatedAt: string | undefined,
  stats: ExperienceShadowStats,
): ExperienceActivationSummary {
  return {
    project_id: projectId,
    requested_enabled: requestedEnabled,
    effective_enabled: requestedEnabled && stats.activation_ready,
    activation_ready: stats.activation_ready,
    reviewed_matches: stats.reviewed_matches,
    relevance_rate: stats.relevance_rate,
    max_matches: EXPERIENCE_MAX_ACTIVE_MATCHES,
    max_injected_bytes: EXPERIENCE_MAX_INJECTED_BYTES,
    updated_at: updatedAt,
  };
}

export function formatExperienceInjection(
  candidates: readonly {
    trigger: string;
    guidance: string;
  }[],
): string | undefined {
  const header = [
    '<project_experience scope="local" mode="approved">',
    "Apply only the relevant project guidance below. The guidance was explicitly reviewed for this project.",
  ];
  const footer = ["</project_experience>"];
  const entries: string[] = [];
  for (const candidate of candidates.slice(0, EXPERIENCE_MAX_ACTIVE_MATCHES)) {
    const entry = [
      "<experience>",
      `<applies_when>${escapeXml(candidate.trigger)}</applies_when>`,
      `<recommended_action>${escapeXml(candidate.guidance)}</recommended_action>`,
      "</experience>",
    ].join("\n");
    const next = [...header, ...entries, entry, ...footer].join("\n");
    if (Buffer.byteLength(next, "utf8") <= EXPERIENCE_MAX_INJECTED_BYTES) {
      entries.push(entry);
    }
  }
  return entries.length > 0
    ? [...header, ...entries, ...footer].join("\n")
    : undefined;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function toApplication(
  row: ApplicationRow,
): ExperienceApplicationSummary | undefined {
  try {
    const candidateIds = JSON.parse(row.candidate_ids) as unknown;
    if (
      !Array.isArray(candidateIds) ||
      !candidateIds.every((value) => typeof value === "string")
    ) {
      return undefined;
    }
    return {
      application_id: row.application_id,
      run_id: row.run_id,
      episode_id: row.episode_id,
      project_id: row.project_id,
      candidate_ids: candidateIds,
      injected_bytes: row.injected_bytes,
      created_at: row.created_at,
    };
  } catch {
    return undefined;
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit) || (limit ?? 0) <= 0) {
    return 100;
  }
  return Math.min(limit as number, 100);
}
