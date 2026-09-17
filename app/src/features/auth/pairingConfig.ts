import {
  normalizeIdentityId,
  parsePairingLink,
} from "@omni-work/protocol-ts";
import type { PairingConfig } from "./types";

export function parsePairingConfig(input: string): PairingConfig | null {
  const payload = parsePairingLink(input);
  if (!payload) {
    return null;
  }
  return createPairingConfig({
    relayUrl: payload.relay_url,
    deviceId: payload.device_id,
    displayName: payload.display_name?.trim() || undefined,
  });
}

export function createPairingConfig(
  input: Pick<PairingConfig, "relayUrl" | "deviceId"> &
    Partial<
      Pick<
        PairingConfig,
        "displayName" | "relaySessionToken" | "appInstanceId"
      >
    >,
): PairingConfig | null {
  const relayUrl = input.relayUrl.trim();
  const deviceId = normalizeIdentityId(input.deviceId);
  if (!isRelayWebSocketUrl(relayUrl) || !deviceId?.startsWith("DEV1-")) {
    return null;
  }
  return {
    relayUrl,
    deviceId,
    displayName: input.displayName?.trim() || undefined,
    relaySessionToken: input.relaySessionToken?.trim() || undefined,
    appInstanceId: input.appInstanceId ?? createAppInstanceId(),
  };
}

export function createAppInstanceId(): string {
  const random = Math.random().toString(36).slice(2, 12);
  return `app_${Date.now().toString(36)}_${random}`;
}

export function isSameRelayOrigin(left: string, right: string): boolean {
  if (!isRelayWebSocketUrl(left) || !isRelayWebSocketUrl(right)) {
    return false;
  }
  return new URL(left).origin === new URL(right).origin;
}

/** Only target imports retain a saved session; edits must allow token removal. */
export function retainSavedRelaySession(
  nextPairing: PairingConfig,
  savedPairings: PairingConfig[],
): PairingConfig {
  const saved = savedPairings.find(
    (item) =>
      item.relayUrl === nextPairing.relayUrl &&
      item.deviceId === nextPairing.deviceId,
  );
  return {
    ...nextPairing,
    relaySessionToken: nextPairing.relaySessionToken ?? saved?.relaySessionToken,
  };
}

function isRelayWebSocketUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
}
