import { createHmacSha256Base64Url } from "../auth/hmacSha256";
import type { AppLockConfig, AutoLockOption, StoredAppLockConfig } from "./types";

export const GESTURE_POINT_COUNT = 6;
export const DEFAULT_AUTO_LOCK_OPTION: AutoLockOption = 30;
export const AUTO_LOCK_OPTIONS: ReadonlyArray<AutoLockOption> = [
  5,
  10,
  30,
  60,
  "never",
];

export const DEFAULT_APP_LOCK_CONFIG: AppLockConfig = {
  initialized: false,
  enabled: false,
  autoLockOption: DEFAULT_AUTO_LOCK_OPTION,
};

export function normalizeAppLockConfig(
  config: StoredAppLockConfig | null | undefined,
): AppLockConfig {
  if (!config) {
    return DEFAULT_APP_LOCK_CONFIG;
  }
  const autoLockOption = isAutoLockOption(config.autoLockOption)
    ? config.autoLockOption
    : DEFAULT_AUTO_LOCK_OPTION;
  return {
    initialized: Boolean(config.initialized),
    enabled: Boolean(config.enabled && config.gestureHash && config.gestureSalt),
    gestureHash: typeof config.gestureHash === "string" ? config.gestureHash : undefined,
    gestureSalt: typeof config.gestureSalt === "string" ? config.gestureSalt : undefined,
    autoLockOption,
    lastInteractionAt: normalizeTimestamp(config.lastInteractionAt),
    lastUnlockedAt: normalizeTimestamp(config.lastUnlockedAt),
  };
}

export function isAutoLockOption(value: unknown): value is AutoLockOption {
  return value === 5 || value === 10 || value === 30 || value === 60 || value === "never";
}

export function shouldLockForInactivity(
  config: AppLockConfig,
  now = Date.now(),
): boolean {
  if (!config.enabled || config.autoLockOption === "never") {
    return false;
  }
  const lastInteractionAt = config.lastInteractionAt ?? config.lastUnlockedAt;
  if (!lastInteractionAt) {
    return false;
  }
  return now - lastInteractionAt >= config.autoLockOption * 60_000;
}

export function isValidGesture(gesture: number[]): boolean {
  return (
    new Set(gesture).size === gesture.length &&
    gesture.length === GESTURE_POINT_COUNT
  );
}

export function serializeGesture(gesture: number[]): string {
  return gesture.join("-");
}

export function createGestureSecret(gesture: number[]): {
  hash: string;
  salt: string;
} {
  const salt = createSalt();
  return {
    hash: hashGesture(gesture, salt),
    salt,
  };
}

export function hashGesture(gesture: number[], salt: string): string {
  return createHmacSha256Base64Url(salt, serializeGesture(gesture));
}

export function verifyGesture(
  gesture: number[],
  config: AppLockConfig,
): boolean {
  if (!config.gestureHash || !config.gestureSalt) {
    return false;
  }
  return hashGesture(gesture, config.gestureSalt) === config.gestureHash;
}

function normalizeTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function createSalt(): string {
  const cryptoObject = globalThis.crypto as
    | { getRandomValues?(array: Uint8Array): Uint8Array }
    | undefined;
  const bytes = new Uint8Array(16);
  if (cryptoObject?.getRandomValues) {
    cryptoObject.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
