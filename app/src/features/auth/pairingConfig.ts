import { parsePairingLink } from "@omniwork/protocol-ts";
import { isValidSessionKey } from "./keyProof";
import type { PairingConfig } from "./types";

/**
 * 将外部 pairing link / 携带 pairing query 的 URL 转换为内部 PairingConfig。
 * 同时校验 session key 格式（32 字符 base64url），确保所有入口（deep link /
 * 初始 URL / 扫码 / 手动输入）共享一致的拒绝策略。
 */
export function parsePairingConfig(input: string): PairingConfig | null {
  const payload = parsePairingLink(input);
  if (!payload) {
    return null;
  }
  if (!isValidSessionKey(payload.key)) {
    return null;
  }

  return {
    relayUrl: payload.relay_url,
    deviceId: payload.device_id,
    displayName: payload.display_name?.trim() || undefined,
    key: payload.key,
    keyId: payload.key_id,
    appInstanceId: createAppInstanceId(),
  };
}

export function createAppInstanceId(): string {
  const random = Math.random().toString(36).slice(2, 12);
  return `app_${Date.now().toString(36)}_${random}`;
}
