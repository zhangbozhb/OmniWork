import { type PairingConfig } from "../../features/auth/types";

const PAIRING_KEY = "omniwork.pairings";

export async function savePairings(pairings: PairingConfig[]): Promise<void> {
  localStorage.removeItem(PAIRING_KEY);
  sessionStorage.setItem(PAIRING_KEY, JSON.stringify(pairings));
}

export async function loadPairings(): Promise<PairingConfig[]> {
  localStorage.removeItem(PAIRING_KEY);
  const saved = sessionStorage.getItem(PAIRING_KEY);
  if (!saved) {
    return [];
  }

  const parsed = JSON.parse(saved) as
    | Partial<PairingConfig>
    | Array<Partial<PairingConfig>>;
  const pairings = Array.isArray(parsed) ? parsed : [parsed];
  return pairings.map(normalizePairingConfig).filter(hasSessionKey);
}

export async function savePairing(pairing: PairingConfig): Promise<void> {
  await savePairings([pairing]);
}

export async function loadPairing(): Promise<PairingConfig | null> {
  return (await loadPairings())[0] ?? null;
}

export async function clearPairing(): Promise<void> {
  localStorage.removeItem(PAIRING_KEY);
  sessionStorage.removeItem(PAIRING_KEY);
}

function normalizePairingConfig(
  pairing: Partial<PairingConfig>,
): PairingConfig {
  return {
    relayUrl: pairing.relayUrl ?? "",
    deviceId: pairing.deviceId ?? "",
    displayName: pairing.displayName?.trim() || undefined,
    key: pairing.key ?? "",
    keyId: pairing.keyId,
    appInstanceId: pairing.appInstanceId ?? createAppInstanceId(),
  };
}

function hasSessionKey(pairing: PairingConfig): boolean {
  return pairing.key.length > 0;
}

function createAppInstanceId(): string {
  const random = Math.random().toString(36).slice(2, 12);
  return `app_${Date.now().toString(36)}_${random}`;
}
