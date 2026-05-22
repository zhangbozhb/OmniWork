import * as Keychain from "react-native-keychain";

import { type PairingConfig } from "../../features/auth/types";

const PAIRING_KEY = "omniwork.pairing";
const SERVICE = "com.omniwork.mobile.pairing";

export async function savePairings(pairings: PairingConfig[]): Promise<void> {
  await Keychain.setGenericPassword(PAIRING_KEY, JSON.stringify(pairings), {
    service: SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function loadPairings(): Promise<PairingConfig[]> {
  const result = await Keychain.getGenericPassword({ service: SERVICE });
  if (!result || result.username !== PAIRING_KEY) {
    return [];
  }

  const parsed = JSON.parse(result.password) as
    | Partial<PairingConfig>
    | Array<Partial<PairingConfig>>;
  const pairings = Array.isArray(parsed) ? parsed : [parsed];
  return pairings.map(normalizePairingConfig);
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
): PairingConfig {
  return {
    relayUrl: pairing.relayUrl ?? "",
    deviceId: pairing.deviceId ?? "",
    key: pairing.key ?? "",
    keyId: pairing.keyId,
  };
}
