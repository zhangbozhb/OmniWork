import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  identityMatchesPublicKey,
  type AppAuthorizationScope,
  type AppClientPlatform,
} from "@omni-work/protocol-ts";

export interface TrustedAppRecord {
  appId: string;
  publicKey: string;
  displayName?: string;
  platform?: AppClientPlatform;
  scopes: AppAuthorizationScope[];
  status: "active" | "revoked";
  approvedAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

interface TrustedAppFile {
  version: 1;
  apps: TrustedAppRecord[];
}

export class TrustedAppStore {
  private readonly path: string;
  private readonly records = new Map<string, TrustedAppRecord>();

  constructor(path: string) {
    this.path = path;
    this.load();
  }

  get(appId: string): TrustedAppRecord | null {
    const record = this.records.get(appId);
    return record ? structuredClone(record) : null;
  }

  list(): TrustedAppRecord[] {
    return [...this.records.values()]
      .map((record) => structuredClone(record))
      .sort((left, right) => left.appId.localeCompare(right.appId));
  }

  approve(input: {
    appId: string;
    publicKey: string;
    displayName?: string;
    platform?: AppClientPlatform;
    scopes: AppAuthorizationScope[];
    now?: Date;
  }): TrustedAppRecord {
    if (!identityMatchesPublicKey("app", input.appId, input.publicKey)) {
      throw new Error("App identity does not match its public key.");
    }
    const now = (input.now ?? new Date()).toISOString();
    const record: TrustedAppRecord = {
      appId: input.appId,
      publicKey: input.publicKey,
      displayName: input.displayName,
      platform: input.platform,
      scopes: [...new Set(input.scopes)],
      status: "active",
      approvedAt: now,
      lastSeenAt: now,
    };
    this.records.set(record.appId, record);
    this.persist();
    return structuredClone(record);
  }

  markSeen(appId: string, now = new Date()): void {
    const record = this.records.get(appId);
    if (!record || record.status !== "active") {
      return;
    }
    record.lastSeenAt = now.toISOString();
    this.persist();
  }

  revoke(appId: string, now = new Date()): boolean {
    const record = this.records.get(appId);
    if (!record || record.status === "revoked") {
      return false;
    }
    record.status = "revoked";
    record.revokedAt = now.toISOString();
    this.persist();
    return true;
  }

  remove(appId: string): boolean {
    if (!this.records.delete(appId)) {
      return false;
    }
    this.persist();
    return true;
  }

  private load(): void {
    if (!existsSync(this.path)) {
      return;
    }
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as TrustedAppFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.apps)) {
      throw new Error(`Trusted App store at ${this.path} is invalid.`);
    }
    for (const record of parsed.apps) {
      if (!isTrustedAppRecord(record)) {
        throw new Error(`Trusted App store at ${this.path} is invalid.`);
      }
      this.records.set(record.appId, record);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.path), 0o700);
    const temporary = `${this.path}.${process.pid}.tmp`;
    const file: TrustedAppFile = {
      version: 1,
      apps: [...this.records.values()],
    };
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }
}

function isTrustedAppRecord(value: unknown): value is TrustedAppRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<TrustedAppRecord>;
  return (
    typeof record.appId === "string" &&
    typeof record.publicKey === "string" &&
    identityMatchesPublicKey("app", record.appId, record.publicKey) &&
    (record.status === "active" || record.status === "revoked") &&
    (record.displayName === undefined ||
      typeof record.displayName === "string") &&
    (record.platform === undefined ||
      ["ios", "android", "web", "desktop"].includes(record.platform)) &&
    Array.isArray(record.scopes) &&
    record.scopes.length > 0 &&
    record.scopes.every((scope) => scope === "device.control") &&
    typeof record.approvedAt === "string" &&
    Number.isFinite(Date.parse(record.approvedAt)) &&
    (record.lastSeenAt === undefined ||
      (typeof record.lastSeenAt === "string" &&
        Number.isFinite(Date.parse(record.lastSeenAt)))) &&
    (record.revokedAt === undefined ||
      (typeof record.revokedAt === "string" &&
        Number.isFinite(Date.parse(record.revokedAt))))
  );
}
