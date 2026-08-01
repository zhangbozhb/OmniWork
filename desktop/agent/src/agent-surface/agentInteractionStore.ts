import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AgentInteractionAnswerPayload,
  AgentInteractionRequestPayload,
  AgentInteractionResultPayload,
  AgentInteractionStatus,
  AgentInteractionSyncRequestPayload,
} from "@omni-work/protocol-ts";

interface InteractionRow {
  interaction_id: string;
  status: AgentInteractionStatus;
  request_payload: string;
  result_payload: string | null;
  client_action_id: string | null;
}

export type AgentInteractionResolveOutcome =
  | "resolved"
  | "duplicate"
  | "conflict"
  | "not_found";

export interface AgentInteractionResolveResult {
  outcome: AgentInteractionResolveOutcome;
  request?: AgentInteractionRequestPayload;
  result?: AgentInteractionResultPayload;
}

export class AgentInteractionStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_interactions (
        interaction_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        request_payload TEXT NOT NULL,
        result_payload TEXT,
        client_action_id TEXT UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_interactions_pending
      ON agent_interactions(status, session_id, surface_id, created_at)
    `);
    this.expirePendingAfterRestart();
  }

  create(
    request: AgentInteractionRequestPayload,
  ): AgentInteractionRequestPayload {
    this.db
      .prepare(
        `
          INSERT OR IGNORE INTO agent_interactions (
            interaction_id,
            session_id,
            surface_id,
            provider,
            status,
            request_payload,
            created_at,
            expires_at
          )
          VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
        `,
      )
      .run(
        request.interaction_id,
        request.session_id,
        request.surface_id,
        request.provider,
        JSON.stringify(request),
        request.created_at,
        request.expires_at,
      );
    return this.readRequest(request.interaction_id) ?? request;
  }

  listPending(
    filter: AgentInteractionSyncRequestPayload = { kind: "sync_request" },
  ): AgentInteractionRequestPayload[] {
    const rows = this.db
      .prepare(
        `
          SELECT interaction_id, status, request_payload, result_payload, client_action_id
          FROM agent_interactions
          WHERE status = 'pending'
            AND (? IS NULL OR session_id = ?)
            AND (? IS NULL OR surface_id = ?)
          ORDER BY created_at ASC, interaction_id ASC
          LIMIT 500
        `,
      )
      .all(
        filter.session_id ?? null,
        filter.session_id ?? null,
        filter.surface_id ?? null,
        filter.surface_id ?? null,
      ) as unknown as InteractionRow[];
    return rows.flatMap((row) => {
      const request = parseRequest(row.request_payload);
      return request ? [request] : [];
    });
  }

  resolve(
    answer: AgentInteractionAnswerPayload,
    resolvedAt = new Date().toISOString(),
  ): AgentInteractionResolveResult {
    const row = this.readRow(answer.interaction_id);
    if (!row) {
      return { outcome: "not_found" };
    }
    const request = parseRequest(row.request_payload);
    const existingResult = parseResult(row.result_payload);
    if (
      !request ||
      request.session_id !== answer.session_id ||
      request.surface_id !== answer.surface_id
    ) {
      return { outcome: "not_found" };
    }
    const actionRow = this.readRowByClientActionId(answer.client_action_id);
    if (
      actionRow &&
      actionRow.interaction_id !== answer.interaction_id
    ) {
      return { outcome: "conflict", request };
    }
    if (row.status !== "pending") {
      return {
        outcome:
          row.client_action_id === answer.client_action_id
            ? "duplicate"
            : "conflict",
        request,
        result: existingResult,
      };
    }

    const status =
      answer.decision === "decline" ? "declined" : "resolved";
    const result: AgentInteractionResultPayload = {
      kind: "result",
      interaction_id: request.interaction_id,
      session_id: request.session_id,
      surface_id: request.surface_id,
      status,
      client_action_id: answer.client_action_id,
      resolved_at: resolvedAt,
    };
    const update = this.db
      .prepare(
        `
          UPDATE agent_interactions
          SET status = ?,
              result_payload = ?,
              client_action_id = ?,
              resolved_at = ?
          WHERE interaction_id = ? AND status = 'pending'
        `,
      )
      .run(
        status,
        JSON.stringify(result),
        answer.client_action_id,
        resolvedAt,
        answer.interaction_id,
      );
    if (update.changes === 0) {
      return this.resolve(answer, resolvedAt);
    }
    return { outcome: "resolved", request, result };
  }

  expire(
    interactionId: string,
    message: string,
    resolvedAt = new Date().toISOString(),
  ): AgentInteractionResultPayload | undefined {
    return this.finishPending(
      interactionId,
      "expired",
      message,
      resolvedAt,
    );
  }

  cancel(
    interactionId: string,
    message: string,
    resolvedAt = new Date().toISOString(),
  ): AgentInteractionResultPayload | undefined {
    return this.finishPending(
      interactionId,
      "cancelled",
      message,
      resolvedAt,
    );
  }

  private finishPending(
    interactionId: string,
    status: "expired" | "cancelled",
    message: string,
    resolvedAt: string,
  ): AgentInteractionResultPayload | undefined {
    const row = this.readRow(interactionId);
    const request = row ? parseRequest(row.request_payload) : undefined;
    if (!request || row?.status !== "pending") {
      return parseResult(row?.result_payload ?? null);
    }
    const result: AgentInteractionResultPayload = {
      kind: "result",
      interaction_id: request.interaction_id,
      session_id: request.session_id,
      surface_id: request.surface_id,
      status,
      message,
      resolved_at: resolvedAt,
    };
    this.db
      .prepare(
        `
          UPDATE agent_interactions
          SET status = ?, result_payload = ?, resolved_at = ?
          WHERE interaction_id = ? AND status = 'pending'
        `,
      )
      .run(status, JSON.stringify(result), resolvedAt, interactionId);
    return result;
  }

  private readRequest(
    interactionId: string,
  ): AgentInteractionRequestPayload | undefined {
    const row = this.readRow(interactionId);
    return row ? parseRequest(row.request_payload) : undefined;
  }

  private readRow(interactionId: string): InteractionRow | undefined {
    return this.db
      .prepare(
        `
          SELECT interaction_id, status, request_payload, result_payload, client_action_id
          FROM agent_interactions
          WHERE interaction_id = ?
        `,
      )
      .get(interactionId) as unknown as InteractionRow | undefined;
  }

  private readRowByClientActionId(
    clientActionId: string,
  ): InteractionRow | undefined {
    return this.db
      .prepare(
        `
          SELECT interaction_id, status, request_payload, result_payload, client_action_id
          FROM agent_interactions
          WHERE client_action_id = ?
        `,
      )
      .get(clientActionId) as unknown as InteractionRow | undefined;
  }

  private expirePendingAfterRestart(): void {
    const rows = this.db
      .prepare(
        `
          SELECT interaction_id, status, request_payload, result_payload, client_action_id
          FROM agent_interactions
          WHERE status = 'pending'
        `,
      )
      .all() as unknown as InteractionRow[];
    for (const row of rows) {
      this.expire(
        row.interaction_id,
        "The Desktop Agent restarted before this request was answered.",
      );
    }
  }
}

function parseRequest(
  payload: string,
): AgentInteractionRequestPayload | undefined {
  try {
    return JSON.parse(payload) as AgentInteractionRequestPayload;
  } catch {
    return undefined;
  }
}

function parseResult(
  payload: string | null,
): AgentInteractionResultPayload | undefined {
  if (!payload) {
    return undefined;
  }
  try {
    return JSON.parse(payload) as AgentInteractionResultPayload;
  } catch {
    return undefined;
  }
}
