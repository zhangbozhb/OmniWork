import { createHmacSha256Base64Url } from "./hmacSha256.ts";

export async function createKeyProof(key: string, nonce: string): Promise<string> {
  return createHmacSha256Base64Url(key, nonce);
}

export function isValidSessionKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(value);
}
