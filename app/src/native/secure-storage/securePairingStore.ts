import * as SecureStore from "expo-secure-store";

import type { PairingConfig } from "../../features/auth/types";

const PAIRING_KEY = "omniwork.pairing";

export async function savePairing(pairing: PairingConfig): Promise<void> {
  await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(pairing), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function loadPairing(): Promise<PairingConfig | null> {
  const raw = await SecureStore.getItemAsync(PAIRING_KEY);
  return raw ? (JSON.parse(raw) as PairingConfig) : null;
}

export async function clearPairing(): Promise<void> {
  await SecureStore.deleteItemAsync(PAIRING_KEY);
}
