import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { AgentAppMessage } from "@omni-work/protocol-ts";

export interface LocalAgentMessageRecord {
  message: AgentAppMessage;
  received_at: string;
  read_at?: string;
  handled_at?: string;
  dismissed_at?: string;
}

export interface AgentMessageStore {
  initialize(): Promise<void>;
  saveMessage(message: AgentAppMessage): Promise<LocalAgentMessageRecord>;
  listMessages(limit?: number): Promise<LocalAgentMessageRecord[]>;
  markRead(messageId: string): Promise<LocalAgentMessageRecord | undefined>;
  markHandled(messageId: string): Promise<LocalAgentMessageRecord | undefined>;
  dismissMessage(messageId: string): Promise<LocalAgentMessageRecord | undefined>;
  dismissMessages(messageIds: string[]): Promise<void>;
  unreadCount(): Promise<number>;
}

const DB_NAME = "omniwork_agent_messages.db";
const STORAGE_KEY = "omniwork.agentMessages.v1";
const DEFAULT_LIMIT = 100;

export function createAgentMessageStore(): AgentMessageStore {
  if (Platform.OS === "web") {
    return new AsyncStorageAgentMessageStore();
  }
  return new SQLiteAgentMessageStore();
}

class SQLiteAgentMessageStore implements AgentMessageStore {
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const database = agentMessageDatabase();
    database.executeSync(
      `
        CREATE TABLE IF NOT EXISTS agent_messages (
          message_id TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL,
          provider TEXT,
          event_type TEXT,
          priority TEXT,
          workspace_id TEXT,
          workspace_path TEXT,
          session_id TEXT,
          surface_id TEXT,
          created_at TEXT NOT NULL,
          received_at TEXT NOT NULL,
          read_at TEXT,
          handled_at TEXT,
          dismissed_at TEXT
        )
      `,
    );
    ensureColumn(database, "workspace_path TEXT");
    database.executeSync(
      "CREATE INDEX IF NOT EXISTS idx_agent_messages_created_at ON agent_messages(created_at)",
    );
    database.executeSync(
      "CREATE INDEX IF NOT EXISTS idx_agent_messages_read_at ON agent_messages(read_at)",
    );
    database.executeSync(
      "CREATE INDEX IF NOT EXISTS idx_agent_messages_handled_at ON agent_messages(handled_at)",
    );
    database.executeSync(
      "CREATE INDEX IF NOT EXISTS idx_agent_messages_session_id ON agent_messages(session_id)",
    );
    this.initialized = true;
  }

  async saveMessage(message: AgentAppMessage): Promise<LocalAgentMessageRecord> {
    await this.initialize();
    const receivedAt = new Date().toISOString();
    agentMessageDatabase().executeSync(
      `
        INSERT INTO agent_messages (
          message_id,
          payload_json,
          provider,
          event_type,
          priority,
          workspace_id,
          workspace_path,
          session_id,
          surface_id,
          created_at,
          received_at,
          read_at,
          handled_at,
          dismissed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
        ON CONFLICT(message_id) DO UPDATE SET
          payload_json = excluded.payload_json,
          workspace_path = excluded.workspace_path
      `,
      [
        message.id,
        JSON.stringify(message),
        message.provider,
        message.message_kind,
        message.priority,
        message.workspace_id ?? null,
        message.workspace_path ?? null,
        message.session_id,
        message.surface_id ?? null,
        message.created_at,
        receivedAt,
      ],
    );
    return (
      (await this.getMessage(message.id)) ?? {
        message,
        received_at: receivedAt,
      }
    );
  }

  async listMessages(limit = DEFAULT_LIMIT): Promise<LocalAgentMessageRecord[]> {
    await this.initialize();
    const result = agentMessageDatabase().executeSync(
      `
        SELECT payload_json, received_at, read_at, handled_at, dismissed_at
        FROM agent_messages
        WHERE dismissed_at IS NULL
        ORDER BY created_at DESC, message_id DESC
        LIMIT ?
      `,
      [normalizeLimit(limit)],
    );
    return result.rows.flatMap(parseRow);
  }

  async markRead(
    messageId: string,
  ): Promise<LocalAgentMessageRecord | undefined> {
    await this.initialize();
    const readAt = new Date().toISOString();
    agentMessageDatabase().executeSync(
      "UPDATE agent_messages SET read_at = COALESCE(read_at, ?) WHERE message_id = ?",
      [readAt, messageId],
    );
    return this.getMessage(messageId);
  }

  async markHandled(
    messageId: string,
  ): Promise<LocalAgentMessageRecord | undefined> {
    await this.initialize();
    const now = new Date().toISOString();
    agentMessageDatabase().executeSync(
      `
        UPDATE agent_messages
        SET read_at = COALESCE(read_at, ?),
            handled_at = COALESCE(handled_at, ?)
        WHERE message_id = ?
      `,
      [now, now, messageId],
    );
    return this.getMessage(messageId);
  }

  async dismissMessage(
    messageId: string,
  ): Promise<LocalAgentMessageRecord | undefined> {
    await this.initialize();
    const dismissedAt = new Date().toISOString();
    agentMessageDatabase().executeSync(
      "UPDATE agent_messages SET dismissed_at = COALESCE(dismissed_at, ?) WHERE message_id = ?",
      [dismissedAt, messageId],
    );
    return this.getMessage(messageId);
  }

  async dismissMessages(messageIds: string[]): Promise<void> {
    await this.initialize();
    const ids = normalizeMessageIds(messageIds);
    if (!ids.length) {
      return;
    }
    const dismissedAt = new Date().toISOString();
    const placeholders = ids.map(() => "?").join(", ");
    agentMessageDatabase().executeSync(
      `UPDATE agent_messages SET dismissed_at = COALESCE(dismissed_at, ?) WHERE message_id IN (${placeholders})`,
      [dismissedAt, ...ids],
    );
  }

  async unreadCount(): Promise<number> {
    await this.initialize();
    const result = agentMessageDatabase().executeSync(
      "SELECT COUNT(*) AS count FROM agent_messages WHERE read_at IS NULL AND dismissed_at IS NULL",
    );
    const row = result.rows[0] as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  private async getMessage(
    messageId: string,
  ): Promise<LocalAgentMessageRecord | undefined> {
    const result = agentMessageDatabase().executeSync(
      `
        SELECT payload_json, received_at, read_at, handled_at, dismissed_at
        FROM agent_messages
        WHERE message_id = ?
      `,
      [messageId],
    );
    return result.rows.flatMap(parseRow)[0];
  }
}

class AsyncStorageAgentMessageStore implements AgentMessageStore {
  async initialize(): Promise<void> {
    return;
  }

  async saveMessage(message: AgentAppMessage): Promise<LocalAgentMessageRecord> {
    const records = await this.readAll();
    const existing = records.find((record) => record.message.id === message.id);
    if (existing) {
      existing.message = message;
      await this.writeAll(records);
      return existing;
    }
    const record: LocalAgentMessageRecord = {
      message,
      received_at: new Date().toISOString(),
    };
    await this.writeAll([record, ...records].slice(0, DEFAULT_LIMIT));
    return record;
  }

  async listMessages(limit = DEFAULT_LIMIT): Promise<LocalAgentMessageRecord[]> {
    return (await this.readAll())
      .filter((record) => !record.dismissed_at)
      .slice(0, normalizeLimit(limit));
  }

  async markRead(
    messageId: string,
  ): Promise<LocalAgentMessageRecord | undefined> {
    return this.update(messageId, (record) => ({
      ...record,
      read_at: record.read_at ?? new Date().toISOString(),
    }));
  }

  async markHandled(
    messageId: string,
  ): Promise<LocalAgentMessageRecord | undefined> {
    const now = new Date().toISOString();
    return this.update(messageId, (record) => ({
      ...record,
      read_at: record.read_at ?? now,
      handled_at: record.handled_at ?? now,
    }));
  }

  async dismissMessage(
    messageId: string,
  ): Promise<LocalAgentMessageRecord | undefined> {
    const dismissedAt = new Date().toISOString();
    return this.update(messageId, (record) => ({
      ...record,
      dismissed_at: record.dismissed_at ?? dismissedAt,
    }));
  }

  async dismissMessages(messageIds: string[]): Promise<void> {
    const ids = new Set(normalizeMessageIds(messageIds));
    if (!ids.size) {
      return;
    }
    const dismissedAt = new Date().toISOString();
    const records = await this.readAll();
    const nextRecords = records.map((record) =>
      ids.has(record.message.id)
        ? { ...record, dismissed_at: record.dismissed_at ?? dismissedAt }
        : record,
    );
    await this.writeAll(nextRecords);
  }

  async unreadCount(): Promise<number> {
    return (await this.readAll()).filter(
      (record) => !record.read_at && !record.dismissed_at,
    ).length;
  }

  private async update(
    messageId: string,
    updater: (record: LocalAgentMessageRecord) => LocalAgentMessageRecord,
  ): Promise<LocalAgentMessageRecord | undefined> {
    const records = await this.readAll();
    const index = records.findIndex((record) => record.message.id === messageId);
    if (index < 0) {
      return undefined;
    }
    const updated = updater(records[index]);
    records[index] = updated;
    await this.writeAll(records);
    return updated;
  }

  private async readAll(): Promise<LocalAgentMessageRecord[]> {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    try {
      return (JSON.parse(raw) as LocalAgentMessageRecord[]).filter(
        (record) => record?.message?.id,
      );
    } catch {
      return [];
    }
  }

  private async writeAll(records: LocalAgentMessageRecord[]): Promise<void> {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  }
}

type SQLiteParameter =
  | string
  | number
  | boolean
  | null
  | ArrayBuffer
  | ArrayBufferView;

interface SQLiteDatabase {
  executeSync(
    query: string,
    params?: SQLiteParameter[],
  ): {
    rows: unknown[];
  };
}

let nativeAgentMessageDatabase: SQLiteDatabase | undefined;

function agentMessageDatabase(): SQLiteDatabase {
  if (nativeAgentMessageDatabase) {
    return nativeAgentMessageDatabase;
  }
  const sqlite = require("@op-engineering/op-sqlite") as {
    open(options: { name: string; location?: string }): SQLiteDatabase;
    IOS_DOCUMENT_PATH?: string;
    ANDROID_FILES_PATH?: string;
  };
  const location =
    Platform.OS === "ios"
      ? sqlite.IOS_DOCUMENT_PATH
      : sqlite.ANDROID_FILES_PATH;
  nativeAgentMessageDatabase = sqlite.open({
    name: DB_NAME,
    location,
  });
  return nativeAgentMessageDatabase;
}

function ensureColumn(
  database: SQLiteDatabase,
  columnDefinition: string,
): void {
  try {
    database.executeSync(
      `ALTER TABLE agent_messages ADD COLUMN ${columnDefinition}`,
    );
  } catch {
    // Existing installs may already have the column.
  }
}

function parseRow(row: unknown): LocalAgentMessageRecord[] {
  const value = row as {
    payload_json?: string;
    received_at?: string;
    read_at?: string | null;
    handled_at?: string | null;
    dismissed_at?: string | null;
  };
  if (!value.payload_json || !value.received_at) {
    return [];
  }
  try {
    return [
      {
        message: JSON.parse(value.payload_json) as AgentAppMessage,
        received_at: value.received_at,
        read_at: value.read_at ?? undefined,
        handled_at: value.handled_at ?? undefined,
        dismissed_at: value.dismissed_at ?? undefined,
      },
    ];
  } catch {
    return [];
  }
}

function normalizeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(limit, 500);
}

function normalizeMessageIds(messageIds: string[]): string[] {
  return [...new Set(messageIds.filter(Boolean))];
}
