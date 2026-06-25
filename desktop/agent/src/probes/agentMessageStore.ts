import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AgentAppMessage,
  AgentMessageListRequestPayload,
  AgentNotificationSettingsPayload,
} from "@omniwork/protocol-ts";

interface MessageRow {
  message_id: string;
  payload: string;
}

interface SettingsRow {
  payload: string;
}

const DEFAULT_NOTIFICATION_SETTINGS: AgentNotificationSettingsPayload = {
  enabled: true,
  min_priority: "high",
  muted_providers: [],
  muted_message_kinds: [],
};

export class AgentMessageStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_app_messages (
        message_id TEXT PRIMARY KEY,
        event_key TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        surface_id TEXT,
        provider TEXT NOT NULL,
        message_kind TEXT NOT NULL,
        priority TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        read_at TEXT
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_notification_settings (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  insertMessage(
    eventKey: string,
    message: AgentAppMessage,
  ): AgentAppMessage | null {
    const result = this.db
      .prepare(
        `
          INSERT OR IGNORE INTO agent_app_messages (
            message_id,
            event_key,
            session_id,
            surface_id,
            provider,
            message_kind,
            priority,
            payload,
            created_at,
            read_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        message.id,
        eventKey,
        message.session_id,
        message.surface_id ?? null,
        message.provider,
        message.message_kind,
        message.priority,
        JSON.stringify(message),
        message.created_at,
        message.read_at ?? null,
      );
    return result.changes === 0 ? null : message;
  }

  list(filter: AgentMessageListRequestPayload = {}): AgentAppMessage[] {
    const rows = this.db
      .prepare(
        `
          SELECT message_id, payload
          FROM agent_app_messages
          ORDER BY created_at DESC, message_id DESC
          LIMIT 500
        `,
      )
      .all() as unknown as MessageRow[];
    const limit = normalizeLimit(filter.limit);
    return rows
      .flatMap((row) => {
        const message = parseMessage(row);
        return message ? [message] : [];
      })
      .filter((message) => {
        if (filter.session_id && message.session_id !== filter.session_id) {
          return false;
        }
        if (filter.surface_id && message.surface_id !== filter.surface_id) {
          return false;
        }
        if (filter.provider && message.provider !== filter.provider) {
          return false;
        }
        if (filter.unread_only && message.read_at) {
          return false;
        }
        return true;
      })
      .slice(0, limit);
  }

  read(messageId: string): AgentAppMessage | undefined {
    const row = this.db
      .prepare(
        "SELECT message_id, payload FROM agent_app_messages WHERE message_id = ?",
      )
      .get(messageId) as unknown as MessageRow | undefined;
    return row ? parseMessage(row) : undefined;
  }

  ack(messageId: string, read: boolean): AgentAppMessage | undefined {
    const message = this.read(messageId);
    if (!message) {
      return undefined;
    }
    if (read) {
      message.read_at = new Date().toISOString();
      this.db
        .prepare(
          `
            UPDATE agent_app_messages
            SET payload = ?, read_at = ?
            WHERE message_id = ?
          `,
        )
        .run(JSON.stringify(message), message.read_at, messageId);
    }
    return message;
  }

  getNotificationSettings(): AgentNotificationSettingsPayload {
    const row = this.db
      .prepare(
        "SELECT payload FROM agent_notification_settings WHERE id = 'default'",
      )
      .get() as unknown as SettingsRow | undefined;
    if (!row) {
      return { ...DEFAULT_NOTIFICATION_SETTINGS };
    }
    try {
      return normalizeNotificationSettings(
        JSON.parse(row.payload) as AgentNotificationSettingsPayload,
      );
    } catch {
      return { ...DEFAULT_NOTIFICATION_SETTINGS };
    }
  }

  setNotificationSettings(
    settings: AgentNotificationSettingsPayload,
  ): AgentNotificationSettingsPayload {
    const normalized = normalizeNotificationSettings(settings);
    this.db
      .prepare(
        `
          INSERT INTO agent_notification_settings (id, payload, updated_at)
          VALUES ('default', ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            payload = excluded.payload,
            updated_at = excluded.updated_at
        `,
      )
      .run(JSON.stringify(normalized), new Date().toISOString());
    return normalized;
  }
}

function parseMessage(row: MessageRow): AgentAppMessage | undefined {
  try {
    return JSON.parse(row.payload) as AgentAppMessage;
  } catch {
    return undefined;
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit) || limit === undefined || limit <= 0) {
    return 50;
  }
  return Math.min(limit, 100);
}

function normalizeNotificationSettings(
  settings: AgentNotificationSettingsPayload,
): AgentNotificationSettingsPayload {
  return {
    enabled: settings.enabled !== false,
    min_priority:
      settings.min_priority ?? DEFAULT_NOTIFICATION_SETTINGS.min_priority,
    muted_providers: settings.muted_providers ?? [],
    muted_message_kinds: settings.muted_message_kinds ?? [],
  };
}
