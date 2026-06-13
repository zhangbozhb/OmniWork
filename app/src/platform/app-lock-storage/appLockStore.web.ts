import type { StoredAppLockConfig } from "../../features/app-lock/types";

export async function saveAppLockConfig(
  _config: StoredAppLockConfig,
): Promise<void> {
  // Web 不启用 APP 端手势锁。
}

export async function loadAppLockConfig(): Promise<StoredAppLockConfig | null> {
  return null;
}
