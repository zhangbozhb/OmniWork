import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AgentSurfaceEventPayload } from "@omni-work/protocol-ts";

interface EventRow {
  cursor: number;
  payload: string;
}

export interface AgentSurfaceEventPage {
  events: AgentSurfaceEventPayload[];
  nextCursor: number;
  hasMore: boolean;
}

export class AgentSurfaceEventStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_surface_events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(surface_id, event_id)
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_surface_events_sync
      ON agent_surface_events(surface_id, cursor)
    `);
  }

  put(event: AgentSurfaceEventPayload): number {
    // REPLACE assigns a new cursor so clients that already consumed an earlier
    // revision of the same event still receive the updated payload.
    this.db
      .prepare(
        `
          INSERT OR REPLACE INTO agent_surface_events (
            session_id,
            surface_id,
            event_id,
            payload,
            created_at
          )
          VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(
        event.session_id,
        event.surface_id,
        event.event_id,
        JSON.stringify(event),
        event.created_at,
      );
    const row = this.db
      .prepare(
        `
          SELECT cursor
          FROM agent_surface_events
          WHERE surface_id = ? AND event_id = ?
        `,
      )
      .get(event.surface_id, event.event_id) as
      | { cursor: number }
      | undefined;
    if (!row) {
      throw new Error("Agent surface event was not persisted");
    }
    return row.cursor;
  }

  list(
    sessionId: string,
    surfaceId: string,
    afterCursor = 0,
    requestedLimit = 100,
  ): AgentSurfaceEventPage {
    const limit = normalizeLimit(requestedLimit);
    const rows = this.db
      .prepare(
        `
          SELECT cursor, payload
          FROM agent_surface_events
          WHERE session_id = ? AND surface_id = ? AND cursor > ?
          ORDER BY cursor ASC
          LIMIT ?
        `,
      )
      .all(
        sessionId,
        surfaceId,
        normalizeCursor(afterCursor),
        limit + 1,
      ) as unknown as EventRow[];
    const pageRows = rows.slice(0, limit);
    const parsedRows = pageRows.flatMap((row) => {
      const event = parseEvent(row.payload);
      return event ? [{ cursor: row.cursor, event }] : [];
    });
    return {
      events: parsedRows.map((row) => row.event),
      nextCursor:
        pageRows.length > 0
          ? pageRows[pageRows.length - 1]!.cursor
          : normalizeCursor(afterCursor),
      hasMore: rows.length > limit,
    };
  }
}

function parseEvent(payload: string): AgentSurfaceEventPayload | undefined {
  try {
    return JSON.parse(payload) as AgentSurfaceEventPayload;
  } catch {
    return undefined;
  }
}

function normalizeCursor(cursor: number): number {
  return Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
}

function normalizeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    return 100;
  }
  return Math.min(limit, 500);
}
