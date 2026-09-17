import { isValidIdentityId } from "@omni-work/protocol-ts";
import type { PairingConfig } from "../../features/auth/types";

const STORAGE_KEY = "omniwork.pairings";

export async function savePairings(pairings: PairingConfig[]): Promise<void> {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(pairings.map(withoutRelaySessionToken)),
  );
  if (pairings.some((pairing) => pairing.relaySessionToken)) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pairings));
  } else {
    sessionStorage.removeItem(STORAGE_KEY);
  }
}

export async function loadPairings(): Promise<PairingConfig[]> {
  const persistentPairings = parseStoredPairings(
    localStorage.getItem(STORAGE_KEY),
  ).map(withoutRelaySessionToken);
  const sessionPairings = parseStoredPairings(
    sessionStorage.getItem(STORAGE_KEY),
  );
  const basePairings =
    persistentPairings.length > 0
      ? persistentPairings
      : sessionPairings.map(withoutRelaySessionToken);
  if (basePairings.length === 0) {
    return [];
  }

  const sessionTokens = new Map(
    sessionPairings
      .filter((pairing) => pairing.relaySessionToken)
      .map((pairing) => [pairingKey(pairing), pairing.relaySessionToken]),
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify(basePairings));
  return basePairings.map((pairing) => ({
    ...pairing,
    relaySessionToken: sessionTokens.get(pairingKey(pairing)),
  }));
}

export async function savePairing(pairing: PairingConfig): Promise<void> {
  await savePairings([pairing]);
}

export async function loadPairing(): Promise<PairingConfig | null> {
  return (await loadPairings())[0] ?? null;
}

export async function clearPairing(): Promise<void> {
  localStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(STORAGE_KEY);
}

function parseStoredPairings(saved: string | null): PairingConfig[] {
  if (!saved) {
    return [];
  }
  const parsed = JSON.parse(saved) as
    | Partial<PairingConfig>
    | Array<Partial<PairingConfig>>;
  const pairings = Array.isArray(parsed) ? parsed : [parsed];
  return pairings.flatMap((pairing) => {
    const normalized = normalizePairingConfig(pairing);
    return normalized ? [normalized] : [];
  });
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

function withoutRelaySessionToken(pairing: PairingConfig): PairingConfig {
  const { relaySessionToken: _relaySessionToken, ...target } = pairing;
  return target;
}

function pairingKey(pairing: PairingConfig): string {
  return `${pairing.relayUrl}\n${pairing.deviceId}`;
}
