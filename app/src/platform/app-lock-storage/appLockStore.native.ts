import * as Keychain from "react-native-keychain";

import type { StoredAppLockConfig } from "../../features/app-lock/types";

const APP_LOCK_KEY = "omniwork.appLock";
const SERVICE = "com.omniwork.mobile.app-lock";

export async function saveAppLockConfig(
  config: StoredAppLockConfig,
): Promise<void> {
  await Keychain.setGenericPassword(APP_LOCK_KEY, JSON.stringify(config), {
    service: SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function loadAppLockConfig(): Promise<StoredAppLockConfig | null> {
  const result = await Keychain.getGenericPassword({ service: SERVICE });
  if (!result || result.username !== APP_LOCK_KEY) {
    return null;
  }
  return JSON.parse(result.password) as StoredAppLockConfig;
}

export async function clearAppLockConfig(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SERVICE });
}
