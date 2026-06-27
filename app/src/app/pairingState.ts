import type { PairingConfig } from "../features/auth/types";

export function upsertPairing(
  pairings: PairingConfig[],
  nextPairing: PairingConfig,
): PairingConfig[] {
  const index = pairings.findIndex((pairing) =>
    isSamePairing(pairing, nextPairing),
  );
  if (index < 0) {
    return [...pairings, nextPairing];
  }

  const nextPairings = [...pairings];
  nextPairings[index] = nextPairing;
  return nextPairings;
}

export function isSamePairing(
  left: PairingConfig,
  right: PairingConfig,
): boolean {
  return left.relayUrl === right.relayUrl && left.deviceId === right.deviceId;
}

export function getPairingDisplayName(pairing: PairingConfig): string {
  return pairing.displayName?.trim() || pairing.deviceId;
}
