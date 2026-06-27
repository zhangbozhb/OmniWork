import {
  type JSX,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Alert, Platform, StyleSheet, Text, View } from "react-native";

import type { AppView } from "../../app/appTypes";
import { formatErrorMessage } from "../../app/connectionMessages";
import { clearPairing } from "../../platform/secure-storage/securePairingStore";
import {
  clearAppLockConfig,
  loadAppLockConfig,
  saveAppLockConfig,
} from "../../platform/app-lock-storage/appLockStore";
import { authenticateDeviceOwner } from "../../platform/owner-auth/ownerAuth";
import type { ConfirmOptions } from "../../ui/confirm/ConfirmProvider";
import { Button } from "../../ui/components";
import {
  DEFAULT_APP_LOCK_CONFIG,
  DEFAULT_AUTO_LOCK_OPTION,
  createGestureSecret,
  normalizeAppLockConfig,
  shouldLockForInactivity,
  verifyGesture,
} from "./appLockRules";
import type { AppLockConfig, AppLockMode, AutoLockOption } from "./types";
import { AppLockIntroScreen } from "../../screens/security/AppLockIntroScreen";
import { GestureSetupScreen } from "../../screens/security/GestureSetupScreen";
import { GestureUnlockScreen } from "../../screens/security/GestureUnlockScreen";

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

type UseAppLockControllerOptions = {
  t(key: string): string;
  confirm: Confirm;
  pairingsCount(): number;
  setView(view: AppView | ((current: AppView) => AppView)): void;
  onResetAppData(message: string): void;
};

export function useAppLockController({
  t,
  confirm,
  pairingsCount,
  setView,
  onResetAppData,
}: UseAppLockControllerOptions) {
  const appLockAvailable = Platform.OS !== "web";
  const [appLockConfig, setAppLockConfig] = useState<AppLockConfig>(
    DEFAULT_APP_LOCK_CONFIG,
  );
  const [appLockMode, setAppLockMode] = useState<AppLockMode>(
    appLockAvailable ? "loading" : "disabled",
  );
  const [gestureSetupMode, setGestureSetupMode] = useState<
    "firstRun" | "enable" | "change" | null
  >(null);
  const [pendingSecurityAction, setPendingSecurityAction] = useState<
    "disable" | "change" | null
  >(null);
  const [autoLockPickerVisible, setAutoLockPickerVisible] = useState(false);
  const [selectedAutoLockOption, setSelectedAutoLockOption] =
    useState<AutoLockOption>(DEFAULT_AUTO_LOCK_OPTION);
  const [appLockLoadRetry, setAppLockLoadRetry] = useState(0);
  const appLockConfigRef = useRef<AppLockConfig>(DEFAULT_APP_LOCK_CONFIG);
  const appLockModeRef = useRef<AppLockMode>(
    appLockAvailable ? "loading" : "disabled",
  );
  const lastInteractionPersistedAtRef = useRef(0);
  const resettingAppLockRef = useRef(false);

  useEffect(() => {
    appLockConfigRef.current = appLockConfig;
  }, [appLockConfig]);

  useEffect(() => {
    appLockModeRef.current = appLockMode;
  }, [appLockMode]);

  useEffect(() => {
    if (!appLockAvailable) {
      setAppLockMode("disabled");
      return;
    }
    let active = true;
    loadAppLockConfig()
      .then((storedConfig) => {
        if (!active) return;
        const nextConfig = normalizeAppLockConfig(storedConfig);
        appLockConfigRef.current = nextConfig;
        setAppLockConfig(nextConfig);
        setSelectedAutoLockOption(nextConfig.autoLockOption);
        if (!nextConfig.initialized) {
          setAppLockMode("firstRunPrompt");
        } else if (nextConfig.enabled) {
          setAppLockMode("locked");
        } else {
          setAppLockMode("disabled");
        }
      })
      .catch(() => {
        if (active) {
          setAppLockMode("unavailable");
        }
      });
    return () => {
      active = false;
    };
  }, [appLockAvailable, appLockLoadRetry]);

  useEffect(() => {
    if (
      !appLockAvailable ||
      appLockMode !== "unlocked" ||
      appLockConfig.autoLockOption === "never"
    ) {
      return undefined;
    }
    const timer = setInterval(() => {
      const currentConfig = appLockConfigRef.current;
      if (shouldLockForInactivity(currentConfig)) {
        setAppLockMode("locked");
      }
    }, 15_000);
    return () => clearInterval(timer);
  }, [appLockAvailable, appLockConfig.autoLockOption, appLockMode]);

  const persistAppLockConfig = useCallback((nextConfig: AppLockConfig) => {
    const normalized = normalizeAppLockConfig(nextConfig);
    appLockConfigRef.current = normalized;
    setAppLockConfig(normalized);
    setSelectedAutoLockOption(normalized.autoLockOption);
    saveAppLockConfig(normalized).catch(() => {
      // 本地安全配置持久化失败不影响当前内存态。
    });
  }, []);

  const updateLastInteraction = useCallback(() => {
    if (!appLockAvailable || appLockModeRef.current !== "unlocked") {
      return;
    }
    const now = Date.now();
    if (shouldLockForInactivity(appLockConfigRef.current, now)) {
      setAppLockMode("locked");
      return;
    }
    if (now - lastInteractionPersistedAtRef.current < 5_000) {
      return;
    }
    lastInteractionPersistedAtRef.current = now;
    const nextConfig = {
      ...appLockConfigRef.current,
      lastInteractionAt: now,
    };
    appLockConfigRef.current = nextConfig;
    setAppLockConfig(nextConfig);
    saveAppLockConfig(nextConfig).catch(() => {
      // 非关键路径：失败只影响下次启动后的超时判断。
    });
  }, [appLockAvailable]);

  const handleSkipFirstAppLockSetup = useCallback(() => {
    const nextConfig = {
      ...DEFAULT_APP_LOCK_CONFIG,
      initialized: true,
      enabled: false,
    };
    persistAppLockConfig(nextConfig);
    setGestureSetupMode(null);
    setAppLockMode("disabled");
  }, [persistAppLockConfig]);

  const handleCompleteGestureSetup = useCallback(
    (gesture: number[]) => {
      const secret = createGestureSecret(gesture);
      const now = Date.now();
      const nextConfig: AppLockConfig = {
        ...appLockConfigRef.current,
        initialized: true,
        enabled: true,
        gestureHash: secret.hash,
        gestureSalt: secret.salt,
        lastInteractionAt: now,
        lastUnlockedAt: now,
      };
      persistAppLockConfig(nextConfig);
      setGestureSetupMode(null);
      setPendingSecurityAction(null);
      setAppLockMode("unlocked");
      setView((current) =>
        current === "securitySettings"
          ? current
          : pairingsCount() > 0
            ? "devices"
            : "pairing",
      );
    },
    [pairingsCount, persistAppLockConfig, setView],
  );

  const handleUnlockGesture = useCallback(
    (gesture: number[]): boolean => {
      const currentConfig = appLockConfigRef.current;
      if (!verifyGesture(gesture, currentConfig)) {
        return false;
      }
      const now = Date.now();
      if (pendingSecurityAction === "disable") {
        const nextConfig: AppLockConfig = {
          ...currentConfig,
          initialized: true,
          enabled: false,
          gestureHash: undefined,
          gestureSalt: undefined,
          lastInteractionAt: now,
          lastUnlockedAt: now,
        };
        persistAppLockConfig(nextConfig);
        setPendingSecurityAction(null);
        setAppLockMode("disabled");
        return true;
      }
      if (pendingSecurityAction === "change") {
        setPendingSecurityAction(null);
        setGestureSetupMode("change");
        return true;
      }
      const nextConfig = {
        ...currentConfig,
        lastInteractionAt: now,
        lastUnlockedAt: now,
      };
      persistAppLockConfig(nextConfig);
      setAppLockMode("unlocked");
      return true;
    },
    [pendingSecurityAction, persistAppLockConfig],
  );

  const resetAppAfterForgotGesture = useCallback(async () => {
    await Promise.all([clearAppLockConfig(), clearPairing()]);
    onResetAppData(t("appLock.reset.pairingMessage"));
    lastInteractionPersistedAtRef.current = 0;
    appLockConfigRef.current = DEFAULT_APP_LOCK_CONFIG;

    setPendingSecurityAction(null);
    setGestureSetupMode(null);
    setAppLockConfig(DEFAULT_APP_LOCK_CONFIG);
    setSelectedAutoLockOption(DEFAULT_AUTO_LOCK_OPTION);
    setAppLockMode("firstRunPrompt");
    setView("pairing");
  }, [onResetAppData, setView, t]);

  const handleForgotGesture = useCallback(() => {
    if (resettingAppLockRef.current) {
      return;
    }
    confirm({
      title: t("appLock.reset.title"),
      message: t("appLock.reset.description"),
      confirmText: t("appLock.reset.confirm"),
      cancelText: t("common.cancel"),
      tone: "danger",
    })
      .then(async (confirmed) => {
        if (!confirmed || resettingAppLockRef.current) {
          return;
        }
        resettingAppLockRef.current = true;
        const authResult = await authenticateDeviceOwner({
          title: t("appLock.reset.authTitle"),
          subtitle: t("appLock.reset.authSubtitle"),
          description: t("appLock.reset.authDescription"),
          cancel: t("common.cancel"),
        });
        if (authResult === "unavailable") {
          Alert.alert(
            t("appLock.reset.unavailableTitle"),
            t("appLock.reset.unavailableDescription"),
          );
          return;
        }
        if (authResult !== "authenticated") {
          Alert.alert(
            t("appLock.reset.cancelledTitle"),
            t("appLock.reset.cancelledDescription"),
          );
          return;
        }
        await resetAppAfterForgotGesture();
        Alert.alert(
          t("appLock.reset.successTitle"),
          t("appLock.reset.successDescription"),
        );
      })
      .catch((error: unknown) => {
        Alert.alert(t("appLock.reset.failedTitle"), formatErrorMessage(error));
      })
      .finally(() => {
        resettingAppLockRef.current = false;
      });
  }, [confirm, resetAppAfterForgotGesture, t]);

  const handleConfirmAutoLockOption = useCallback(() => {
    persistAppLockConfig({
      ...appLockConfigRef.current,
      autoLockOption: selectedAutoLockOption,
    });
    setAutoLockPickerVisible(false);
  }, [persistAppLockConfig, selectedAutoLockOption]);

  const showingAppLockScreen =
    appLockAvailable &&
    (Boolean(pendingSecurityAction) ||
      Boolean(gestureSetupMode) ||
      appLockMode === "loading" ||
      appLockMode === "unavailable" ||
      appLockMode === "firstRunPrompt" ||
      appLockMode === "locked");

  function lockIfInactive(): boolean {
    if (
      !appLockAvailable ||
      appLockModeRef.current !== "unlocked" ||
      !shouldLockForInactivity(appLockConfigRef.current)
    ) {
      return false;
    }
    setAppLockMode("locked");
    return true;
  }

  const appLockScreen = appLockAvailable ? (
    pendingSecurityAction ? (
      <GestureUnlockScreen
        canCancel
        onCancel={() => setPendingSecurityAction(null)}
        onUnlock={handleUnlockGesture}
      />
    ) : gestureSetupMode ? (
      <GestureSetupScreen
        mode={gestureSetupMode}
        onBack={
          gestureSetupMode === "firstRun"
            ? undefined
            : () => setGestureSetupMode(null)
        }
        onComplete={handleCompleteGestureSetup}
        onSkip={
          gestureSetupMode === "firstRun"
            ? handleSkipFirstAppLockSetup
            : undefined
        }
      />
    ) : appLockMode === "loading" ? (
      <View style={styles.loadingScreen}>
        <Text style={styles.loadingText}>{t("common.loading")}</Text>
      </View>
    ) : appLockMode === "unavailable" ? (
      <View style={styles.appLockErrorScreen}>
        <Text style={styles.appLockErrorTitle}>
          {t("appLock.unavailable.title")}
        </Text>
        <Text style={styles.appLockErrorText}>
          {t("appLock.unavailable.description")}
        </Text>
        <Button
          tone="primary"
          variant="solid"
          onPress={() => {
            setAppLockMode("loading");
            setAppLockLoadRetry((current) => current + 1);
          }}
        >
          {t("common.refresh")}
        </Button>
      </View>
    ) : appLockMode === "firstRunPrompt" ? (
      <AppLockIntroScreen
        onSetup={() => setGestureSetupMode("firstRun")}
        onSkip={handleSkipFirstAppLockSetup}
      />
    ) : appLockMode === "locked" ? (
      <GestureUnlockScreen
        onForgotGesture={handleForgotGesture}
        onUnlock={handleUnlockGesture}
      />
    ) : null
  ) : null;

  return {
    appLockAvailable,
    appLockConfig,
    appLockScreen,
    autoLockPickerVisible,
    selectedAutoLockOption,
    showingAppLockScreen,
    updateLastInteraction,
    lockIfInactive,
    setGestureSetupMode,
    setPendingSecurityAction,
    setAutoLockPickerVisible,
    setSelectedAutoLockOption,
    handleConfirmAutoLockOption,
  };
}

const styles = StyleSheet.create({
  loadingScreen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  loadingText: {
    color: "#94a3ad",
    fontSize: 14,
    fontWeight: "700",
  },
  appLockErrorScreen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    paddingHorizontal: 32,
  },
  appLockErrorTitle: {
    color: "#f5f7f8",
    fontSize: 20,
    fontWeight: "800",
    textAlign: "center",
  },
  appLockErrorText: {
    color: "#94a3ad",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
});
