import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, chmod, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface SessionKeyRecord {
  version: 1;
  key: string;
  key_id: string;
  created_at: string;
  agent_instance_id: string;
  relay_url?: string;
}

export interface CreateSessionKeyOptions {
  path: string;
  agentInstanceId: string;
  relayUrl?: string;
  now?: Date;
}

export async function createAndPersistSessionKey(
  options: CreateSessionKeyOptions,
): Promise<SessionKeyRecord> {
  const record: SessionKeyRecord = {
    version: 1,
    key: generateSessionKey(),
    key_id: "",
    created_at: (options.now ?? new Date()).toISOString(),
    agent_instance_id: options.agentInstanceId,
    relay_url: options.relayUrl,
  };
  record.key_id = createKeyId(record.key);

  await writeSessionKeyRecord(options.path, record);
  return record;
}

export function generateSessionKey(): string {
  return randomBytes(24).toString("base64url");
}

export function createAgentInstanceId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `agent_${stamp}_${randomBytes(4).toString("hex")}`;
}

export function createKeyId(key: string): string {
  return `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

export function createProof(key: string, nonce: string): string {
  return createHmac("sha256", key).update(nonce).digest("base64url");
}

export function verifyProof(key: string, nonce: string, proof: string): boolean {
  const expected = Buffer.from(createProof(key, nonce), "utf8");
  const received = Buffer.from(proof, "utf8");

  if (expected.byteLength !== received.byteLength) {
    return false;
  }

  return timingSafeEqual(expected, received);
}

export async function readSessionKeyRecord(path: string): Promise<SessionKeyRecord> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as SessionKeyRecord;
}

async function writeSessionKeyRecord(path: string, record: SessionKeyRecord): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600);
}
