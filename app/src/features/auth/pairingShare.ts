import {
  createPairingLink,
  PROTOCOL_VERSION,
  type PairingLinkPayload,
} from "@omniwork/protocol-ts";

import type { PairingConfig } from "./types";

export function createPairingShareLink(pairing: PairingConfig): string {
  return createPairingLink(toPairingLinkPayload(pairing));
}

function toPairingLinkPayload(pairing: PairingConfig): PairingLinkPayload {
  return {
    v: PROTOCOL_VERSION,
    relay_url: pairing.relayUrl,
    device_id: pairing.deviceId,
    key: pairing.key,
    key_id: pairing.keyId,
  };
}
