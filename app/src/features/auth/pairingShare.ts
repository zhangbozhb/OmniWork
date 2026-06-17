import {
  createEncryptedPairingShare,
  PROTOCOL_VERSION,
  type PairingLinkPayload,
  type PairingQrSource,
} from "@omniwork/protocol-ts";

import type { PairingConfig } from "./types";

export interface PairingSharePackage {
  link: string;
  password: string;
  expiresAt: Date;
}

export function createPairingSharePackage(
  pairing: PairingConfig,
  source: PairingQrSource,
): PairingSharePackage {
  return createEncryptedPairingShare(toPairingLinkPayload(pairing), {
    source,
  });
}

function toPairingLinkPayload(pairing: PairingConfig): PairingLinkPayload {
  return {
    v: PROTOCOL_VERSION,
    relay_url: pairing.relayUrl,
    device_id: pairing.deviceId,
    display_name: pairing.displayName,
    key: pairing.key,
    key_id: pairing.keyId,
  };
}
