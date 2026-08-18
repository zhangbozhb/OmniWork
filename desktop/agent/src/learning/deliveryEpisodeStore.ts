import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AgentDeliveryOutcomeSetPayload,
  DeliveryEpisodeStatus,
  DeliveryOutcome,
  DeliveryOutcomeSource,
  DeliveryEpisodeSummary,
  DeliverySignalKind,
  DeliverySignalSummary,
} from "@omni-work/protocol-ts";
import type { AgentObservation } from "./agentObservationStore.ts";
import { initializeLearningSchema } from "./learningSchema.ts";

export interface DeliveryEpisode {
  episodeId: string;
  projectId?: string;
  sessionId: string;
  surfaceId?: string;
  provider?: string;
  status: DeliveryEpisodeStatus;
  outcome?: DeliveryOutcome;
  outcomeSource?: DeliveryOutcomeSource;
  outcomeNote?: string;
  objective?: string;
  finalResponse?: string;
  startedAt: string;
  deliveredAt?: string;
  outcomeAt?: string;
  updatedAt: string;
  observationCount: number;
  lastObservationCursor: number;
}

interface EpisodeRow {
  episode_id: string;
  project_id: string | null;
  session_id: string;
  surface_id: string | null;
  provider: string | null;
  status: DeliveryEpisodeStatus;
  outcome: DeliveryOutcome | null;
  outcome_source: DeliveryOutcomeSource | null;
  outcome_note: string | null;
  objective: string | null;
  final_response: string | null;
  started_at: string;
  delivered_at: string | null;
  outcome_at: string | null;
  updated_at: string;
  observation_count: number;
  last_observation_cursor: number;
}

interface OutcomeRow {
  client_action_id: string;
  episode_id: string;
  outcome: DeliveryOutcome;
  source: DeliveryOutcomeSource;
  note: string | null;
}

interface SignalRow {
  signal_id: string;
  episode_id: string;
  kind: DeliverySignalKind;
  source: DeliverySignalSummary["source"];
  observation_key: string;
  created_at: string;
}

export type DeliveryOutcomeWriteResult =
  | { result: "applied" | "duplicate"; episode: DeliveryEpisode }
  | { result: "not_found" | "invalid_state" | "conflict" };

export class DeliveryEpisodeStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    initializeLearningSchema(this.db);
  }

  apply(observation: AgentObservation): DeliveryEpisode | undefined {
    const linked = this.findByObservation(observation.observationKey);
    if (linked) {
      this.updateEpisode(linked.episodeId, observation, false);
      return this.get(linked.episodeId);
    }
    if (observation.eventType === "agent.user_prompt_submitted") {
      return this.start(observation);
    }
    const active = this.findWorking(scopeKey(observation));
    if (!active) {
      return undefined;
    }
    this.updateEpisode(active.episodeId, observation, true);
    return this.get(active.episodeId);
  }

  get(episodeId: string): DeliveryEpisode | undefined {
    const row = this.db
      .prepare("SELECT * FROM delivery_episodes WHERE episode_id = ?")
      .get(episodeId) as unknown as EpisodeRow | undefined;
    return row ? toEpisode(row) : undefined;
  }

  listBySession(sessionId: string): DeliveryEpisode[] {
    return (
      this.db
        .prepare(
          `
            SELECT *
            FROM delivery_episodes
            WHERE session_id = ?
            ORDER BY started_at ASC, episode_id ASC
          `,
        )
        .all(sessionId) as unknown as EpisodeRow[]
    ).map(toEpisode);
  }

  list(input: {
    sessionId?: string;
    surfaceId?: string;
    limit?: number;
  } = {}): DeliveryEpisode[] {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (input.sessionId) {
      conditions.push("session_id = ?");
      values.push(input.sessionId);
    }
    if (input.surfaceId) {
      conditions.push("surface_id = ?");
      values.push(input.surfaceId);
    }
    values.push(normalizeEpisodeLimit(input.limit));
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return (
      this.db
        .prepare(
          `
            SELECT *
            FROM delivery_episodes
            ${where}
            ORDER BY started_at DESC, episode_id DESC
            LIMIT ?
          `,
        )
        .all(...values) as unknown as EpisodeRow[]
    ).map(toEpisode);
  }

  listWithOutcomes(): DeliveryEpisode[] {
    return (
      this.db
        .prepare(
          `
            SELECT *
            FROM delivery_episodes
            WHERE outcome IS NOT NULL
            ORDER BY outcome_at ASC, episode_id ASC
          `,
        )
        .all() as unknown as EpisodeRow[]
    ).map(toEpisode);
  }

  findWorkingForSurface(
    sessionId: string,
    surfaceId: string | undefined,
  ): DeliveryEpisode | undefined {
    return this.findWorking([sessionId, surfaceId ?? ""].join(":"));
  }

  recordGitReviewRevision(
    observation: AgentObservation,
  ): DeliveryEpisode | undefined {
    if (!isGitReviewPrompt(observation)) {
      return undefined;
    }
    const episode = this.findLatestDelivered(
      scopeKey(observation),
      observation.createdAt,
    );
    if (!episode) {
      return undefined;
    }
    const signal = signalForObservation(
      episode.episodeId,
      observation,
      "review_revision_requested",
      "git_review",
    );
    this.transaction(() => {
      this.upsertSignal(signal);
      this.db
        .prepare(
          `
            INSERT OR IGNORE INTO delivery_episode_outcomes (
              client_action_id,
              episode_id,
              outcome,
              source,
              note,
              created_at
            )
            VALUES (?, ?, 'revision_requested', 'git_review', ?, ?)
          `,
        )
        .run(
          `inferred:${signal.signal_id}`,
          episode.episodeId,
          "Git review notes were submitted for a revision pass.",
          observation.createdAt,
        );
      this.db
        .prepare(
          `
            UPDATE delivery_episodes
            SET
              outcome = CASE
                WHEN outcome_source IS NULL OR outcome_source = 'git_review'
                  THEN 'revision_requested'
                ELSE outcome
              END,
              outcome_source = CASE
                WHEN outcome_source IS NULL OR outcome_source = 'git_review'
                  THEN 'git_review'
                ELSE outcome_source
              END,
              outcome_note = CASE
                WHEN outcome_source IS NULL OR outcome_source = 'git_review'
                  THEN ?
                ELSE outcome_note
              END,
              outcome_at = CASE
                WHEN (outcome_source IS NULL OR outcome_source = 'git_review')
                  AND (outcome_at IS NULL OR outcome_at <= ?)
                  THEN ?
                ELSE outcome_at
              END,
              updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
            WHERE episode_id = ?
          `,
        )
        .run(
          "Git review notes were submitted for a revision pass.",
          observation.createdAt,
          observation.createdAt,
          observation.createdAt,
          observation.createdAt,
          episode.episodeId,
        );
    });
    return this.get(episode.episodeId);
  }

  setOutcome(
    input: AgentDeliveryOutcomeSetPayload,
  ): DeliveryOutcomeWriteResult {
    const existingAction = this.db
      .prepare(
        `
          SELECT client_action_id, episode_id, outcome, source, note
          FROM delivery_episode_outcomes
          WHERE client_action_id = ?
        `,
      )
      .get(input.client_action_id) as unknown as OutcomeRow | undefined;
    if (existingAction) {
      const sameAction =
        existingAction.episode_id === input.episode_id &&
        existingAction.outcome === input.outcome &&
        existingAction.source === "user" &&
        (existingAction.note ?? undefined) === normalizeNote(input.note);
      const episode = this.get(existingAction.episode_id);
      return sameAction && episode
        ? { result: "duplicate", episode }
        : { result: "conflict" };
    }

    const episode = this.get(input.episode_id);
    if (
      !episode ||
      episode.sessionId !== input.session_id ||
      episode.surfaceId !== input.surface_id
    ) {
      return { result: "not_found" };
    }
    if (episode.status !== "delivered") {
      return { result: "invalid_state" };
    }

    const note = normalizeNote(input.note);
    this.transaction(() => {
      this.db
        .prepare(
          `
            INSERT INTO delivery_episode_outcomes (
              client_action_id,
              episode_id,
              outcome,
              source,
              note,
              created_at
            )
            VALUES (?, ?, ?, 'user', ?, ?)
          `,
        )
        .run(
          input.client_action_id,
          input.episode_id,
          input.outcome,
          note ?? null,
          input.created_at,
        );
      this.db
        .prepare(
          `
            UPDATE delivery_episodes
            SET
              outcome = ?,
              outcome_source = 'user',
              outcome_note = ?,
              outcome_at = ?,
              updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
            WHERE episode_id = ?
              AND (outcome_at IS NULL OR outcome_at <= ?)
          `,
        )
        .run(
          input.outcome,
          note ?? null,
          input.created_at,
          input.created_at,
          input.created_at,
          input.episode_id,
          input.created_at,
        );
    });
    return {
      result: "applied",
      episode: this.get(input.episode_id) as DeliveryEpisode,
    };
  }

  toSummary(episode: DeliveryEpisode): DeliveryEpisodeSummary {
    return {
      episode_id: episode.episodeId,
      project_id: episode.projectId,
      session_id: episode.sessionId,
      surface_id: episode.surfaceId,
      provider: episode.provider,
      status: episode.status,
      outcome: episode.outcome,
      outcome_source: episode.outcomeSource,
      outcome_note: episode.outcomeNote,
      objective: episode.objective,
      final_response: episode.finalResponse,
      started_at: episode.startedAt,
      delivered_at: episode.deliveredAt,
      outcome_at: episode.outcomeAt,
      updated_at: episode.updatedAt,
      observation_count: episode.observationCount,
      signals: this.signals(episode.episodeId),
    };
  }

  signals(episodeId: string): DeliverySignalSummary[] {
    return (
      this.db
        .prepare(
          `
            SELECT *
            FROM delivery_episode_signals
            WHERE episode_id = ?
            ORDER BY created_at ASC, signal_id ASC
          `,
        )
        .all(episodeId) as unknown as SignalRow[]
    ).map(toSignalSummary);
  }

  observationKeys(episodeId: string): string[] {
    return (
      this.db
        .prepare(
          `
            SELECT observation_key
            FROM delivery_episode_observations
            WHERE episode_id = ?
            ORDER BY observation_cursor ASC
          `,
        )
        .all(episodeId) as unknown as Array<{ observation_key: string }>
    ).map((row) => row.observation_key);
  }

  private start(observation: AgentObservation): DeliveryEpisode {
    const episodeId = createEpisodeId(observation.observationKey);
    const scope = scopeKey(observation);
    const objective = readObjective(observation);
    this.transaction(() => {
      this.db
        .prepare(
          `
            UPDATE delivery_episodes
            SET status = 'abandoned', updated_at = ?
            WHERE scope_key = ? AND status = 'working'
          `,
        )
        .run(observation.createdAt, scope);
      this.db
        .prepare(
          `
            INSERT INTO delivery_episodes (
              episode_id,
              scope_key,
              project_id,
              session_id,
              surface_id,
              provider,
              status,
              objective,
              started_at,
              updated_at,
              observation_count,
              last_observation_cursor
            )
            VALUES (?, ?, ?, ?, ?, NULL, 'working', ?, ?, ?, 1, ?)
          `,
        )
        .run(
          episodeId,
          scope,
          observation.projectId ?? null,
          observation.sessionId,
          observation.surfaceId ?? null,
          objective ?? null,
          observation.createdAt,
          observation.createdAt,
          observation.cursor,
        );
      this.insertObservation(episodeId, observation);
    });
    return this.get(episodeId) as DeliveryEpisode;
  }

  private updateEpisode(
    episodeId: string,
    observation: AgentObservation,
    attach: boolean,
  ): void {
    const terminalStatus = readTerminalStatus(observation);
    const finalResponse = readFinalResponse(observation);
    const objective =
      observation.eventType === "agent.user_prompt_submitted"
        ? readObjective(observation)
        : undefined;
    const signalKind = readTestSignalKind(observation);
    const signal = signalKind
      ? signalForObservation(
          episodeId,
          observation,
          signalKind,
          "agent_observation",
        )
      : undefined;
    let inserted = false;
    this.transaction(() => {
      if (attach) {
        inserted = this.insertObservation(episodeId, observation);
      }
      if (signal) {
        this.upsertSignal(signal);
      }
      this.db
        .prepare(
          `
            UPDATE delivery_episodes
            SET
              project_id = COALESCE(project_id, ?),
              provider = CASE WHEN ? <> 'user' THEN ? ELSE provider END,
              status = CASE
                WHEN status = 'working' THEN COALESCE(?, status)
                ELSE status
              END,
              objective = COALESCE(?, objective),
              final_response = COALESCE(?, final_response),
              delivered_at = CASE
                WHEN status = 'working' AND ? IS NOT NULL
                  THEN COALESCE(delivered_at, ?)
                ELSE delivered_at
              END,
              updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END,
              observation_count = observation_count + ?,
              last_observation_cursor = MAX(last_observation_cursor, ?)
            WHERE episode_id = ?
          `,
        )
        .run(
          observation.projectId ?? null,
          observation.provider,
          observation.provider,
          terminalStatus ?? null,
          objective ?? null,
          finalResponse ?? null,
          terminalStatus ?? null,
          observation.createdAt,
          observation.createdAt,
          observation.createdAt,
          inserted ? 1 : 0,
          observation.cursor,
          episodeId,
        );
    });
  }

  private insertObservation(
    episodeId: string,
    observation: AgentObservation,
  ): boolean {
    const result = this.db
      .prepare(
        `
          INSERT OR IGNORE INTO delivery_episode_observations (
            episode_id,
            observation_key,
            observation_cursor,
            event_type,
            created_at
          )
          VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(
        episodeId,
        observation.observationKey,
        observation.cursor,
        observation.eventType,
        observation.createdAt,
      );
    return result.changes > 0;
  }

  private findWorking(scope: string): DeliveryEpisode | undefined {
    const row = this.db
      .prepare(
        `
          SELECT *
          FROM delivery_episodes
          WHERE scope_key = ? AND status = 'working'
          ORDER BY started_at DESC
          LIMIT 1
        `,
      )
      .get(scope) as unknown as EpisodeRow | undefined;
    return row ? toEpisode(row) : undefined;
  }

  private findLatestDelivered(
    scope: string,
    beforeOrAt: string,
  ): DeliveryEpisode | undefined {
    const row = this.db
      .prepare(
        `
          SELECT *
          FROM delivery_episodes
          WHERE scope_key = ?
            AND status = 'delivered'
            AND started_at <= ?
          ORDER BY delivered_at DESC, started_at DESC, episode_id DESC
          LIMIT 1
        `,
      )
      .get(scope, beforeOrAt) as unknown as EpisodeRow | undefined;
    return row ? toEpisode(row) : undefined;
  }

  private upsertSignal(signal: SignalRow): void {
    this.db
      .prepare(
        `
          INSERT INTO delivery_episode_signals (
            signal_id,
            episode_id,
            kind,
            source,
            observation_key,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(observation_key) DO UPDATE SET
            kind = excluded.kind,
            source = excluded.source,
            created_at = excluded.created_at
        `,
      )
      .run(
        signal.signal_id,
        signal.episode_id,
        signal.kind,
        signal.source,
        signal.observation_key,
        signal.created_at,
      );
  }

  private findByObservation(
    observationKey: string,
  ): DeliveryEpisode | undefined {
    const row = this.db
      .prepare(
        `
          SELECT episodes.*
          FROM delivery_episodes episodes
          JOIN delivery_episode_observations observations
            ON observations.episode_id = episodes.episode_id
          WHERE observations.observation_key = ?
        `,
      )
      .get(observationKey) as unknown as EpisodeRow | undefined;
    return row ? toEpisode(row) : undefined;
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

function scopeKey(observation: AgentObservation): string {
  return [observation.sessionId, observation.surfaceId ?? ""].join(":");
}

function createEpisodeId(observationKey: string): string {
  return `episode_${createHash("sha256")
    .update(observationKey)
    .digest("hex")
    .slice(0, 24)}`;
}

function readObjective(observation: AgentObservation): string | undefined {
  const payload = eventPayload(observation);
  return readString(payload.prompt) ?? readString(observation.payload.summary);
}

function isGitReviewPrompt(observation: AgentObservation): boolean {
  return (
    observation.eventType === "agent.user_prompt_submitted" &&
    eventPayload(observation).prompt_origin === "git_review"
  );
}

function readTestSignalKind(
  observation: AgentObservation,
): "test_passed" | "test_failed" | undefined {
  if (
    observation.eventType !== "agent.tool_call_finished" &&
    observation.eventType !== "agent.failed"
  ) {
    return undefined;
  }
  const payload = eventPayload(observation);
  const item = isRecord(payload.item) ? payload.item : undefined;
  const itemType = readString(item?.type);
  if (itemType !== "command_execution" && itemType !== "commandExecution") {
    return undefined;
  }
  const command =
    readString(item?.command) ?? readString(observation.payload.summary);
  if (!command || !isTestCommand(command)) {
    return undefined;
  }
  const exitCode = readNumber(item?.exit_code) ?? readNumber(item?.exitCode);
  const failed =
    observation.eventType === "agent.failed" ||
    item?.status === "failed" ||
    (exitCode !== undefined && exitCode !== 0);
  return failed ? "test_failed" : "test_passed";
}

function isTestCommand(command: string): boolean {
  return /(?:^|&&|\|\||;)\s*(?:(?:pnpm|npm|yarn|bun)(?:\s+\S+)*?\s+(?:run\s+)?test(?:\s|$)|pytest(?:\s|$)|python(?:3)?\s+-m\s+pytest(?:\s|$)|go\s+test(?:\s|$)|cargo\s+test(?:\s|$)|mvn(?:w)?(?:\s+\S+)*\s+test(?:\s|$)|gradle(?:w)?(?:\s+\S+)*\s+test(?:\s|$)|swift\s+test(?:\s|$)|xcodebuild(?:\s+\S+)*\s+test(?:\s|$)|ctest(?:\s|$)|make\s+test(?:\s|$))/iu.test(
    command,
  );
}

function signalForObservation(
  episodeId: string,
  observation: AgentObservation,
  kind: DeliverySignalKind,
  source: DeliverySignalSummary["source"],
): SignalRow {
  return {
    signal_id: `delivery_signal_${createHash("sha256")
      .update(observation.observationKey)
      .digest("hex")
      .slice(0, 24)}`,
    episode_id: episodeId,
    kind,
    source,
    observation_key: observation.observationKey,
    created_at: observation.createdAt,
  };
}

function readFinalResponse(
  observation: AgentObservation,
): string | undefined {
  const payload = eventPayload(observation);
  const item = isRecord(payload.item) ? payload.item : undefined;
  const isAssistant =
    payload.message_role === "assistant" ||
    item?.type === "agent_message" ||
    readHookName(payload) === "Stop";
  if (!isAssistant) {
    return undefined;
  }
  return (
    readString(payload.last_assistant_message) ??
    readString(payload.model_response) ??
    readString(item?.text) ??
    readString(payload.message) ??
    readString(observation.payload.summary)
  );
}

function readTerminalStatus(
  observation: AgentObservation,
): DeliveryEpisodeStatus | undefined {
  if (observation.eventType === "agent.exited") {
    return "abandoned";
  }
  const payload = eventPayload(observation);
  const hookName = readHookName(payload);
  const rawEventId = observation.payload.source?.raw_event_id ?? "";
  const title = observation.payload.title ?? "";
  const type = readString(payload.type);
  const strongTerminal =
    hookName === "Stop" ||
    /^turn:.*:completed$/u.test(rawEventId) ||
    /:result$/u.test(rawEventId) ||
    type === "result" ||
    /\bturn (completed|failed)$/iu.test(title);
  if (!strongTerminal) {
    return undefined;
  }
  return observation.eventType === "agent.failed" ? "failed" : "delivered";
}

function readHookName(payload: Record<string, unknown>): string | undefined {
  const value =
    readString(payload.hook_event_name) ??
    readString(payload.omniwork_hook_event);
  if (!value) {
    return undefined;
  }
  return value.toLowerCase() === "stop" ? "Stop" : value;
}

function eventPayload(
  observation: AgentObservation,
): Record<string, unknown> {
  return isRecord(observation.payload.payload)
    ? observation.payload.payload
    : {};
}

function toEpisode(row: EpisodeRow): DeliveryEpisode {
  return {
    episodeId: row.episode_id,
    projectId: row.project_id ?? undefined,
    sessionId: row.session_id,
    surfaceId: row.surface_id ?? undefined,
    provider: row.provider ?? undefined,
    status: row.status,
    outcome: row.outcome ?? undefined,
    outcomeSource: row.outcome_source ?? undefined,
    outcomeNote: row.outcome_note ?? undefined,
    objective: row.objective ?? undefined,
    finalResponse: row.final_response ?? undefined,
    startedAt: row.started_at,
    deliveredAt: row.delivered_at ?? undefined,
    outcomeAt: row.outcome_at ?? undefined,
    updatedAt: row.updated_at,
    observationCount: row.observation_count,
    lastObservationCursor: row.last_observation_cursor,
  };
}

function toSignalSummary(row: SignalRow): DeliverySignalSummary {
  return {
    signal_id: row.signal_id,
    kind: row.kind,
    source: row.source,
    observation_key: row.observation_key,
    created_at: row.created_at,
  };
}

function normalizeEpisodeLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit) || (limit ?? 0) <= 0) {
    return 100;
  }
  return Math.min(limit as number, 200);
}

function normalizeNote(note: string | undefined): string | undefined {
  const trimmed = note?.trim();
  return trimmed || undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
