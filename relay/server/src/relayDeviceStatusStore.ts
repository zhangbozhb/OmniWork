import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type RelayPersistedDeviceStatus = "online" | "degraded" | "offline";
export type RelayPersistedCloseRole = "agent" | "mobile";

export interface RelayPersistedDeviceStatusRecord {
  device_id: string;
  status: RelayPersistedDeviceStatus;
  first_seen_at: number;
  last_seen_at: number;
  offline_at?: number;
  last_agent_instance_id?: string;
  last_agent_remote_ip?: string;
  last_app_remote_ip?: string;
  last_close_role?: RelayPersistedCloseRole;
  last_close_reason?: string;
  bytes_in: number;
  bytes_out: number;
  messages_in: number;
  messages_out: number;
  updated_at: number;
}

export interface RelayDeviceStatusUpsert {
  deviceId: string;
  status: RelayPersistedDeviceStatus;
  seenAt: number;
  offlineAt?: number;
  lastAgentInstanceId?: string;
  lastAgentRemoteIp?: string;
  lastAppRemoteIp?: string;
  lastCloseRole?: RelayPersistedCloseRole;
  lastCloseReason?: string;
}

export interface RelayDeviceTrafficDelta {
  bytesIn: number;
  bytesOut: number;
  messagesIn: number;
  messagesOut: number;
}

interface RelayDeviceStatusRow {
  device_id: string;
  status: RelayPersistedDeviceStatus;
  first_seen_at: number;
  last_seen_at: number;
  offline_at: number | null;
  last_agent_instance_id: string | null;
  last_agent_remote_ip: string | null;
  last_app_remote_ip: string | null;
  last_close_role: RelayPersistedCloseRole | null;
  last_close_reason: string | null;
  bytes_in: number;
  bytes_out: number;
  messages_in: number;
  messages_out: number;
  updated_at: number;
}

export class RelayDeviceStatusStore {
  private readonly path: string;
  private db: DatabaseSync | null = null;

  constructor(path: string) {
    this.path = path;
  }

  upsert(input: RelayDeviceStatusUpsert): void {
    const db = this.open();
    db.prepare(
      `
        INSERT INTO relay_device_status (
          device_id,
          status,
          first_seen_at,
          last_seen_at,
          offline_at,
          last_agent_instance_id,
          last_agent_remote_ip,
          last_app_remote_ip,
          last_close_role,
          last_close_reason,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          status = excluded.status,
          last_seen_at = excluded.last_seen_at,
          offline_at = excluded.offline_at,
          last_agent_instance_id = COALESCE(excluded.last_agent_instance_id, relay_device_status.last_agent_instance_id),
          last_agent_remote_ip = COALESCE(excluded.last_agent_remote_ip, relay_device_status.last_agent_remote_ip),
          last_app_remote_ip = COALESCE(excluded.last_app_remote_ip, relay_device_status.last_app_remote_ip),
          last_close_role = COALESCE(excluded.last_close_role, relay_device_status.last_close_role),
          last_close_reason = COALESCE(excluded.last_close_reason, relay_device_status.last_close_reason),
          updated_at = excluded.updated_at
      `,
    ).run(
      input.deviceId,
      input.status,
      input.seenAt,
      input.seenAt,
      input.offlineAt ?? null,
      input.lastAgentInstanceId ?? null,
      input.lastAgentRemoteIp ?? null,
      input.lastAppRemoteIp ?? null,
      input.lastCloseRole ?? null,
      input.lastCloseReason ?? null,
      input.seenAt,
    );
  }

  addTraffic(deviceId: string, delta: RelayDeviceTrafficDelta, now = Date.now()): void {
    this.open()
      .prepare(
        `
          UPDATE relay_device_status SET
            bytes_in = bytes_in + ?,
            bytes_out = bytes_out + ?,
            messages_in = messages_in + ?,
            messages_out = messages_out + ?,
            last_seen_at = MAX(last_seen_at, ?),
            updated_at = ?
          WHERE device_id = ?
        `,
      )
      .run(
        delta.bytesIn,
        delta.bytesOut,
        delta.messagesIn,
        delta.messagesOut,
        now,
        now,
        deviceId,
      );
  }

  list(options: { includeOffline: boolean; limit: number }): RelayPersistedDeviceStatusRecord[] {
    const rows = this.open()
      .prepare(
        `
          SELECT
            device_id,
            status,
            first_seen_at,
            last_seen_at,
            offline_at,
            last_agent_instance_id,
            last_agent_remote_ip,
            last_app_remote_ip,
            last_close_role,
            last_close_reason,
            bytes_in,
            bytes_out,
            messages_in,
            messages_out,
            updated_at
          FROM relay_device_status
          WHERE ? OR status != 'offline'
          ORDER BY last_seen_at DESC, device_id ASC
          LIMIT ?
        `,
      )
      .all(options.includeOffline ? 1 : 0, options.limit) as unknown as RelayDeviceStatusRow[];
    return rows.map(rowToRecord);
  }

  summary(): {
    known_device_count: number;
    offline_device_count: number;
  } {
    const rows = this.open()
      .prepare(
        `
          SELECT
            COUNT(*) AS known_device_count,
            SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) AS offline_device_count
          FROM relay_device_status
        `,
      )
      .get() as { known_device_count: number; offline_device_count: number | null };
    return {
      known_device_count: rows.known_device_count,
      offline_device_count: rows.offline_device_count ?? 0,
    };
  }

  pruneOffline(cutoff: number): number {
    const result = this.open()
      .prepare(
        `
          DELETE FROM relay_device_status
          WHERE status = 'offline'
            AND offline_at IS NOT NULL
            AND offline_at < ?
        `,
      )
      .run(cutoff);
    return Number(result.changes ?? 0);
  }

  private open(): DatabaseSync {
    if (this.db) {
      return this.db;
    }

    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS relay_device_status (
        device_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        offline_at INTEGER,
        last_agent_instance_id TEXT,
        last_agent_remote_ip TEXT,
        last_app_remote_ip TEXT,
        last_close_role TEXT,
        last_close_reason TEXT,
        bytes_in INTEGER NOT NULL DEFAULT 0,
        bytes_out INTEGER NOT NULL DEFAULT 0,
        messages_in INTEGER NOT NULL DEFAULT 0,
        messages_out INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `);
    this.db = db;
    return db;
  }
}

function rowToRecord(row: RelayDeviceStatusRow): RelayPersistedDeviceStatusRecord {
  return {
    device_id: row.device_id,
    status: row.status,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    offline_at: row.offline_at ?? undefined,
    last_agent_instance_id: row.last_agent_instance_id ?? undefined,
    last_agent_remote_ip: row.last_agent_remote_ip ?? undefined,
    last_app_remote_ip: row.last_app_remote_ip ?? undefined,
    last_close_role: row.last_close_role ?? undefined,
    last_close_reason: row.last_close_reason ?? undefined,
    bytes_in: row.bytes_in,
    bytes_out: row.bytes_out,
    messages_in: row.messages_in,
    messages_out: row.messages_out,
    updated_at: row.updated_at,
  };
}
