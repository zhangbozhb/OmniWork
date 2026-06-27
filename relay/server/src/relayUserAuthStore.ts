import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface RelayAuthUser {
  id: string;
  email: string;
  created_at: number;
  last_login_at?: number;
  disabled_at?: number;
}

export interface RelayAuthSession {
  id: string;
  user_id: string;
  token: string;
  expires_at: number;
}

export interface RelayAuthDevice {
  id: string;
  user_id: string;
  name?: string;
  public_key: string;
  created_at: number;
  last_seen_at?: number;
  revoked_at?: number;
}

interface EmailLinkRow {
  id: string;
  email: string;
  token_hash: string;
  expires_at: number;
  consumed_at: number | null;
  request_ip: string | null;
  created_at: number;
}

interface EnrollmentRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
}

export class RelayUserAuthStore {
  private readonly path: string;
  private db: DatabaseSync | null = null;

  constructor(path: string) {
    this.path = path;
  }

  createEmailLink(input: {
    email: string;
    ttlMs: number;
    requestIp?: string;
    now?: number;
  }): { token: string; expiresAt: number } {
    const now = input.now ?? Date.now();
    const token = createToken();
    const expiresAt = now + input.ttlMs;
    this.open()
      .prepare(
        `
          INSERT INTO auth_email_links (
            id, email, token_hash, expires_at, request_ip, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        randomUUID(),
        normalizeEmail(input.email),
        tokenHash(token),
        expiresAt,
        input.requestIp ?? null,
        now,
      );
    return { token, expiresAt };
  }

  consumeEmailLink(token: string, now = Date.now()): RelayAuthUser | null {
    const db = this.open();
    const row = db
      .prepare(
        `
          SELECT id, email, token_hash, expires_at, consumed_at, request_ip, created_at
          FROM auth_email_links
          WHERE token_hash = ?
        `,
      )
      .get(tokenHash(token)) as EmailLinkRow | undefined;
    if (!row || row.consumed_at || row.expires_at <= now) {
      return null;
    }

    const email = normalizeEmail(row.email);
    let user = this.findUserByEmail(email);
    if (!user) {
      const userId = `usr_${randomUUID()}`;
      db.prepare(
        `
          INSERT INTO users (id, email, created_at, last_login_at)
          VALUES (?, ?, ?, ?)
        `,
      ).run(userId, email, now, now);
      user = {
        id: userId,
        email,
        created_at: now,
        last_login_at: now,
      };
    } else {
      db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(
        now,
        user.id,
      );
      user = { ...user, last_login_at: now };
    }
    db.prepare(
      "UPDATE auth_email_links SET consumed_at = ? WHERE id = ?",
    ).run(now, row.id);
    return user;
  }

  createSession(input: {
    userId: string;
    ttlMs: number;
    now?: number;
  }): RelayAuthSession {
    const now = input.now ?? Date.now();
    const token = createToken();
    const session: RelayAuthSession = {
      id: `ses_${randomUUID()}`,
      user_id: input.userId,
      token,
      expires_at: now + input.ttlMs,
    };
    this.open()
      .prepare(
        `
          INSERT INTO auth_sessions (
            id, user_id, token_hash, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(
        session.id,
        session.user_id,
        tokenHash(token),
        session.expires_at,
        now,
      );
    return session;
  }

  authenticateSession(token: string | undefined, now = Date.now()): RelayAuthUser | null {
    if (!token) {
      return null;
    }
    const row = this.open()
      .prepare(
        `
          SELECT users.id, users.email, users.created_at, users.last_login_at, users.disabled_at
          FROM auth_sessions
          JOIN users ON users.id = auth_sessions.user_id
          WHERE auth_sessions.token_hash = ?
            AND auth_sessions.revoked_at IS NULL
            AND auth_sessions.expires_at > ?
            AND users.disabled_at IS NULL
        `,
      )
      .get(tokenHash(token), now) as RelayAuthUser | undefined;
    return row ?? null;
  }

  revokeSession(token: string | undefined, now = Date.now()): void {
    if (!token) {
      return;
    }
    this.open()
      .prepare(
        "UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?",
      )
      .run(now, tokenHash(token));
  }

  createDeviceEnrollment(input: {
    userId: string;
    ttlMs: number;
    now?: number;
  }): { token: string; expiresAt: number } {
    const now = input.now ?? Date.now();
    const token = createToken();
    const expiresAt = now + input.ttlMs;
    this.open()
      .prepare(
        `
          INSERT INTO device_enrollments (
            id, user_id, token_hash, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(
        `enr_${randomUUID()}`,
        input.userId,
        tokenHash(token),
        expiresAt,
        now,
      );
    return { token, expiresAt };
  }

  consumeDeviceEnrollment(input: {
    token: string;
    name?: string;
    publicKey: string;
    maxDevicesPerUser: number;
    now?: number;
  }): RelayAuthDevice | null {
    const now = input.now ?? Date.now();
    const db = this.open();
    const row = db
      .prepare(
        `
          SELECT id, user_id, token_hash, expires_at, consumed_at, created_at
          FROM device_enrollments
          WHERE token_hash = ?
        `,
      )
      .get(tokenHash(input.token)) as EnrollmentRow | undefined;
    if (!row || row.consumed_at || row.expires_at <= now) {
      return null;
    }
    const count = db
      .prepare(
        "SELECT COUNT(*) AS count FROM devices WHERE user_id = ? AND revoked_at IS NULL",
      )
      .get(row.user_id) as { count: number };
    if (count.count >= input.maxDevicesPerUser) {
      return null;
    }
    const device: RelayAuthDevice = {
      id: `dev_${randomUUID()}`,
      user_id: row.user_id,
      name: input.name,
      public_key: input.publicKey,
      created_at: now,
    };
    db.prepare(
      `
        INSERT INTO devices (id, user_id, name, public_key, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
    ).run(
      device.id,
      device.user_id,
      device.name ?? null,
      device.public_key,
      device.created_at,
    );
    db.prepare(
      "UPDATE device_enrollments SET consumed_at = ? WHERE id = ?",
    ).run(now, row.id);
    return device;
  }

  getDevice(deviceId: string): RelayAuthDevice | null {
    const row = this.open()
      .prepare(
        `
          SELECT id, user_id, name, public_key, created_at, last_seen_at, revoked_at
          FROM devices
          WHERE id = ?
        `,
      )
      .get(deviceId) as RelayAuthDevice | undefined;
    return row ?? null;
  }

  listDevices(userId: string): RelayAuthDevice[] {
    return this.open()
      .prepare(
        `
          SELECT id, user_id, name, public_key, created_at, last_seen_at, revoked_at
          FROM devices
          WHERE user_id = ?
          ORDER BY created_at DESC
        `,
      )
      .all(userId) as unknown as RelayAuthDevice[];
  }

  revokeDevice(deviceId: string, userId: string, now = Date.now()): boolean {
    const result = this.open()
      .prepare(
        `
          UPDATE devices
          SET revoked_at = ?
          WHERE id = ? AND user_id = ? AND revoked_at IS NULL
        `,
      )
      .run(now, deviceId, userId);
    return Number(result.changes ?? 0) > 0;
  }

  markDeviceSeen(deviceId: string, now = Date.now()): void {
    this.open()
      .prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?")
      .run(now, deviceId);
  }

  rememberNonce(deviceId: string, nonce: string, ttlMs: number, now = Date.now()): boolean {
    const expiresAt = now + ttlMs;
    try {
      this.open()
        .prepare(
          `
            INSERT INTO agent_auth_nonces (device_id, nonce, expires_at)
            VALUES (?, ?, ?)
          `,
        )
        .run(deviceId, nonce, expiresAt);
      return true;
    } catch {
      return false;
    }
  }

  sweep(now = Date.now()): void {
    const db = this.open();
    db.prepare("DELETE FROM auth_email_links WHERE expires_at < ?").run(now);
    db.prepare("DELETE FROM device_enrollments WHERE expires_at < ?").run(now);
    db.prepare("DELETE FROM agent_auth_nonces WHERE expires_at < ?").run(now);
    db.prepare(
      "DELETE FROM auth_sessions WHERE expires_at < ? OR revoked_at IS NOT NULL",
    ).run(now);
  }

  countRecentEmailLinksByEmail(email: string, since: number): number {
    const row = this.open()
      .prepare(
        "SELECT COUNT(*) AS count FROM auth_email_links WHERE email = ? AND created_at >= ?",
      )
      .get(normalizeEmail(email), since) as { count: number };
    return row.count;
  }

  countRecentEmailLinksByIp(ip: string, since: number): number {
    const row = this.open()
      .prepare(
        "SELECT COUNT(*) AS count FROM auth_email_links WHERE request_ip = ? AND created_at >= ?",
      )
      .get(ip, since) as { count: number };
    return row.count;
  }

  private findUserByEmail(email: string): RelayAuthUser | null {
    const row = this.open()
      .prepare(
        "SELECT id, email, created_at, last_login_at, disabled_at FROM users WHERE email = ?",
      )
      .get(normalizeEmail(email)) as RelayAuthUser | undefined;
    return row ?? null;
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
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER,
        disabled_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS auth_email_links (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        request_ip TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS auth_email_links_email_created_idx
        ON auth_email_links(email, created_at);
      CREATE INDEX IF NOT EXISTS auth_email_links_ip_created_idx
        ON auth_email_links(request_ip, created_at);
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT,
        public_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS devices_user_idx ON devices(user_id);
      CREATE TABLE IF NOT EXISTS device_enrollments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_auth_nonces (
        device_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (device_id, nonce)
      );
    `);
    this.db = db;
    return db;
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function createToken(): string {
  return randomBytes(32).toString("base64url");
}
