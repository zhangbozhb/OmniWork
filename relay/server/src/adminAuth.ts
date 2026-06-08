import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

export interface RelayAdminAuthConfig {
  tokenDir: string;
  tokenRotateMs: number;
  sessionTtlMs: number;
  requireHttps: boolean;
  trustProxy: boolean;
  trustedProxyIps: Set<string>;
}

export interface RelayAdminSession {
  id: string;
  csrfToken: string;
  expiresAt: number;
}

const TOKEN_FILE_NAME = "admin-token.json";
const SESSION_COOKIE_NAME = "ow_relay_admin_session";
const TOKEN_LENGTH = 64;

interface CurrentToken {
  value: string;
  createdAt: number;
  expiresAt: number;
}

export class RelayAdminAuth {
  private readonly config: RelayAdminAuthConfig;
  private currentToken: CurrentToken | null = null;
  private rotateTimer: ReturnType<typeof setInterval> | null = null;
  private readonly sessions = new Map<string, RelayAdminSession>();

  constructor(config: RelayAdminAuthConfig) {
    this.config = config;
  }

  start(): void {
    this.rotateToken(Date.now());
    this.rotateTimer = setInterval(() => {
      this.rotateToken(Date.now());
      this.pruneSessions(Date.now());
    }, this.config.tokenRotateMs);
    this.rotateTimer.unref?.();
  }

  stop(): void {
    if (this.rotateTimer) {
      clearInterval(this.rotateTimer);
      this.rotateTimer = null;
    }
  }

  login(token: string, now = Date.now()): RelayAdminSession | null {
    this.pruneSessions(now);
    if (!this.verifyCurrentToken(token, now)) {
      return null;
    }

    this.currentToken = null;
    this.rotateToken(now);
    const session = this.createSession(now);
    this.sessions.set(session.id, session);
    return session;
  }

  authenticate(
    request: IncomingMessage,
    now = Date.now(),
  ): RelayAdminSession | null {
    this.pruneSessions(now);
    const sessionId = readCookie(request, SESSION_COOKIE_NAME);
    if (!sessionId) {
      return null;
    }

    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt <= now) {
      this.sessions.delete(sessionId);
      return null;
    }
    return session;
  }

  logout(request: IncomingMessage): void {
    const sessionId = readCookie(request, SESSION_COOKIE_NAME);
    if (sessionId) {
      this.sessions.delete(sessionId);
    }
  }

  sessionCookie(session: RelayAdminSession): string {
    const parts = [
      `${SESSION_COOKIE_NAME}=${session.id}`,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/admin",
      `Max-Age=${Math.floor(this.config.sessionTtlMs / 1000)}`,
    ];
    if (this.config.requireHttps) {
      parts.splice(2, 0, "Secure");
    }
    return parts.join("; ");
  }

  clearSessionCookie(): string {
    const parts = [
      `${SESSION_COOKIE_NAME}=`,
      "HttpOnly",
      "SameSite=Strict",
      "Path=/admin",
      "Max-Age=0",
    ];
    if (this.config.requireHttps) {
      parts.splice(2, 0, "Secure");
    }
    return parts.join("; ");
  }

  isHttps(request: IncomingMessage): boolean {
    const socketWithTls = request.socket as IncomingMessage["socket"] & {
      encrypted?: boolean;
    };
    if (socketWithTls.encrypted) {
      return true;
    }

    if (!this.config.trustProxy) {
      return false;
    }

    const remoteAddress = normalizeIp(request.socket.remoteAddress ?? "");
    if (!this.config.trustedProxyIps.has(remoteAddress)) {
      return false;
    }

    const forwardedProto = request.headers["x-forwarded-proto"];
    const value = Array.isArray(forwardedProto)
      ? forwardedProto[0]
      : forwardedProto;
    return value?.split(",")[0]?.trim().toLowerCase() === "https";
  }

  tokenPath(): string {
    return join(this.config.tokenDir, TOKEN_FILE_NAME);
  }

  private verifyCurrentToken(token: string, now: number): boolean {
    const current = this.currentToken;
    if (!current || current.expiresAt <= now) {
      return false;
    }
    if (token.length !== TOKEN_LENGTH) {
      return false;
    }
    return safeEqual(token, current.value);
  }

  private createSession(now: number): RelayAdminSession {
    return {
      id: randomBytes(32).toString("hex"),
      csrfToken: randomBytes(32).toString("hex"),
      expiresAt: now + this.config.sessionTtlMs,
    };
  }

  private rotateToken(now: number): void {
    mkdirSync(this.config.tokenDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.config.tokenDir, 0o700);
    } catch {
      // Best effort: chmod may fail on filesystems that do not support POSIX modes.
    }

    const token: CurrentToken = {
      value: randomBytes(32).toString("hex"),
      createdAt: now,
      expiresAt: now + this.config.tokenRotateMs,
    };
    const body = `${JSON.stringify(
      {
        token: token.value,
        created_at: token.createdAt,
        expires_at: token.expiresAt,
        rotate_ms: this.config.tokenRotateMs,
        usage: "one_time_login",
      },
      null,
      2,
    )}\n`;
    const target = this.tokenPath();
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;

    writeFileSync(temporary, body, { mode: 0o600 });
    try {
      chmodSync(temporary, 0o600);
    } catch {
      // Best effort for non-POSIX filesystems.
    }
    renameSync(temporary, target);
    this.currentToken = token;
  }

  private pruneSessions(now: number): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(sessionId);
      }
    }
  }
}

export function normalizeIp(ip: string): string {
  if (ip.startsWith("::ffff:")) {
    return ip.slice("::ffff:".length);
  }
  return ip;
}

export function removeAdminTokenFile(tokenDir: string): void {
  rmSync(join(tokenDir, TOKEN_FILE_NAME), { force: true });
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function readCookie(
  request: IncomingMessage,
  name: string,
): string | undefined {
  const cookie = request.headers.cookie;
  if (!cookie) {
    return undefined;
  }
  for (const part of cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return undefined;
}
