import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AgentProbeEvent,
  AgentSurfaceEventPayload,
} from "@omni-work/protocol-ts";
import { initializeLearningSchema } from "./learningSchema.ts";

export type AgentObservationKind = "probe" | "surface";

export interface AgentObservation {
  cursor: number;
  observationKey: string;
  correlationKey: string;
  kind: AgentObservationKind;
  projectId?: string;
  sessionId: string;
  surfaceId?: string;
  provider: string;
  eventType: string;
  sourceKind?: string;
  workspacePath?: string;
  payload: AgentProbeEvent | AgentSurfaceEventPayload;
  createdAt: string;
}

interface ObservationRow {
  cursor: number;
  observation_key: string;
  correlation_key: string;
  kind: AgentObservationKind;
  project_id: string | null;
  session_id: string;
  surface_id: string | null;
  provider: string;
  event_type: string;
  source_kind: string | null;
  workspace_path: string | null;
  payload: string;
  created_at: string;
}

export class AgentObservationStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    initializeLearningSchema(this.db);
  }

  putProbeEvent(event: AgentProbeEvent): AgentObservation {
    return this.put({
      observationKey: `probe:${event.provider}:${event.probe_id}:${event.id}`,
      correlationKey: correlationKey(
        event.provider,
        event.session_id,
        event.surface_id,
        event.id,
      ),
      kind: "probe",
      projectId: projectIdForPath(event.workspace_path),
      sessionId: event.session_id,
      surfaceId: event.surface_id,
      provider: event.provider,
      eventType: event.event_type,
      sourceKind: event.source.kind,
      workspacePath: event.workspace_path,
      payload: event,
      createdAt: event.created_at,
    });
  }

  putSurfaceEvent(
    event: AgentSurfaceEventPayload,
    workspacePath?: string,
  ): AgentObservation {
    return this.put({
      observationKey: `surface:${event.provider}:${event.surface_id}:${event.event_id}`,
      correlationKey: correlationKey(
        event.provider,
        event.session_id,
        event.surface_id,
        event.event_id,
      ),
      kind: "surface",
      projectId: projectIdForPath(workspacePath),
      sessionId: event.session_id,
      surfaceId: event.surface_id,
      provider: event.provider,
      eventType: event.event_type,
      sourceKind: event.source?.kind,
      workspacePath,
      payload: event,
      createdAt: event.created_at,
    });
  }

  listBySession(
    sessionId: string,
    afterCursor = 0,
    requestedLimit = 500,
  ): AgentObservation[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM agent_observations
          WHERE session_id = ? AND cursor > ?
          ORDER BY cursor ASC
          LIMIT ?
        `,
      )
      .all(
        sessionId,
        normalizeCursor(afterCursor),
        normalizeLimit(requestedLimit),
      ) as unknown as ObservationRow[];
    return rows.flatMap((row) => {
      const observation = parseObservation(row);
      return observation ? [observation] : [];
    });
  }

  private put(
    observation: Omit<AgentObservation, "cursor">,
  ): AgentObservation {
    this.db
      .prepare(
        `
          INSERT INTO agent_observations (
            observation_key,
            correlation_key,
            kind,
            project_id,
            session_id,
            surface_id,
            provider,
            event_type,
            source_kind,
            workspace_path,
            payload,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(observation_key) DO UPDATE SET
            correlation_key = excluded.correlation_key,
            project_id = COALESCE(excluded.project_id, agent_observations.project_id),
            session_id = excluded.session_id,
            surface_id = COALESCE(excluded.surface_id, agent_observations.surface_id),
            event_type = excluded.event_type,
            source_kind = COALESCE(excluded.source_kind, agent_observations.source_kind),
            workspace_path = COALESCE(excluded.workspace_path, agent_observations.workspace_path),
            payload = excluded.payload,
            created_at = excluded.created_at
        `,
      )
      .run(
        observation.observationKey,
        observation.correlationKey,
        observation.kind,
        observation.projectId ?? null,
        observation.sessionId,
        observation.surfaceId ?? null,
        observation.provider,
        observation.eventType,
        observation.sourceKind ?? null,
        observation.workspacePath ?? null,
        JSON.stringify(observation.payload),
        observation.createdAt,
      );
    const row = this.db
      .prepare(
        "SELECT * FROM agent_observations WHERE observation_key = ?",
      )
      .get(observation.observationKey) as unknown as
      | ObservationRow
      | undefined;
    const stored = row ? parseObservation(row) : undefined;
    if (!stored) {
      throw new Error("Agent observation could not be read after writing");
    }
    return stored;
  }
}

export function projectIdForPath(
  workspacePath: string | undefined,
): string | undefined {
  if (!workspacePath?.trim()) {
    return undefined;
  }
  const normalized = resolve(workspacePath).replace(/\/+$/u, "") || "/";
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function correlationKey(
  provider: string,
  sessionId: string,
  surfaceId: string | undefined,
  eventId: string,
): string {
  return [provider, sessionId, surfaceId ?? "", eventId].join(":");
}

function parseObservation(row: ObservationRow): AgentObservation | undefined {
  try {
    return {
      cursor: row.cursor,
      observationKey: row.observation_key,
      correlationKey: row.correlation_key,
      kind: row.kind,
      projectId: row.project_id ?? undefined,
      sessionId: row.session_id,
      surfaceId: row.surface_id ?? undefined,
      provider: row.provider,
      eventType: row.event_type,
      sourceKind: row.source_kind ?? undefined,
      workspacePath: row.workspace_path ?? undefined,
      payload: JSON.parse(row.payload) as
        | AgentProbeEvent
        | AgentSurfaceEventPayload,
      createdAt: row.created_at,
    };
  } catch {
    return undefined;
  }
}

function normalizeCursor(cursor: number): number {
  return Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
}

function normalizeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    return 500;
  }
  return Math.min(limit, 2_000);
}
