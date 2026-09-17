import {
  PROTOCOL_VERSION,
  createPairingLink,
} from "@omni-work/protocol-ts";

import type { PairingConfig } from "./types";

export function createPairingShareLink(pairing: PairingConfig): string {
  return createPairingLink({
    v: PROTOCOL_VERSION,
    relay_url: pairing.relayUrl,
    device_id: pairing.deviceId,
    display_name: pairing.displayName,
  });
}
