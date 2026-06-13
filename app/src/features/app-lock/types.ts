export type AutoLockOption = 5 | 10 | 30 | 60 | "never";

export type AppLockMode =
  | "loading"
  | "unavailable"
  | "disabled"
  | "firstRunPrompt"
  | "locked"
  | "unlocked";

export interface AppLockConfig {
  initialized: boolean;
  enabled: boolean;
  gestureHash?: string;
  gestureSalt?: string;
  autoLockOption: AutoLockOption;
  lastInteractionAt?: number;
  lastUnlockedAt?: number;
}

export interface StoredAppLockConfig {
  initialized?: boolean;
  enabled?: boolean;
  gestureHash?: string;
  gestureSalt?: string;
  autoLockOption?: AutoLockOption;
  lastInteractionAt?: number;
  lastUnlockedAt?: number;
}
