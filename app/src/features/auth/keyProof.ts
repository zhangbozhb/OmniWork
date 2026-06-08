import { createHmacSha256Base64Url } from "./hmacSha256.ts";
import type { AppInfoPayload } from "@omniwork/protocol-ts";

export async function createKeyProof(
  key: string,
  nonce: string,
  appInfo: AppInfoPayload,
): Promise<string> {
  return createHmacSha256Base64Url(
    key,
    createAuthProofInput(nonce, appInfo),
  );
}

export function createAuthProofInput(
  nonce: string,
  appInfo: Pick<AppInfoPayload, "instance_id" | "runtime_id">,
): string {
  return [nonce, appInfo.instance_id, appInfo.runtime_id].join("\n");
}

export function isValidSessionKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(value);
}
