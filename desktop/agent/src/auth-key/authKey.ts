import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, chmod, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppInfoPayload } from "@omni-work/protocol-ts";

export interface SessionKeyRecord {
  version: 1;
  key: string;
  created_at: string;
  relay_url?: string;
}

export interface CreateSessionKeyOptions {
  path: string;
  relayUrl?: string;
  now?: Date;
}

export async function createAndPersistSessionKey(
  options: CreateSessionKeyOptions,
): Promise<SessionKeyRecord> {
  const record: SessionKeyRecord = {
    version: 1,
    key: generateSessionKey(),
    created_at: (options.now ?? new Date()).toISOString(),
    relay_url: options.relayUrl,
  };

  await writeSessionKeyRecord(options.path, record);
  return record;
}

export function generateSessionKey(): string {
  return randomBytes(24).toString("base64url");
}

export function createAuthProofInput(
  nonce: string,
  appInfo: Pick<AppInfoPayload, "instance_id" | "runtime_id">,
): string {
  return [nonce, appInfo.instance_id, appInfo.runtime_id].join("\n");
}

export function createProof(
  key: string,
  nonce: string,
  appInfo: AppInfoPayload,
): string {
  return createHmac("sha256", key)
    .update(createAuthProofInput(nonce, appInfo))
    .digest("base64url");
}

export function verifyProof(
  key: string,
  nonce: string,
  appInfo: AppInfoPayload,
  proof: string,
): boolean {
  const expected = Buffer.from(
    createProof(key, nonce, appInfo),
    "utf8",
  );
  const received = Buffer.from(proof, "utf8");

  if (expected.byteLength !== received.byteLength) {
    return false;
  }

  return timingSafeEqual(expected, received);
}

export async function readSessionKeyRecord(
  path: string,
): Promise<SessionKeyRecord> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as SessionKeyRecord;
}

async function writeSessionKeyRecord(
  path: string,
  record: SessionKeyRecord,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path, 0o600);
}
