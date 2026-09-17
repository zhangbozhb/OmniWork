import * as Keychain from "react-native-keychain";

import { isValidIdentityId } from "@omni-work/protocol-ts";
import type { PairingConfig } from "../../features/auth/types";

const STORAGE_USERNAME = "omniwork.pairing";
const SERVICE = "com.omniwork.mobile.pairing";

export async function savePairings(pairings: PairingConfig[]): Promise<void> {
  await Keychain.setGenericPassword(
    STORAGE_USERNAME,
    JSON.stringify(pairings),
    {
      service: SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    },
  );
}

export async function loadPairings(): Promise<PairingConfig[]> {
  const result = await Keychain.getGenericPassword({ service: SERVICE });
  if (!result || result.username !== STORAGE_USERNAME) {
    return [];
  }

  const parsed = JSON.parse(result.password) as
    | Partial<PairingConfig>
    | Array<Partial<PairingConfig>>;
  const pairings = Array.isArray(parsed) ? parsed : [parsed];
  return pairings.flatMap((pairing) => {
    const normalized = normalizePairingConfig(pairing);
    return normalized ? [normalized] : [];
  });
}

export async function savePairing(pairing: PairingConfig): Promise<void> {
  await savePairings([pairing]);
}

export async function loadPairing(): Promise<PairingConfig | null> {
  return (await loadPairings())[0] ?? null;
}

export async function clearPairing(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SERVICE });
}

function normalizePairingConfig(
  pairing: Partial<PairingConfig>,
): PairingConfig | null {
  if (
    !pairing.relayUrl ||
    !pairing.deviceId ||
    !pairing.appInstanceId ||
    !isValidIdentityId(pairing.deviceId, "agent")
  ) {
    return null;
  }
  return {
    relayUrl: pairing.relayUrl,
    deviceId: pairing.deviceId,
    displayName: pairing.displayName?.trim() || undefined,
    relaySessionToken: pairing.relaySessionToken,
    appInstanceId: pairing.appInstanceId,
  };
}
