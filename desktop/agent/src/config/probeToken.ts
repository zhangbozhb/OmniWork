import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

interface ProbeTokenRecord {
  version: 1;
  token: string;
  createdAt: string;
}

export function resolveProbeToken(path: string, configured?: string): string {
  if (configured) {
    if (!isValidProbeToken(configured)) {
      throw new Error(
        "OMNIWORK_AGENT_PROBE_TOKEN must be at least 32 characters.",
      );
    }
    writeProbeToken(path, {
      version: 1,
      token: configured,
      createdAt: new Date().toISOString(),
    });
    return configured;
  }
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ProbeTokenRecord;
    if (!isProbeTokenRecord(parsed)) {
      throw new Error(`Probe token at ${path} is invalid.`);
    }
    return parsed.token;
  }
  const record: ProbeTokenRecord = {
    version: 1,
    token: randomBytes(32).toString("base64url"),
    createdAt: new Date().toISOString(),
  };
  writeProbeToken(path, record);
  return record.token;
}

function writeProbeToken(path: string, record: ProbeTokenRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function isProbeTokenRecord(value: unknown): value is ProbeTokenRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.token === "string" &&
    isValidProbeToken(record.token) &&
    typeof record.createdAt === "string"
  );
}

function isValidProbeToken(value: string): boolean {
  return value.length >= 32;
}
