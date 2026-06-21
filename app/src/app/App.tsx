import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  AppState,
  type AppStateStatus,
  Dimensions,
  Modal,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";

import type {
  AgentProviderDefinition,
  AuthFailedPayload,
  CodexSession,
  FilesListPayload,
  FilesReadPayload,
  FilesWritePayload,
  GitDiffPayload,
  GitDiffScope,
  GitStatusPayload,
  MessageEnvelope,
  RuntimeKind,
  SessionListPayload,
  TerminalErrorPayload,
  TerminalFramePayload,
  TerminalInputPayload,
  TerminalResizePayload,
  TerminalSnapshotPayload,
  TransportPath,
  TransportPreference,
  WorkspaceDefinition,
  WorkspaceFileEntry,
  WorkspaceGitStatus,
  WorkspaceListPayload,
} from "@omniwork/protocol-ts";
import {
  DEFAULT_AGENT_PROVIDER_DEFINITIONS,
  createMessage,
  isTransportPreference,
} from "@omniwork/protocol-ts";
import { appConfig } from "./appConfig";
import type {
  AppSessionTransport,
  AppView,
  ConnectionStatus,
  PrimaryTabView,
} from "./appTypes";
import {
  formatErrorMessage,
  formatRelayCloseMessage,
  formatStrictForceCloseMessage,
  getPairingDisplayName,
  getHeaderSubtitle,
  isPrimaryTabView,
  isSamePairing,
  isTransitionalSessionStatus,
  upsertPairing,
  upsertSession,
} from "./appModel";
import {
  createAppSessionTransport,
  subscribeNetworkChanges,
} from "./appTransport";
import { PairingScreen } from "../screens/pairing/PairingScreen";
import { DeviceListScreen } from "../screens/devices/DeviceListScreen";
import { ConnectionPreferenceScreen } from "../screens/settings/ConnectionPreferenceScreen";
import { SettingsScreen } from "../screens/settings/SettingsScreen";
import { AppLockIntroScreen } from "../screens/security/AppLockIntroScreen";
import { GestureSetupScreen } from "../screens/security/GestureSetupScreen";
import { GestureUnlockScreen } from "../screens/security/GestureUnlockScreen";
import { SecuritySettingsScreen } from "../screens/security/SecuritySettingsScreen";
import { Button } from "../ui/components";
import { SessionListScreen } from "../screens/sessions/SessionListScreen";
import { TerminalScreen } from "../screens/terminal/TerminalScreen";
import { FileBrowserScreen } from "../screens/workspaces/FileBrowserScreen";
import { GitStatusScreen } from "../screens/workspaces/GitStatusScreen";
import { FileEditorScreen } from "../screens/workspaces/FileEditorScreen";
import type { PairingConfig } from "../features/auth/types";
import {
  decryptPairingConfig,
  isEncryptedPairingConfig,
  parsePairingConfig,
} from "../features/auth/pairingConfig";
import {
  closeSessionRequest,
  renameSessionRequest,
  killTmuxSessionRequest,
  listSessionsRequest,
  createSessionRequest,
} from "../features/sessions/sessionMessages";
import { getSessionCapabilities } from "../features/sessions/sessionCapabilities";
import {
  terminalInputRequest,
  terminalResizeRequest,
  terminalSnapshotRequest,
} from "../features/terminal/terminalMessages";
import {
  gitDiffRequest,
  gitStatusRequest,
  listFilesRequest,
  listWorkspacesRequest,
  readFileRequest,
  writeFileRequest,
} from "../features/workspaces/workspaceMessages";
import {
  computeInitialTerminalSize,
  getDefaultTerminalTextSize,
  isTerminalTextSize,
  type TerminalTextSize,
} from "../features/terminal/terminalLayout";
import { terminalFrameWatermarkAfterSnapshot } from "./terminalFrameWatermark";
import i18n from "../i18n";
import {
  DEFAULT_LANGUAGE,
  LANGUAGE_STORAGE_KEY,
  isAppLanguage,
  type AppLanguage,
} from "../i18n/language";
import {
  addAppUrlListener,
  getInitialAppUrl,
} from "../platform/linking/appLinking";
import {
  clearPairing,
  loadPairings,
  savePairings,
} from "../platform/secure-storage/securePairingStore";
import {
  clearAppLockConfig,
  loadAppLockConfig,
  saveAppLockConfig,
} from "../platform/app-lock-storage/appLockStore";
import { authenticateDeviceOwner } from "../platform/owner-auth/ownerAuth";
import {
  DEFAULT_APP_LOCK_CONFIG,
  DEFAULT_AUTO_LOCK_OPTION,
  createGestureSecret,
  normalizeAppLockConfig,
  shouldLockForInactivity,
  verifyGesture,
} from "../features/app-lock/appLockRules";
import type {
  AppLockConfig,
  AppLockMode,
  AutoLockOption,
} from "../features/app-lock/types";
import { ConfirmProvider, useConfirm } from "../ui/confirm/ConfirmProvider";
import { Icon, type IconName } from "../ui/icons";

const EMPTY_TERMINAL_FRAME = "Waiting for the Mac Agent terminal snapshot...";

type WorkspaceFilesCache = {
  currentPath: string;
  selectedFilePath?: string;
  directoriesByPath: Record<string, WorkspaceFileEntry[]>;
  filesByPath: Record<string, FilesReadPayload>;
  loadingDirectoryKeys: Record<string, boolean>;
  loadingFileKeys: Record<string, boolean>;
};

type WorkspaceGitCache = {
  status?: WorkspaceGitStatus;
  statusLoading?: boolean;
  activeDiffKey?: string;
  diffCache: Record<string, GitDiffPayload>;
  diffLoadingKeys: Record<string, boolean>;
  fileContentCache: Record<string, FilesReadPayload>;
  fileContentLoadingKeys: Record<string, boolean>;
};

type WorkspaceDataCache = {
  files: WorkspaceFilesCache;
  git: WorkspaceGitCache;
};

/**
 * AsyncStorage 中保存的用户传输偏好键；缺省时回退到 appConfig.transportPreference。
 * 取值范围由 packages/protocol-ts isTransportPreference 守卫校验。
 */
const TRANSPORT_PREFERENCE_STORAGE_KEY = "omniwork.transportPreference";
const TERMINAL_TEXT_SIZE_STORAGE_KEY = "omniwork.terminal.textSize";
const FALLBACK_AGENT_PROVIDERS = DEFAULT_AGENT_PROVIDER_DEFINITIONS.filter(
  (provider) => provider.kind === "terminal",
);

function fallbackAgentProviders(): AgentProviderDefinition[] {
  return [...FALLBACK_AGENT_PROVIDERS];
}

function createWorkspaceFilesCache(): WorkspaceFilesCache {
  return {
    currentPath: "",
    directoriesByPath: {},
    filesByPath: {},
    loadingDirectoryKeys: {},
    loadingFileKeys: {},
  };
}

function createWorkspaceGitCache(): WorkspaceGitCache {
  return {
    diffCache: {},
    diffLoadingKeys: {},
    fileContentCache: {},
    fileContentLoadingKeys: {},
  };
}

function createWorkspaceDataCache(): WorkspaceDataCache {
  return {
    files: createWorkspaceFilesCache(),
    git: createWorkspaceGitCache(),
  };
}

export default function App(): JSX.Element {
  return (
    <ConfirmProvider>
      <AppContent />
    </ConfirmProvider>
  );
}

function AppContent(): JSX.Element {
  const { t } = useTranslation();
  const [pairings, setPairings] = useState<PairingConfig[]>([]);
  const [pairing, setPairing] = useState<PairingConfig | null>(null);
  const [view, setView] = useState<AppView>("pairing");
  const [editingPairing, setEditingPairing] = useState<
    PairingConfig | undefined
  >();
  const [selectedSession, setSelectedSession] = useState<CodexSession | null>(
    null,
  );
  const [sessions, setSessions] = useState<CodexSession[]>([]);
  const [agentProviders, setAgentProviders] = useState<
    AgentProviderDefinition[]
  >(fallbackAgentProviders);
  const [workspaces, setWorkspaces] = useState<WorkspaceDefinition[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] =
    useState<WorkspaceDefinition | null>(null);
  const [workspaceCache, setWorkspaceCache] = useState<
    Record<string, WorkspaceDataCache>
  >({});
  const [gitReviewPath, setGitReviewPath] = useState<string | undefined>();
  const [gitReviewScope, setGitReviewScope] = useState<GitDiffScope>("all");
  const [fileEditorPath, setFileEditorPath] = useState<string | undefined>();
  const [fileEditorReturnView, setFileEditorReturnView] =
    useState<AppView>("sessions");
  const [fileWriteLoadingKeys, setFileWriteLoadingKeys] = useState<
    Record<string, boolean>
  >({});
  const [lastFileWriteResult, setLastFileWriteResult] = useState<
    FilesWritePayload | undefined
  >();
  const [defaultSessionCwd, setDefaultSessionCwd] = useState("");
  const [terminalFrames, setTerminalFrames] = useState<Record<string, string>>(
    {},
  );
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("idle");
  const [connectionPath, setConnectionPath] = useState<TransportPath>("relay");
  const [connectionMessage, setConnectionMessage] = useState(
    "Enter the Mac Agent key to pair.",
  );
  const [pairingError, setPairingError] = useState<string | undefined>();
  const [pendingEncryptedPairingLink, setPendingEncryptedPairingLink] =
    useState<string | undefined>();
  const [encryptedPairingPassword, setEncryptedPairingPassword] = useState("");
  const [encryptedPairingError, setEncryptedPairingError] = useState<
    string | undefined
  >();
  const [creatingSession, setCreatingSession] = useState(false);
  const [closingSessionIds, setClosingSessionIds] = useState<string[]>([]);
  const [killingSessionIds, setKillingSessionIds] = useState<string[]>([]);
  // 用户在底部全局 Settings 入口选择的传输偏好，持久化到 AsyncStorage；
  // 缺省时回退到 appConfig.transportPreference（出厂值，默认 "auto"）。
  // 注意：初始值直接使用 appConfig 默认值，不阻塞建链；AsyncStorage 加载完成后
  // 若读出与默认不同的值，会经由 setTransportPreferenceState 触发 useEffect
  // 重建链路（依赖项含 transportPreference）。这样 Web 端首屏不会卡在 idle，
  // 且大多数用户（默认 auto）启动时不会经历额外重连。
  const [transportPreference, setTransportPreferenceState] =
    useState<TransportPreference>(appConfig.transportPreference);
  const [language, setLanguage] = useState<AppLanguage>(DEFAULT_LANGUAGE);
  const [terminalTextSize, setTerminalTextSizeState] =
    useState<TerminalTextSize>(() =>
      getDefaultTerminalTextSize(Dimensions.get("window")),
    );
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
  const relayRef = useRef<AppSessionTransport | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const appLockConfigRef = useRef<AppLockConfig>(DEFAULT_APP_LOCK_CONFIG);
  const appLockModeRef = useRef<AppLockMode>(
    appLockAvailable ? "loading" : "disabled",
  );
  const lastInteractionPersistedAtRef = useRef(0);
  const pendingCreateRef = useRef(false);
  const pendingAutoOpenSessionsRef = useRef(false);
  const pairingRef = useRef<PairingConfig | null>(null);
  const pairingsRef = useRef<PairingConfig[]>([]);
  const selectedSessionRef = useRef<CodexSession | null>(null);
  const terminalTextSizeLoadedRef = useRef(false);
  const terminalFrameSeqRef = useRef<Record<string, number>>({});
  const terminalLastFrameAtRef = useRef<Record<string, number>>({});
  const terminalLastSnapshotRequestAtRef = useRef<Record<string, number>>({});
  const pendingTerminalFramesRef = useRef<Record<string, string>>({});
  const terminalFrameFlushTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const directBusinessReadyRef = useRef(false);
  const resettingAppLockRef = useRef(false);
  // 标记当前失败状态是否已经在交互流程中提示过用户，避免重复弹出
  // "Connection lost" 对话框（例如重试再次失败时立刻又弹一次）。
  const failureDialogActiveRef = useRef(false);
  const confirm = useConfirm();

  const selectedWorkspaceCache = selectedWorkspace
    ? workspaceCache[selectedWorkspace.path]
    : undefined;
  const activeFilesCache = selectedWorkspaceCache?.files;
  const fileRelativePath = activeFilesCache?.currentPath ?? "";
  const fileEntries =
    activeFilesCache?.directoriesByPath[fileRelativePath] ?? [];
  const selectedFilePath = activeFilesCache?.selectedFilePath;
  const selectedFile = activeFilesCache?.selectedFilePath
    ? activeFilesCache.filesByPath[activeFilesCache.selectedFilePath]
    : undefined;
  const editorFile = fileEditorPath
    ? activeFilesCache?.filesByPath[fileEditorPath]
    : undefined;
  const editorLoading = Boolean(
    fileEditorPath && activeFilesCache?.loadingFileKeys[fileEditorPath],
  );
  const editorSaving = Boolean(
    selectedWorkspace &&
      fileEditorPath &&
      fileWriteLoadingKeys[
        toWorkspaceFileKey(selectedWorkspace.path, fileEditorPath)
      ],
  );
  const filesLoading = Boolean(
    activeFilesCache?.loadingDirectoryKeys[fileRelativePath] ||
      (activeFilesCache?.selectedFilePath &&
        activeFilesCache.loadingFileKeys[activeFilesCache.selectedFilePath]),
  );
  const activeGitCache = selectedWorkspaceCache?.git;
  const gitStatus = activeGitCache?.status;
  const gitDiffCache = activeGitCache?.diffCache ?? {};
  const gitFileContentCache = activeGitCache?.fileContentCache ?? {};
  const gitFileContentLoadingKeys =
    activeGitCache?.fileContentLoadingKeys ?? {};
  const gitDiff = activeGitCache?.activeDiffKey
    ? gitDiffCache[activeGitCache.activeDiffKey]
    : undefined;
  const gitStatusLoading = Boolean(activeGitCache?.statusLoading);
  const gitDiffLoading = Boolean(
    activeGitCache?.activeDiffKey &&
      activeGitCache.diffLoadingKeys[activeGitCache.activeDiffKey],
  );
  const gitLoading = gitStatusLoading || gitDiffLoading;

  const canUseWorkspace = pairings.length > 0;
  const showPrimaryTabs = canUseWorkspace && isPrimaryTabView(view);
  const title = useMemo(() => {
    if (view === "pairing") {
      return editingPairing
        ? t("app.titles.editDevice")
        : t("app.titles.pairMac");
    }
    if (view === "terminal") {
      return selectedSession?.title ?? t("app.titles.terminal");
    }
    if (view === "terminalFiles") return t("workspaces.tabs.files");
    if (view === "sessions") return t("app.titles.workspaces");
    if (view === "connectionPreference") return t("app.titles.connectionMode");
    if (view === "securitySettings") return t("appLock.settings.title");
    if (view === "settings") return t("app.titles.settings");
    return t("app.titles.devices");
  }, [editingPairing, selectedSession?.title, t, view]);

  const flushPendingTerminalFrames = useCallback(() => {
    terminalFrameFlushTimerRef.current = null;
    const pending = pendingTerminalFramesRef.current;
    pendingTerminalFramesRef.current = {};
    if (Object.keys(pending).length === 0) {
      return;
    }
    setTerminalFrames((current) => ({
      ...current,
      ...pending,
    }));
  }, []);

  const queueTerminalFrame = useCallback(
    (sessionId: string, payload: TerminalFramePayload, seq?: number) => {
      if (typeof seq === "number") {
        const lastSeq = terminalFrameSeqRef.current[sessionId] ?? 0;
        if (seq <= lastSeq) {
          return;
        }
        terminalFrameSeqRef.current[sessionId] = seq;
      }
      terminalLastFrameAtRef.current[sessionId] = Date.now();
      pendingTerminalFramesRef.current = {
        ...pendingTerminalFramesRef.current,
        [sessionId]: payload.data,
      };
      if (terminalFrameFlushTimerRef.current) {
        return;
      }
      terminalFrameFlushTimerRef.current = setTimeout(
        flushPendingTerminalFrames,
        16,
      );
    },
    [flushPendingTerminalFrames],
  );

  const selectedFrame = selectedSession
    ? (terminalFrames[selectedSession.session_id] ?? EMPTY_TERMINAL_FRAME)
    : EMPTY_TERMINAL_FRAME;
  const showingAppLockScreen =
    appLockAvailable &&
    (Boolean(pendingSecurityAction) ||
      Boolean(gestureSetupMode) ||
      appLockMode === "loading" ||
      appLockMode === "unavailable" ||
      appLockMode === "firstRunPrompt" ||
      appLockMode === "locked");
  const showHeader = view === "pairing" && !showingAppLockScreen;

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

  useEffect(() => {
    pairingRef.current = pairing;
  }, [pairing]);

  useEffect(() => {
    pairingsRef.current = pairings;
  }, [pairings]);

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

  useEffect(() => {
    let active = true;
    Promise.all([loadPairings(), getInitialAppUrl()])
      .then(async ([savedPairings, initialUrl]) => {
        if (!active) {
          return;
        }
        const scannedPairing = initialUrl
          ? parsePairingConfig(initialUrl)
          : null;
        if (scannedPairing) {
          await saveAndActivatePairing(scannedPairing, savedPairings, {
            autoOpenSessions: true,
          });
          setConnectionMessage("Pairing imported from link. Connecting...");
          return;
        }

        if (initialUrl && isEncryptedPairingConfig(initialUrl)) {
          pairingsRef.current = savedPairings;
          setPairings(savedPairings);
          setPairing(savedPairings[0] ?? null);
          setPendingEncryptedPairingLink(initialUrl);
          setEncryptedPairingPassword("");
          setEncryptedPairingError(undefined);
          setConnectionMessage("Encrypted pairing link detected.");
          setView(savedPairings.length > 0 ? "devices" : "pairing");
          return;
        }

        pairingsRef.current = savedPairings;
        setPairings(savedPairings);
        setPairing(savedPairings[0] ?? null);
        setView(savedPairings.length > 0 ? "devices" : "pairing");
      })
      .catch(() => {
        if (active) {
          setPairingError(
            "Could not restore the saved pairing. Enter the latest key again.",
          );
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (terminalFrameFlushTimerRef.current) {
        clearTimeout(terminalFrameFlushTimerRef.current);
        terminalFrameFlushTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const subscription = addAppUrlListener((url) => {
      handlePairingUrl(url).catch((error: unknown) => {
        setPairingError(
          `Could not import pairing link: ${formatErrorMessage(error)}`,
        );
      });
    });

    return () => subscription.remove();
  }, []);

  // 启动时从 AsyncStorage 加载用户偏好；缺省回退到 appConfig.transportPreference。
  // 加载完成前已经按默认值开始建链；若磁盘值与默认值不同，setTransportPreferenceState
  // 会触发下面的连接 useEffect 自动重建链路。
  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(TRANSPORT_PREFERENCE_STORAGE_KEY)
      .then((raw) => {
        if (!active) return;
        if (isTransportPreference(raw)) {
          setTransportPreferenceState(raw);
        }
      })
      .catch(() => {
        // 持久化失败不影响功能；使用 appConfig 默认值。
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(TERMINAL_TEXT_SIZE_STORAGE_KEY)
      .then((raw) => {
        if (!active) return;
        if (isTerminalTextSize(raw)) {
          setTerminalTextSizeState(raw);
        }
      })
      .finally(() => {
        if (active) {
          terminalTextSizeLoadedRef.current = true;
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(LANGUAGE_STORAGE_KEY)
      .then((raw) => {
        if (!active || !isAppLanguage(raw)) {
          return;
        }
        setLanguage(raw);
        void i18n.changeLanguage(raw);
      })
      .catch(() => {
        // 语言偏好读取失败不影响启动；使用默认英文。
      });
    return () => {
      active = false;
    };
  }, []);

  const handleChangeLanguage = useCallback((next: AppLanguage) => {
    setLanguage(next);
    void i18n.changeLanguage(next);
    AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, next).catch(() => {
      // 语言偏好持久化失败仅影响下次启动恢复。
    });
  }, []);

  const handleChangeTerminalTextSize = useCallback((next: TerminalTextSize) => {
    setTerminalTextSizeState(next);
    if (!terminalTextSizeLoadedRef.current) {
      return;
    }

    AsyncStorage.setItem(TERMINAL_TEXT_SIZE_STORAGE_KEY, next).catch(() => {
      // 字号偏好持久化失败不影响终端使用。
    });
  }, []);

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
          : pairingsRef.current.length > 0
            ? "devices"
            : "pairing",
      );
    },
    [persistAppLockConfig],
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
    relayRef.current?.close("app_lock_reset");
    relayRef.current = null;
    pairingsRef.current = [];
    pairingRef.current = null;
    pendingAutoOpenSessionsRef.current = false;
    pendingCreateRef.current = false;
    directBusinessReadyRef.current = false;
    lastInteractionPersistedAtRef.current = 0;
    appLockConfigRef.current = DEFAULT_APP_LOCK_CONFIG;

    setPairings([]);
    setPairing(null);
    setEditingPairing(undefined);
    clearLocalAgentData();
    setCreatingSession(false);
    setClosingSessionIds([]);
    setKillingSessionIds([]);
    setConnectionStatus("idle");
    setConnectionPath("relay");
    setConnectionMessage(t("appLock.reset.pairingMessage"));
    setPairingError(undefined);
    setPendingSecurityAction(null);
    setGestureSetupMode(null);
    setAppLockConfig(DEFAULT_APP_LOCK_CONFIG);
    setSelectedAutoLockOption(DEFAULT_AUTO_LOCK_OPTION);
    setAppLockMode("firstRunPrompt");
    setView("pairing");
  }, [t]);

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

  // 用户切换偏好时持久化；首次加载未完成前不写回，避免覆盖磁盘值。
  // 切换会立即触发 useEffect 重建 transport（因为 transportPreference 是依赖项），
  // 同时若旧/新偏好涉及 prefer_p2p（UI 展示为 Direct only），需要弹确认让用户明确知晓
  // "立即重连 + Direct only 模式失败不会回退到 Relay"的副作用。
  //
  // 注意：RN 的 `Alert.alert` 在 web 端是 no-op，会导致 web 用户点 "Direct only"
  // 后无任何反馈。这里统一改用项目内的跨端 `useConfirm`（基于 RN `Modal`，
  // web/native 表现一致），保证三端都能弹出确认。
  const handleChangeTransportPreference = useCallback(
    (next: TransportPreference) => {
      const persist = (value: TransportPreference) => {
        setTransportPreferenceState(value);
        AsyncStorage.setItem(TRANSPORT_PREFERENCE_STORAGE_KEY, value).catch(
          () => {
            // 非关键路径：偏好下次启动会回退到 appConfig 默认值。
          },
        );
      };
      if (next === "prefer_p2p") {
        confirm({
          title: "Switch to Direct only?",
          message:
            "The App will reconnect immediately. After a direct link is ready, no relay server will carry session payload data. The session may fail if a direct link cannot be established.",
          confirmText: "Switch",
          cancelText: "Cancel",
          tone: "primary",
          // 语义上是"切换连接路径"而非"删除"，覆盖默认的 trash 图标。
          confirmIcon: "plug",
        })
          .then((confirmed) => {
            if (confirmed) {
              persist(next);
            }
          })
          .catch(() => {
            // confirm Promise 不应 reject；保底吞掉。
          });
        return;
      }
      persist(next);
    },
    [confirm],
  );

  useEffect(() => {
    if (!pairing) {
      relayRef.current?.close();
      relayRef.current = null;
      setConnectionStatus("idle");
      setConnectionPath("relay");
      setConnectionMessage("Enter the Mac Agent key to pair.");
      return undefined;
    }

    let closed = false;
    const relay = createAppSessionTransport(pairing, transportPreference, {
      onForceClose: (reason) => {
        if (closed) {
          return;
        }
        // 严格 P2P 模式下协商或运行期失败 → 关闭 session 并把错误透出到 UI。
        // 不会回退到 Relay；用户需要切换 transport_preference 或重连才能继续。
        setConnectionStatus("failed");
        setConnectionMessage(formatStrictForceCloseMessage(reason));
      },
    });
    relayRef.current = relay;
    directBusinessReadyRef.current = false;
    if (transportPreference === "prefer_p2p") {
      clearLocalAgentData();
    }
    setConnectionStatus("connecting");
    setConnectionPath(relay.getCurrentPath());
    setConnectionMessage("Opening secure connection...");

    const unsubscribe = relay.onMessage((message) => {
      if (closed) {
        return;
      }
      handleRelayMessage(message, relay, pairing);
    });
    const unsubscribeClose = relay.onClose((event) => {
      if (closed) {
        return;
      }
      setConnectionStatus("failed");
      setConnectionMessage(formatRelayCloseMessage(event));
    });
    const unsubscribePathChange = relay.onPathChange((path) => {
      setConnectionPath(path);
      if (
        transportPreference === "prefer_p2p" &&
        path === "p2p" &&
        directBusinessReadyRef.current
      ) {
        markDirectConnectionReady();
      }
    });
    const unsubscribeBusinessReady = relay.onBusinessReady(() => {
      directBusinessReadyRef.current = true;
      if (
        transportPreference === "prefer_p2p" &&
        relay.getCurrentPath() === "p2p"
      ) {
        markDirectConnectionReady();
      }
    });

    relay
      .connect()
      .then(() => {
        if (!closed) {
          setConnectionStatus("authenticating");
          setConnectionMessage("Waiting for key proof challenge...");
        }
      })
      .catch((error: unknown) => {
        if (!closed) {
          setConnectionStatus("failed");
          setConnectionMessage(
            `Secure connection failed: ${formatErrorMessage(error)}`,
          );
        }
      });

    return () => {
      closed = true;
      unsubscribe();
      unsubscribeClose();
      unsubscribePathChange();
      unsubscribeBusinessReady();
      relay.close();
      if (relayRef.current === relay) {
        relayRef.current = null;
      }
    };
  }, [pairing, transportPreference]);

  // 进入后台时释放 P2P；回到前台后主动通知 Relay 清退避并立即 propose，
  // 不再依赖下一轮被动升级窗口。strict P2P 下业务消息仍由 strict 队列暂存，
  // 不会回退到 relay path 承载。
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      const relay = relayRef.current;
      const previous = appStateRef.current;
      appStateRef.current = next;
      if (
        appLockAvailable &&
        next === "active" &&
        previous !== "active" &&
        appLockModeRef.current === "unlocked" &&
        shouldLockForInactivity(appLockConfigRef.current)
      ) {
        setAppLockMode("locked");
      }
      if (!relay) {
        return;
      }
      if (relay.isStrictP2p()) {
        if (next === "active") {
          relay.resumeForForeground();
          if (previous !== "active") {
            relay.requestP2pReconnect("foreground_resume");
            requestTerminalSnapshotForCurrentSession();
          }
        } else {
          relay.pauseForBackground();
        }
        return;
      }
      if (next !== "active") {
        relay.forceDowngrade("app_background");
      } else if (previous !== "active") {
        relay.requestP2pReconnect("foreground_resume");
        requestTerminalSnapshotForCurrentSession();
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    return subscribeNetworkChanges((event) => {
      relayRef.current?.requestP2pReconnect("network_changed", event);
      requestTerminalSnapshotForCurrentSession();
    });
  }, []);

  useEffect(() => {
    if (connectionPath === "p2p" && connectionStatus === "authenticated") {
      if (transportPreference !== "prefer_p2p") {
        requestAgentStateRefresh();
      }
      requestTerminalSnapshotForCurrentSession();
    }
  }, [
    connectionPath,
    connectionStatus,
    selectedSession?.session_id,
    transportPreference,
  ]);

  useEffect(() => {
    if (connectionPath !== "p2p" || connectionStatus !== "authenticated") {
      return undefined;
    }
    const timer = setInterval(() => {
      const session = selectedSessionRef.current;
      if (!session) {
        return;
      }
      const lastFrameAt =
        terminalLastFrameAtRef.current[session.session_id] ?? 0;
      if (Date.now() - lastFrameAt >= 3_000) {
        requestTerminalSnapshotForCurrentSession();
      }
    }, 3_000);
    return () => clearInterval(timer);
  }, [connectionPath, connectionStatus]);

  useEffect(() => {
    if (
      connectionStatus !== "authenticated" ||
      view !== "terminal" ||
      !pairing ||
      !selectedSession
    ) {
      return undefined;
    }

    // 进入终端页时主动拉取一次 snapshot；后续帧由 Mac Agent 按内容变化主动 push（terminal.frame）。
    requestTerminalSnapshot(pairing.deviceId, selectedSession.session_id);
    return undefined;
  }, [connectionStatus, pairing, selectedSession, view]);

  useEffect(() => {
    // 仅在用户已经进入到依赖 Agent 数据的页面时弹出重连提示，
    // 避免在 devices 页（已有连接状态条）上重复打扰用户。
    if (
      connectionStatus !== "failed" ||
      !pairing ||
      (view !== "sessions" &&
        view !== "terminal" &&
        view !== "terminalFiles") ||
      failureDialogActiveRef.current
    ) {
      return;
    }

    failureDialogActiveRef.current = true;
    const message = connectionMessage || "Lost connection to the Mac Agent.";
    confirm({
      title: "Connection lost",
      message: `${message}\n\nRetry now or return to the device list?`,
      confirmText: "Retry",
      cancelText: "Back to devices",
      tone: "primary",
    })
      .then((retry) => {
        failureDialogActiveRef.current = false;
        if (retry) {
          reconnectActivePairing();
        } else {
          setSelectedSession(null);
          setView("devices");
        }
      })
      .catch(() => {
        failureDialogActiveRef.current = false;
      });
  }, [confirm, connectionMessage, connectionStatus, pairing, view]);

  async function handlePair(nextPairing: PairingConfig): Promise<void> {
    setPairingError(undefined);
    const nextPairings = editingPairing
      ? pairings.map((item) =>
          isSamePairing(item, editingPairing) ? nextPairing : item,
        )
      : upsertPairing(pairings, nextPairing);
    await savePairings(nextPairings);
    setPairings(nextPairings);
    setPairing(nextPairing);
    setEditingPairing(undefined);
    setView("devices");
  }

  async function handlePairingUrl(url: string): Promise<void> {
    const nextPairing = parsePairingConfig(url);
    if (!nextPairing && isEncryptedPairingConfig(url)) {
      setPendingEncryptedPairingLink(url);
      setEncryptedPairingPassword("");
      setEncryptedPairingError(undefined);
      setConnectionMessage("Encrypted pairing link detected.");
      return;
    }
    if (!nextPairing) {
      Alert.alert(
        "Invalid pairing link",
        "Open or paste the pairing link generated by the Mac Agent.",
      );
      return;
    }

    setPairingError(undefined);
    setConnectionMessage("Pairing imported from link. Connecting...");
    await saveAndActivatePairing(nextPairing, pairingsRef.current, {
      autoOpenSessions: true,
    });
  }

  async function handleEncryptedPairingSubmit(): Promise<void> {
    if (!pendingEncryptedPairingLink) {
      return;
    }
    if (encryptedPairingPassword.length !== 4) {
      setEncryptedPairingError(t("pairing.encrypted.passwordRequired"));
      return;
    }
    const nextPairing = decryptPairingConfig(
      pendingEncryptedPairingLink,
      encryptedPairingPassword,
    );
    if (!nextPairing) {
      setEncryptedPairingError(t("pairing.encrypted.invalidPassword"));
      return;
    }
    setPairingError(undefined);
    setEncryptedPairingError(undefined);
    setPendingEncryptedPairingLink(undefined);
    setEncryptedPairingPassword("");
    setConnectionMessage("Pairing imported from link. Connecting...");
    await saveAndActivatePairing(nextPairing, pairingsRef.current, {
      autoOpenSessions: true,
    });
  }

  function handleEncryptedPairingCancel(): void {
    setPendingEncryptedPairingLink(undefined);
    setEncryptedPairingPassword("");
    setEncryptedPairingError(undefined);
  }

  async function saveAndActivatePairing(
    nextPairing: PairingConfig,
    basePairings: PairingConfig[],
    options: { autoOpenSessions?: boolean } = {},
  ): Promise<void> {
    const nextPairings = upsertPairing(basePairings, nextPairing);
    await savePairings(nextPairings);
    pendingAutoOpenSessionsRef.current = Boolean(options.autoOpenSessions);
    pairingsRef.current = nextPairings;
    setPairings(nextPairings);
    setPairing(nextPairing);
    setEditingPairing(undefined);
    setView("devices");
  }

  function handleAddDevice(): void {
    setPairingError(undefined);
    setEditingPairing(undefined);
    setView("pairing");
  }

  function handleEditDevice(nextPairing: PairingConfig): void {
    setPairingError(undefined);
    setEditingPairing(nextPairing);
    setView("pairing");
  }

  function handleCancelPairing(): void {
    setEditingPairing(undefined);
    setView(pairings.length > 0 ? "devices" : "pairing");
  }

  async function handleDeleteDevice(
    targetPairing: PairingConfig,
  ): Promise<void> {
    const deviceName = getPairingDisplayName(targetPairing);
    const confirmed = await confirm({
      title: "Delete device",
      message: `Delete ${deviceName} from linked devices?`,
      confirmText: "Delete",
    });
    if (!confirmed) {
      return;
    }

    removeDevice(targetPairing).catch((error: unknown) => {
      setPairingError(`Could not delete device: ${String(error)}`);
    });
  }

  async function removeDevice(targetPairing: PairingConfig): Promise<void> {
    const nextPairings = await removeSavedPairing(targetPairing);
    setSessions([]);
    setAgentProviders(fallbackAgentProviders());
    setWorkspaces([]);
    setSelectedSession(null);
    setSelectedWorkspace(null);
    setTerminalFrames({});
    setClosingSessionIds([]);
    setKillingSessionIds([]);
    setEditingPairing(undefined);

    if (pairing && isSamePairing(pairing, targetPairing)) {
      relayRef.current?.close();
      setPairing(nextPairings[0] ?? null);
    }

    setView(nextPairings.length > 0 ? "devices" : "pairing");
  }

  /**
   * 处理鉴权失败后的本地清理：
   * - 保留已保存的 pairing 条目（这样用户在 Device Center 里仍能看到该设备，
   *   可主动 Edit 修正 key 或 Delete）；过去会自动删除该 pairing 并把用户
   *   丢回 Pairing 页，但 web 端 RN `Alert.alert` 是 no-op，导致体感上是
   *   "保存失败、设备被静默删除、重新弹出输入界面"。
   * - 把当前会话/工作区状态全部置空，避免误用上一次会话状态；
   * - 通过 connectionMessage / pairingError 透出失败原因。
   */
  async function handleAuthFailureCleanup(
    targetPairing: PairingConfig,
    reason: string,
  ): Promise<void> {
    setSessions([]);
    setAgentProviders(fallbackAgentProviders());
    setWorkspaces([]);
    setSelectedSession(null);
    setSelectedWorkspace(null);
    setTerminalFrames({});
    setClosingSessionIds([]);
    setKillingSessionIds([]);

    const errorText = `Authentication failed for "${getPairingDisplayName(
      targetPairing,
    )}": ${reason}. Edit the device to enter a new key, or delete it.`;
    setConnectionStatus("failed");
    setConnectionMessage(errorText);
    setPairingError(errorText);

    if (view === "pairing" && editingPairing) {
      // 用户正在 Edit 当前 pairing 时被打回，保留 editingPairing 让其继续修改。
      return;
    }
    setEditingPairing(undefined);
    setView("devices");
  }

  async function removeSavedPairing(
    targetPairing: PairingConfig,
  ): Promise<PairingConfig[]> {
    const nextPairings = pairingsRef.current.filter(
      (item) => !isSamePairing(item, targetPairing),
    );
    if (nextPairings.length > 0) {
      await savePairings(nextPairings);
    } else {
      await clearPairing();
    }

    pairingsRef.current = nextPairings;
    setPairings(nextPairings);
    return nextPairings;
  }

  function handleOpenDevice(nextPairing: PairingConfig): void {
    if (!pairing || !isSamePairing(pairing, nextPairing)) {
      setPairing(nextPairing);
      setSessions([]);
      setAgentProviders(fallbackAgentProviders());
      setWorkspaces([]);
      setSelectedSession(null);
      setSelectedWorkspace(null);
      setTerminalFrames({});
      setClosingSessionIds([]);
      setKillingSessionIds([]);
      setView("devices");
      return;
    }

    if (connectionStatus === "authenticated") {
      setView("sessions");
      sendToRelay(listSessionsRequest(nextPairing.deviceId));
      return;
    }

    // 用户主动进入设备时若连接已经失败/空闲，主动触发一次重连，
    // 避免列表页一直停留在 "Waiting for ... data" 状态。
    if (connectionStatus === "failed" || connectionStatus === "idle") {
      reconnectActivePairing();
      setView("sessions");
    }
  }

  function reconnectActivePairing(): void {
    if (!pairing) {
      return;
    }
    failureDialogActiveRef.current = false;
    setConnectionStatus("connecting");
    setConnectionMessage("Reconnecting securely...");
    // 通过创建一个新的 pairing 引用强制触发上面的连接 useEffect
    // （依赖 pairing 引用变化），从而重建 transport。
    setPairing({ ...pairing });
  }

  function handleRefreshSessions(): void {
    if (!pairing) {
      return;
    }
    if (connectionStatus !== "authenticated") {
      reconnectActivePairing();
      return;
    }
    sendToRelay(listSessionsRequest(pairing.deviceId));
    sendToRelay(listWorkspacesRequest(pairing.deviceId));
  }

  function handleCreateSession(input: {
    cwd: string;
    runtimeKind: RuntimeKind;
    workspacePath?: string;
  }): void {
    if (!pairing || connectionStatus !== "authenticated") {
      return;
    }
    pendingCreateRef.current = true;
    setCreatingSession(true);
    sendToRelay(
      createSessionRequest(pairing.deviceId, {
        cwd: input.cwd,
        workspace_path: input.workspacePath,
        runtime_kind: input.runtimeKind,
        terminal_size: computeInitialTerminalSize(terminalTextSize),
      }),
    );
  }

  function updateWorkspaceDataCache(
    workspacePath: string,
    updater: (cache: WorkspaceDataCache) => WorkspaceDataCache,
  ): void {
    setWorkspaceCache((current) => {
      const existing = current[workspacePath] ?? createWorkspaceDataCache();
      return {
        ...current,
        [workspacePath]: updater(existing),
      };
    });
  }

  function requestWorkspaceDirectory(
    workspace: WorkspaceDefinition,
    relativePath: string,
    options: { force?: boolean; activate?: boolean } = {},
  ): void {
    if (!pairing || connectionStatus !== "authenticated") {
      return;
    }
    const activate = options.activate ?? true;
    const workspacePath = workspace.path;
    const filesCache =
      workspaceCache[workspacePath]?.files ?? createWorkspaceFilesCache();
    const hasCachedEntries = Boolean(filesCache.directoriesByPath[relativePath]);
    if (!options.force && hasCachedEntries) {
      if (activate) {
        updateWorkspaceDataCache(workspacePath, (cache) => ({
          ...cache,
          files: {
            ...cache.files,
            currentPath: relativePath,
            selectedFilePath: undefined,
          },
        }));
      }
      return;
    }
    if (filesCache.loadingDirectoryKeys[relativePath]) {
      if (activate) {
        updateWorkspaceDataCache(workspacePath, (cache) => ({
          ...cache,
          files: {
            ...cache.files,
            currentPath: relativePath,
            selectedFilePath: undefined,
          },
        }));
      }
      return;
    }
    updateWorkspaceDataCache(workspacePath, (cache) => ({
      ...cache,
      files: {
        ...cache.files,
        currentPath: activate ? relativePath : cache.files.currentPath,
        selectedFilePath: activate ? undefined : cache.files.selectedFilePath,
        loadingDirectoryKeys: {
          ...cache.files.loadingDirectoryKeys,
          [relativePath]: true,
        },
      },
    }));
    sendToRelay(
      listFilesRequest(pairing.deviceId, {
        workspacePath,
        relativePath,
      }),
    );
  }

  function requestWorkspaceGitStatus(
    workspace: WorkspaceDefinition,
    options: { force?: boolean } = {},
  ): void {
    if (
      !pairing ||
      connectionStatus !== "authenticated" ||
      !workspace.isGitRepository
    ) {
      return;
    }
    const workspacePath = workspace.path;
    const gitCache =
      workspaceCache[workspacePath]?.git ?? createWorkspaceGitCache();
    if (!options.force && gitCache.status) {
      return;
    }
    if (gitCache.statusLoading) {
      return;
    }
    updateWorkspaceDataCache(workspacePath, (cache) => ({
      ...cache,
      git: {
        ...cache.git,
        statusLoading: true,
      },
    }));
    sendToRelay(gitStatusRequest(pairing.deviceId, { workspacePath }));
  }

  function handleOpenWorkspaceFiles(workspace: WorkspaceDefinition): void {
    setSelectedWorkspace(workspace);
    const currentPath = workspaceCache[workspace.path]?.files.currentPath ?? "";
    requestWorkspaceDirectory(workspace, currentPath, { activate: true });
  }

  function handleRefreshWorkspaceFiles(
    workspace: WorkspaceDefinition,
    relativePath: string,
  ): void {
    setSelectedWorkspace(workspace);
    requestWorkspaceDirectory(workspace, relativePath, {
      activate: true,
      force: true,
    });
  }

  function handleOpenWorkspaceGit(workspace: WorkspaceDefinition): void {
    setSelectedWorkspace(workspace);
    requestWorkspaceGitStatus(workspace);
  }

  function handleRefreshWorkspaceGit(workspace: WorkspaceDefinition): void {
    setSelectedWorkspace(workspace);
    updateWorkspaceDataCache(workspace.path, (cache) => ({
      ...cache,
      git: {
        ...cache.git,
        diffCache: {},
        diffLoadingKeys: {},
        fileContentCache: {},
        fileContentLoadingKeys: {},
      },
    }));
    requestWorkspaceGitStatus(workspace, { force: true });
  }

  function handlePrefetchWorkspaceTab(
    workspace: WorkspaceDefinition,
    tab: "git" | "files",
  ): void {
    if (tab === "files") {
      requestWorkspaceDirectory(workspace, "", { activate: false });
    }
    if (tab === "git") {
      requestWorkspaceGitStatus(workspace);
    }
  }

  function handleOpenDirectory(relativePath: string): void {
    if (!selectedWorkspace) {
      return;
    }
    requestWorkspaceDirectory(selectedWorkspace, relativePath, {
      activate: true,
    });
  }

  function requestWorkspaceFile(
    workspace: WorkspaceDefinition,
    relativePath: string,
    options: { activatePreview?: boolean; force?: boolean } = {},
  ): void {
    if (!pairing || connectionStatus !== "authenticated") {
      return;
    }
    const activatePreview = options.activatePreview ?? true;
    const workspacePath = workspace.path;
    const filesCache =
      workspaceCache[workspacePath]?.files ?? createWorkspaceFilesCache();
    if (!options.force && filesCache.filesByPath[relativePath]) {
      if (activatePreview) {
        updateWorkspaceDataCache(workspacePath, (cache) => ({
          ...cache,
          files: {
            ...cache.files,
            selectedFilePath: relativePath,
          },
        }));
      }
      return;
    }
    if (filesCache.loadingFileKeys[relativePath]) {
      if (activatePreview) {
        updateWorkspaceDataCache(workspacePath, (cache) => ({
          ...cache,
          files: {
            ...cache.files,
            selectedFilePath: relativePath,
          },
        }));
      }
      return;
    }
    updateWorkspaceDataCache(workspacePath, (cache) => ({
      ...cache,
      files: {
        ...cache.files,
        selectedFilePath: activatePreview ? relativePath : cache.files.selectedFilePath,
        loadingFileKeys: {
          ...cache.files.loadingFileKeys,
          [relativePath]: true,
        },
      },
    }));
    sendToRelay(
      readFileRequest(pairing.deviceId, {
        workspacePath,
        relativePath,
      }),
    );
  }

  function handleReadFile(relativePath: string): void {
    if (!selectedWorkspace) {
      return;
    }
    requestWorkspaceFile(selectedWorkspace, relativePath, {
      activatePreview: true,
    });
  }

  function handleOpenFileEditor(
    workspace: WorkspaceDefinition,
    relativePath: string,
  ): void {
    setSelectedWorkspace(workspace);
    setFileEditorPath(relativePath);
    setFileEditorReturnView(view);
    setLastFileWriteResult(undefined);
    setView("fileEditor");
    requestWorkspaceFile(workspace, relativePath, { activatePreview: false });
  }

  function handleReloadEditorFile(): void {
    if (!selectedWorkspace || !fileEditorPath) {
      return;
    }
    setLastFileWriteResult(undefined);
    requestWorkspaceFile(selectedWorkspace, fileEditorPath, {
      activatePreview: false,
      force: true,
    });
  }

  function handleSaveEditorFile(content: string, baseHash: string): void {
    if (
      !pairing ||
      !selectedWorkspace ||
      !fileEditorPath ||
      connectionStatus !== "authenticated"
    ) {
      return;
    }
    const workspacePath = selectedWorkspace.path;
    const writeKey = toWorkspaceFileKey(workspacePath, fileEditorPath);
    setFileWriteLoadingKeys((current) => ({ ...current, [writeKey]: true }));
    setLastFileWriteResult(undefined);
    sendToRelay(
      writeFileRequest(pairing.deviceId, {
        workspacePath,
        relativePath: fileEditorPath,
        content,
        encoding: "utf8",
        baseHash,
      }),
    );
  }

  function handleEditorContentChange(): void {
    if (lastFileWriteResult) {
      setLastFileWriteResult(undefined);
    }
  }

  function handleCloseFileEditor(): void {
    setView(fileEditorReturnView);
  }

  function handleCloseFilePreview(): void {
    if (!selectedWorkspace) {
      return;
    }
    updateWorkspaceDataCache(selectedWorkspace.path, (cache) => ({
      ...cache,
      files: {
        ...cache.files,
        selectedFilePath: undefined,
      },
    }));
  }

  function requestGitDiff(
    workspace: WorkspaceDefinition,
    relativePath?: string,
    scope: GitDiffScope = "unstaged",
    options: { activate?: boolean } = {},
  ): void {
    if (!pairing || connectionStatus !== "authenticated") {
      return;
    }
    const activate = options.activate ?? true;
    const workspacePath = workspace.path;
    const cacheKey = toGitDiffCacheKey(relativePath, scope);
    const gitCache =
      workspaceCache[workspacePath]?.git ?? createWorkspaceGitCache();
    const cachedDiff = gitCache.diffCache[cacheKey];
    if (cachedDiff) {
      if (activate) {
        updateWorkspaceDataCache(workspacePath, (cache) => ({
          ...cache,
          git: {
            ...cache.git,
            activeDiffKey: cacheKey,
          },
        }));
      }
      return;
    }
    if (gitCache.diffLoadingKeys[cacheKey]) {
      if (activate) {
        updateWorkspaceDataCache(workspacePath, (cache) => ({
          ...cache,
          git: {
            ...cache.git,
            activeDiffKey: cacheKey,
          },
        }));
      }
      return;
    }
    updateWorkspaceDataCache(workspacePath, (cache) => ({
      ...cache,
      git: {
        ...cache.git,
        activeDiffKey: activate ? cacheKey : cache.git.activeDiffKey,
        diffLoadingKeys: {
          ...cache.git.diffLoadingKeys,
          [cacheKey]: true,
        },
      },
    }));
    sendToRelay(
      gitDiffRequest(pairing.deviceId, {
        workspacePath,
        relativePath,
        scope,
      }),
    );
  }

  function handleOpenGitDiff(
    relativePath?: string,
    scope: GitDiffScope = "unstaged",
  ): void {
    if (!selectedWorkspace) {
      return;
    }
    requestGitDiff(selectedWorkspace, relativePath, scope, { activate: true });
  }

  function handleOpenGitReview(
    workspace: WorkspaceDefinition,
    relativePath?: string,
    scope: GitDiffScope = "all",
  ): void {
    setSelectedWorkspace(workspace);
    setGitReviewPath(relativePath);
    setGitReviewScope(scope);
    setView("gitReview");
    requestGitDiff(workspace, relativePath, scope, { activate: true });
  }

  function handlePrefetchGitDiff(
    relativePath?: string,
    scope: GitDiffScope = "unstaged",
  ): void {
    if (
      !selectedWorkspace ||
      connectionStatus !== "authenticated"
    ) {
      return;
    }
    requestGitDiff(selectedWorkspace, relativePath, scope, { activate: false });
  }

  function handleReadGitFileContent(relativePath: string): void {
    if (
      !pairing ||
      !selectedWorkspace ||
      connectionStatus !== "authenticated"
    ) {
      return;
    }
    const workspacePath = selectedWorkspace.path;
    const gitCache =
      workspaceCache[workspacePath]?.git ?? createWorkspaceGitCache();
    if (
      gitCache.fileContentCache[relativePath] ||
      gitCache.fileContentLoadingKeys[relativePath]
    ) {
      return;
    }
    updateWorkspaceDataCache(workspacePath, (cache) => ({
      ...cache,
      git: {
        ...cache.git,
        fileContentLoadingKeys: {
          ...cache.git.fileContentLoadingKeys,
          [relativePath]: true,
        },
      },
    }));
    sendToRelay(
      readFileRequest(pairing.deviceId, {
        workspacePath,
        relativePath,
      }),
    );
  }

  async function handleCloseSession(session: CodexSession): Promise<void> {
    if (!pairing || connectionStatus !== "authenticated") {
      return;
    }

    const external = session.origin === "external";
    const removeOnly =
      session.status === "exited" || session.status === "archived";
    const title = external
      ? "Forget tmux session"
      : removeOnly
        ? "Remove session"
        : "Close session";
    const message = external
      ? `Forget ${session.title} in OmniWork? The tmux session will keep running on the Mac.`
      : removeOnly
        ? `Remove ${session.title} from OmniWork? The session is not interactive.`
        : `Close ${session.title} on the Mac Agent?`;
    const confirmed = await confirm({
      title,
      message,
      confirmText: external ? "Forget" : removeOnly ? "Remove" : "Close",
    });
    if (!confirmed) {
      return;
    }

    setClosingSessionIds((current) =>
      current.includes(session.session_id)
        ? current
        : [...current, session.session_id],
    );
    sendToRelay(closeSessionRequest(pairing.deviceId, session.session_id));
  }

  function handleRenameSession(session: CodexSession, title: string): void {
    if (!pairing || connectionStatus !== "authenticated") {
      return;
    }

    const nextTitle = title.trim();
    if (!nextTitle || nextTitle === session.title) {
      return;
    }

    setSessions((current) =>
      current.map((item) =>
        item.session_id === session.session_id
          ? { ...item, title: nextTitle }
          : item,
      ),
    );
    setSelectedSession((current) =>
      current?.session_id === session.session_id
        ? { ...current, title: nextTitle }
        : current,
    );
    sendToRelay(
      renameSessionRequest(pairing.deviceId, session.session_id, nextTitle),
    );
  }

  async function handleKillTmuxSession(session: CodexSession): Promise<void> {
    if (!pairing || connectionStatus !== "authenticated") {
      return;
    }

    const confirmed = await confirm({
      title: "Kill tmux session",
      message: `Really kill ${session.title}? This will close the tmux session on the Mac and cannot be undone.`,
      confirmText: "Kill tmux",
    });
    if (!confirmed) {
      return;
    }

    setKillingSessionIds((current) =>
      current.includes(session.session_id)
        ? current
        : [...current, session.session_id],
    );
    sendToRelay(killTmuxSessionRequest(pairing.deviceId, session.session_id));
  }

  function handleOpenSession(session: CodexSession): void {
    const capabilities = getSessionCapabilities(session);
    if (!capabilities.canOpen) {
      setConnectionMessage(
        capabilities.unavailableReason ?? "This session is not ready to open.",
      );
      return;
    }

    // 连接掉线时直接进终端会让用户面对 "Waiting for snapshot..."，
    // 改为先发起重连，由 connectionStatus 的 effect 提示用户。
    if (connectionStatus !== "authenticated") {
      reconnectActivePairing();
      return;
    }

    setSelectedSession(session);
    setView("terminal");
    if (pairing) {
      sendToRelay(
        createMessage(
          "session.attach",
          { session_id: session.session_id },
          {
            device_id: pairing.deviceId,
            session_id: session.session_id,
          },
        ),
      );
      requestTerminalSnapshot(pairing.deviceId, session.session_id);
    }
  }

  function handleOpenTerminalFiles(session: CodexSession): void {
    const workspace = getSessionFilesWorkspace(session, workspaces);
    setSelectedWorkspace(workspace);
    requestWorkspaceDirectory(
      workspace,
      workspaceCache[workspace.path]?.files.currentPath ?? "",
      { activate: true },
    );
    setView("terminalFiles");
  }

  function handleTerminalInput(input: TerminalInputPayload): void {
    if (!pairing || !selectedSession || connectionStatus !== "authenticated") {
      return;
    }
    const capabilities = getSessionCapabilities(selectedSession, {
      closing: closingSessionIds.includes(selectedSession.session_id),
      killing: killingSessionIds.includes(selectedSession.session_id),
    });
    if (!capabilities.canInput) {
      setConnectionMessage(
        capabilities.unavailableReason ??
          "This session is not accepting input right now.",
      );
      return;
    }

    sendToRelay(
      terminalInputRequest(pairing.deviceId, selectedSession.session_id, input),
    );
    // Mac Agent 会基于 PTY 内容哈希自动 push terminal.frame，App 不再做事后多次轮询。
  }

  function handleTerminalResize(size: TerminalResizePayload): void {
    if (!pairing || !selectedSession || connectionStatus !== "authenticated") {
      return;
    }
    const capabilities = getSessionCapabilities(selectedSession, {
      closing: closingSessionIds.includes(selectedSession.session_id),
      killing: killingSessionIds.includes(selectedSession.session_id),
    });
    if (!capabilities.canResize) {
      return;
    }

    setSelectedSession((current) =>
      current && current.session_id === selectedSession.session_id
        ? { ...current, terminal_size: size }
        : current,
    );
    setSessions((current) =>
      current.map((session) =>
        session.session_id === selectedSession.session_id
          ? { ...session, terminal_size: size }
          : session,
      ),
    );
    sendToRelay(
      terminalResizeRequest(pairing.deviceId, selectedSession.session_id, size),
    );
    requestTerminalSnapshot(pairing.deviceId, selectedSession.session_id);
  }

  function requestTerminalSnapshot(deviceId: string, sessionId: string): void {
    sendToRelay(terminalSnapshotRequest(deviceId, sessionId));
  }

  function requestTerminalSnapshotForCurrentSession(): void {
    const activePairing = pairingRef.current;
    const session = selectedSessionRef.current;
    if (!activePairing || !session) {
      return;
    }
    const now = Date.now();
    const lastRequest =
      terminalLastSnapshotRequestAtRef.current[session.session_id] ?? 0;
    if (now - lastRequest < 2_000) {
      return;
    }
    terminalLastSnapshotRequestAtRef.current[session.session_id] = now;
    sendToRelay(
      terminalSnapshotRequest(activePairing.deviceId, session.session_id),
    );
  }

  function requestAgentStateRefresh(): void {
    const activePairing = pairingRef.current;
    if (!activePairing) {
      return;
    }
    sendToRelay(listSessionsRequest(activePairing.deviceId));
    sendToRelay(listWorkspacesRequest(activePairing.deviceId));
  }

  function markDirectConnectionReady(): void {
    setConnectionStatus("authenticated");
    setConnectionMessage("Direct P2P connection is ready.");
    requestAgentStateRefresh();
    if (pendingAutoOpenSessionsRef.current) {
      pendingAutoOpenSessionsRef.current = false;
      setView("sessions");
    }
  }

  function clearLocalAgentData(): void {
    setSessions([]);
    setAgentProviders(fallbackAgentProviders());
    setWorkspaces([]);
    setSelectedSession(null);
    setSelectedWorkspace(null);
    setWorkspaceCache({});
    setGitReviewPath(undefined);
    setGitReviewScope("all");
    setDefaultSessionCwd("");
    setTerminalFrames({});
    pendingTerminalFramesRef.current = {};
    terminalFrameSeqRef.current = {};
    terminalLastFrameAtRef.current = {};
    terminalLastSnapshotRequestAtRef.current = {};
  }

  function sendToRelay(message: MessageEnvelope): void {
    try {
      relayRef.current?.send(message);
    } catch (error: unknown) {
      setConnectionStatus("failed");
      setConnectionMessage(`Relay send failed: ${formatErrorMessage(error)}`);
    }
  }

  function handleRelayMessage(
    message: MessageEnvelope,
    relay: AppSessionTransport,
    activePairing: PairingConfig,
  ): void {
    if (message.type.startsWith("tunnel.upgrade.")) {
      relay.handleUpgradeMessage(message);
      return;
    }
    switch (message.type) {
      case "auth.challenge":
        setConnectionStatus("authenticating");
        setConnectionMessage("Verifying temporary key...");
        break;
      case "auth.ok":
        failureDialogActiveRef.current = false;
        if (relay.isStrictP2p()) {
          clearLocalAgentData();
          setConnectionStatus("authenticating");
          setConnectionMessage("Establishing direct P2P connection...");
        } else {
          setConnectionStatus("authenticated");
          setConnectionMessage("Connected to Mac Agent.");
          relay.send(listSessionsRequest(activePairing.deviceId));
          relay.send(listWorkspacesRequest(activePairing.deviceId));
          if (pendingAutoOpenSessionsRef.current) {
            pendingAutoOpenSessionsRef.current = false;
            setView("sessions");
          }
        }
        break;
      case "auth.failed": {
        const payload = message.payload as AuthFailedPayload;
        setConnectionStatus("failed");
        setConnectionMessage(`Authentication failed: ${payload.reason}`);
        pendingAutoOpenSessionsRef.current = false;
        // 鉴权失败说明 Mac Agent 重启或 key 已失效，按 engineering-requirements.md
        // 中 "App 认证失败后清理旧 key" 的要求清除本地 pairing，并跳回配对页让用户输入新 key。
        relay.close();
        void handleAuthFailureCleanup(activePairing, payload.reason);
        break;
      }
      case "session.list": {
        const payload = message.payload as SessionListPayload;
        const remoteSessionIds = new Set(
          payload.sessions.map((session) => session.session_id),
        );
        const closableSessionIds = new Set(
          payload.sessions
            .filter((session) => session.registered !== false)
            .map((session) => session.session_id),
        );
        if (payload.default_cwd) {
          setDefaultSessionCwd(payload.default_cwd);
        }
        setAgentProviders(
          payload.providers?.length
            ? payload.providers
            : fallbackAgentProviders(),
        );
        if (payload.workspaces?.length) {
          setWorkspaces(payload.workspaces);
          setSelectedWorkspace((current) =>
            current
              ? (payload.workspaces?.find(
                  (workspace) => workspace.path === current.path,
                ) ?? current)
              : current,
          );
        }
        setSessions(payload.sessions);
        setSelectedSession((current) => {
          if (!current) {
            return current;
          }
          return (
            payload.sessions.find(
              (session) => session.session_id === current.session_id,
            ) ?? current
          );
        });
        setClosingSessionIds((current) =>
          current.filter((sessionId) => closableSessionIds.has(sessionId)),
        );
        setKillingSessionIds((current) =>
          current.filter((sessionId) => remoteSessionIds.has(sessionId)),
        );
        setTerminalFrames((current) => {
          const nextFrames = { ...current };
          for (const sessionId of Object.keys(nextFrames)) {
            if (!remoteSessionIds.has(sessionId)) {
              delete nextFrames[sessionId];
              delete terminalFrameSeqRef.current[sessionId];
              delete terminalLastFrameAtRef.current[sessionId];
              delete terminalLastSnapshotRequestAtRef.current[sessionId];
              delete pendingTerminalFramesRef.current[sessionId];
            }
          }
          return nextFrames;
        });
        if (
          selectedSessionRef.current &&
          !remoteSessionIds.has(selectedSessionRef.current.session_id)
        ) {
          setSelectedSession(null);
          setView("sessions");
        }
        setCreatingSession(false);
        break;
      }
      case "session.status": {
        const payload = message.payload as { session: CodexSession };
        setSessions((current) => upsertSession(current, payload.session));
        setSelectedSession((current) =>
          current?.session_id === payload.session.session_id
            ? payload.session
            : current,
        );
        if (pendingCreateRef.current) {
          if (isTransitionalSessionStatus(payload.session.status)) {
            setCreatingSession(true);
            setConnectionMessage(
              `${payload.session.title} is ${payload.session.status}.`,
            );
            break;
          }

          pendingCreateRef.current = false;
          setCreatingSession(false);
          const capabilities = getSessionCapabilities(payload.session);
          if (capabilities.canOpen) {
            setSelectedSession(payload.session);
            setView("terminal");
          } else {
            setConnectionMessage(
              capabilities.unavailableReason ??
                "Session was created but is not interactive.",
            );
            setView("sessions");
          }
        } else if (!isTransitionalSessionStatus(payload.session.status)) {
          setCreatingSession(false);
        }
        break;
      }
      case "workspace.list": {
        const payload = message.payload as WorkspaceListPayload;
        setWorkspaces(payload.workspaces);
        break;
      }
      case "files.list": {
        const payload = message.payload as FilesListPayload;
        updateWorkspaceDataCache(payload.workspacePath, (cache) => ({
          ...cache,
          files: {
            ...cache.files,
            directoriesByPath: {
              ...cache.files.directoriesByPath,
              [payload.relativePath]: payload.entries,
            },
            loadingDirectoryKeys: omitKey(
              cache.files.loadingDirectoryKeys,
              payload.relativePath,
            ),
          },
        }));
        break;
      }
      case "files.read": {
        const payload = message.payload as FilesReadPayload;
        updateWorkspaceDataCache(payload.workspacePath, (cache) => ({
          ...cache,
          files: {
            ...cache.files,
            filesByPath: {
              ...cache.files.filesByPath,
              [payload.relativePath]: payload,
            },
            loadingFileKeys: omitKey(
              cache.files.loadingFileKeys,
              payload.relativePath,
            ),
          },
          git: {
            ...cache.git,
            fileContentCache: {
              ...cache.git.fileContentCache,
              [payload.relativePath]: payload,
            },
            fileContentLoadingKeys: omitKey(
              cache.git.fileContentLoadingKeys,
              payload.relativePath,
            ),
          },
        }));
        break;
      }
      case "files.write": {
        const payload = message.payload as FilesWritePayload;
        const writeKey = toWorkspaceFileKey(
          payload.workspacePath,
          payload.relativePath,
        );
        const previousActiveDiffKey =
          workspaceCache[payload.workspacePath]?.git.activeDiffKey;
        const previousActiveDiff = parseGitDiffCacheKey(previousActiveDiffKey);
        setFileWriteLoadingKeys((current) => omitKey(current, writeKey));
        setLastFileWriteResult(payload);
        if (payload.status === "saved") {
          const savedFile: FilesReadPayload = {
            workspacePath: payload.workspacePath,
            relativePath: payload.relativePath,
            content: payload.content ?? "",
            encoding: "utf8",
            size: payload.size,
            modifiedAt: payload.modifiedAt,
            contentHash: payload.contentHash,
          };
          updateWorkspaceDataCache(payload.workspacePath, (cache) => ({
            ...cache,
            files: {
              ...cache.files,
              filesByPath: {
                ...cache.files.filesByPath,
                [payload.relativePath]: savedFile,
              },
            },
            git: {
              ...cache.git,
              statusLoading: true,
              diffCache: {},
              diffLoadingKeys: cache.git.activeDiffKey
                ? { [cache.git.activeDiffKey]: true }
                : {},
              fileContentCache: {
                ...cache.git.fileContentCache,
                [payload.relativePath]: savedFile,
              },
              fileContentLoadingKeys: omitKey(
                cache.git.fileContentLoadingKeys,
                payload.relativePath,
              ),
            },
          }));
          if (pairing && selectedWorkspace?.path === payload.workspacePath) {
            sendToRelay(
              gitStatusRequest(pairing.deviceId, {
                workspacePath: payload.workspacePath,
              }),
            );
            if (previousActiveDiff) {
              sendToRelay(
                gitDiffRequest(pairing.deviceId, {
                  workspacePath: payload.workspacePath,
                  relativePath: previousActiveDiff.relativePath,
                  scope: previousActiveDiff.scope,
                }),
              );
            }
          }
        }
        break;
      }
      case "git.status": {
        const payload = message.payload as GitStatusPayload;
        updateWorkspaceDataCache(payload.workspacePath, (cache) => ({
          ...cache,
          git: {
            ...cache.git,
            status: payload.status,
            statusLoading: false,
          },
        }));
        break;
      }
      case "git.diff": {
        const payload = message.payload as GitDiffPayload;
        const cacheKey = toGitDiffCacheKey(
          payload.relativePath,
          payload.scope ?? "unstaged",
        );
        updateWorkspaceDataCache(payload.workspacePath, (cache) => ({
          ...cache,
          git: {
            ...cache.git,
            diffCache: {
              ...cache.git.diffCache,
              [cacheKey]: payload,
            },
            diffLoadingKeys: omitKey(cache.git.diffLoadingKeys, cacheKey),
          },
        }));
        break;
      }
      case "terminal.snapshot": {
        const payload = message.payload as TerminalSnapshotPayload;
        if (message.session_id) {
          const nextWatermark = terminalFrameWatermarkAfterSnapshot(
            terminalFrameSeqRef.current[message.session_id],
            message.seq,
          );
          if (typeof nextWatermark === "number") {
            terminalFrameSeqRef.current[message.session_id] = nextWatermark;
          } else {
            delete terminalFrameSeqRef.current[message.session_id];
          }
          delete pendingTerminalFramesRef.current[message.session_id];
          terminalLastFrameAtRef.current[message.session_id] = Date.now();
          setTerminalFrames((current) => ({
            ...current,
            [message.session_id as string]: payload.data,
          }));
        }
        break;
      }
      case "terminal.frame": {
        const payload = message.payload as TerminalFramePayload;
        if (message.session_id) {
          queueTerminalFrame(message.session_id, payload, message.seq);
        }
        break;
      }
      case "terminal.error": {
        const payload = message.payload as TerminalErrorPayload;
        setCreatingSession(false);
        pendingCreateRef.current = false;
        const detail = payload.message || t("app.errors.terminalError");
        setConnectionMessage(detail);
        if (payload.code === "TMUX_TARGET_MISSING") {
          setSelectedSession(null);
          setView("sessions");
        }
        // session.create 等失败路径下，前端原本只是默默更新 connectionMessage，
        // 用户在 SessionListScreen 上根本看不到。这里用 confirm 弹一次性提示，
        // 让用户明确感知失败原因，避免"按了创建但什么也没发生"的体感。
        const title =
          payload.code === "SESSION_CREATE_FAILED"
            ? t("app.errors.failedCreateSession")
            : payload.code === "TMUX_TARGET_MISSING"
              ? t("app.errors.sessionUnavailable")
              : t("app.errors.macAgentError");
        confirm({
          title,
          message: detail,
          confirmText: t("app.actions.ok"),
          cancelText: "",
          tone: "danger",
        }).catch(() => {
          /* user dismissed */
        });
        break;
      }
      default:
        break;
    }
  }

  const selectedSessionCapabilities = selectedSession
    ? getSessionCapabilities(selectedSession, {
        closing: closingSessionIds.includes(selectedSession.session_id),
        killing: killingSessionIds.includes(selectedSession.session_id),
      })
    : null;
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

  return (
    <SafeAreaProvider>
      <SafeAreaView
        style={styles.root}
        edges={["top", "right", "bottom", "left"]}
      >
        <StatusBar barStyle="light-content" />
        {showHeader ? (
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            {canUseWorkspace ? (
              <Text style={styles.subtitle}>
                {getHeaderSubtitle(view, pairings.length, pairing, t)}
              </Text>
            ) : null}
          </View>
        ) : null}

        <View style={styles.content} onTouchStart={updateLastInteraction}>
          {appLockScreen ? (
            appLockScreen
          ) : view === "pairing" ? (
            <PairingScreen
              errorMessage={pairingError}
              initialPairing={editingPairing}
              submitLabel={
                editingPairing ? t("app.actions.saveDevice") : undefined
              }
              onCancel={pairings.length > 0 ? handleCancelPairing : undefined}
              onPair={handlePair}
            />
          ) : view === "devices" ? (
            <DeviceListScreen
              pairings={pairings}
              activePairing={pairing ?? undefined}
              connectionStatus={connectionStatus}
              connectionPath={connectionPath}
              connectionMessage={connectionMessage}
              onAddDevice={handleAddDevice}
              onEditDevice={handleEditDevice}
              onDeleteDevice={handleDeleteDevice}
              onOpenDevice={handleOpenDevice}
              onRefreshSessions={handleRefreshSessions}
            />
          ) : view === "settings" ? (
            <SettingsScreen
              terminalTextSize={terminalTextSize}
              language={language}
              onChangeLanguage={handleChangeLanguage}
              onChangeTerminalTextSize={handleChangeTerminalTextSize}
              onOpenConnectionPreference={() => setView("connectionPreference")}
              onOpenSecuritySettings={
                appLockAvailable ? () => setView("securitySettings") : undefined
              }
            />
          ) : view === "securitySettings" ? (
            <SecuritySettingsScreen
              config={appLockConfig}
              pickerVisible={autoLockPickerVisible}
              selectedAutoLockOption={selectedAutoLockOption}
              onBack={() => setView("settings")}
              onEnable={() => setGestureSetupMode("enable")}
              onChangeGesture={() => setPendingSecurityAction("change")}
              onDisable={() => setPendingSecurityAction("disable")}
              onOpenAutoLockPicker={() => {
                setSelectedAutoLockOption(appLockConfig.autoLockOption);
                setAutoLockPickerVisible(true);
              }}
              onCloseAutoLockPicker={() => setAutoLockPickerVisible(false)}
              onSelectAutoLockOption={setSelectedAutoLockOption}
              onConfirmAutoLockOption={handleConfirmAutoLockOption}
            />
          ) : view === "connectionPreference" ? (
            <ConnectionPreferenceScreen
              transportPreference={transportPreference}
              onChangeTransportPreference={handleChangeTransportPreference}
              onBack={() => setView("settings")}
            />
          ) : view === "sessions" ||
            view === "gitReview" ||
            view === "terminal" ||
            view === "terminalFiles" ||
            view === "fileEditor" ? (
            <>
              <SessionListScreen
                sessions={sessions}
                providers={agentProviders}
                workspaces={workspaces}
                providerPreferenceScope={pairing?.deviceId ?? "default"}
                creating={creatingSession}
                closingSessionIds={closingSessionIds}
                killingSessionIds={killingSessionIds}
                defaultCwd={defaultSessionCwd || sessions[0]?.cwd || ""}
                fileRelativePath={fileRelativePath}
                fileEntries={fileEntries}
                selectedFilePath={selectedFilePath}
                selectedFile={selectedFile}
                filesLoading={filesLoading}
                gitStatus={gitStatus}
                gitDiff={gitDiff}
                gitDiffCache={gitDiffCache}
                gitFileContentCache={gitFileContentCache}
                gitFileContentLoadingKeys={gitFileContentLoadingKeys}
                gitLoading={gitLoading}
                onBack={() => setView("devices")}
                onRefreshSessions={handleRefreshSessions}
                onCreateSession={handleCreateSession}
                onOpenWorkspaceFiles={handleOpenWorkspaceFiles}
                onOpenWorkspaceGit={handleOpenWorkspaceGit}
                onRefreshWorkspaceFiles={handleRefreshWorkspaceFiles}
                onRefreshWorkspaceGit={handleRefreshWorkspaceGit}
                onPrefetchWorkspaceTab={handlePrefetchWorkspaceTab}
                onOpenDirectory={handleOpenDirectory}
                onReadFile={handleReadFile}
                onEditFile={handleOpenFileEditor}
                onCloseFilePreview={handleCloseFilePreview}
                onOpenGitDiff={handleOpenGitDiff}
                onOpenGitReview={handleOpenGitReview}
                onPrefetchGitDiff={handlePrefetchGitDiff}
                onReadGitFileContent={handleReadGitFileContent}
                onOpenSession={handleOpenSession}
                onCloseSession={handleCloseSession}
                onRenameSession={handleRenameSession}
                onKillTmuxSession={handleKillTmuxSession}
              />
              {view === "gitReview" && selectedWorkspace ? (
                <View style={styles.fullScreenPage}>
                  <GitStatusScreen
                    workspace={selectedWorkspace}
                    status={gitStatus}
                    diff={gitDiff}
                    diffCache={gitDiffCache}
                    fileContentCache={gitFileContentCache}
                    fileContentLoadingKeys={gitFileContentLoadingKeys}
                    loading={gitDiffLoading}
                    initialMode="review"
                    initialPath={gitReviewPath}
                    initialScope={gitReviewScope}
                    onBack={() => setView("sessions")}
                    onRefresh={() => handleRefreshWorkspaceGit(selectedWorkspace)}
                    onOpenDiff={handleOpenGitDiff}
                    onEditFile={(relativePath) =>
                      handleOpenFileEditor(selectedWorkspace, relativePath)
                    }
                    onPrefetchDiff={handlePrefetchGitDiff}
                    onReadFileContent={handleReadGitFileContent}
                  />
                </View>
              ) : null}
              {(view === "terminal" || view === "terminalFiles") &&
              selectedSession ? (
                <View style={styles.fullScreenPage}>
                  <TerminalScreen
                    session={selectedSession}
                    frame={selectedFrame}
                    connectionStatus={connectionStatus}
                    statusLabel={connectionMessage}
                    readOnlyReason={
                      selectedSessionCapabilities?.canInput
                        ? undefined
                        : (selectedSessionCapabilities?.unavailableReason ??
                          t("app.errors.readOnlySession"))
                    }
                    canInput={Boolean(selectedSessionCapabilities?.canInput)}
                    canResize={Boolean(selectedSessionCapabilities?.canResize)}
                    textSize={terminalTextSize}
                    onBack={() => setView("sessions")}
                    onOpenFiles={() => handleOpenTerminalFiles(selectedSession)}
                    onChangeTextSize={handleChangeTerminalTextSize}
                    onRefreshSessions={handleRefreshSessions}
                    onInput={handleTerminalInput}
                    onResize={handleTerminalResize}
                  />
                </View>
              ) : null}
              {view === "terminalFiles" && selectedWorkspace ? (
                <Pressable
                  style={styles.presentedBackdrop}
                  onPress={() => setView("terminal")}
                >
                  <Pressable
                    style={styles.presentedPage}
                    onPress={(event) => event.stopPropagation()}
                  >
                    <FileBrowserScreen
                      workspace={selectedWorkspace}
                      relativePath={fileRelativePath}
                      entries={fileEntries}
                      selectedFilePath={selectedFilePath}
                      file={selectedFile}
                      loading={filesLoading}
                      presentation="modal"
                      onBack={() => setView("terminal")}
                      onRefresh={() =>
                        handleRefreshWorkspaceFiles(
                          selectedWorkspace,
                          fileRelativePath,
                        )
                      }
                      onOpenDirectory={handleOpenDirectory}
                      onReadFile={handleReadFile}
                      onEditFile={(relativePath) =>
                        handleOpenFileEditor(selectedWorkspace, relativePath)
                      }
                      onCloseFilePreview={handleCloseFilePreview}
                    />
                  </Pressable>
                </Pressable>
              ) : null}
              {view === "fileEditor" && selectedWorkspace && fileEditorPath ? (
                <View style={styles.fullScreenPage}>
                  <FileEditorScreen
                    workspace={selectedWorkspace}
                    relativePath={fileEditorPath}
                    file={editorFile}
                    loading={editorLoading}
                    saving={editorSaving}
                    writeResult={lastFileWriteResult}
                    onBack={handleCloseFileEditor}
                    onContentChange={handleEditorContentChange}
                    onReload={handleReloadEditorFile}
                    onSave={handleSaveEditorFile}
                  />
                </View>
              ) : null}
            </>
          ) : null}
        </View>
        {!appLockScreen && showPrimaryTabs ? (
          <PrimaryTabBar activeView={view} onChange={setView} />
        ) : null}
        <Modal
          animationType="fade"
          transparent
          visible={Boolean(pendingEncryptedPairingLink)}
          onRequestClose={handleEncryptedPairingCancel}
        >
          <View style={styles.encryptedPairingBackdrop}>
            <View style={styles.encryptedPairingDialog}>
              <Text style={styles.encryptedPairingTitle}>
                {t("pairing.encrypted.title")}
              </Text>
              <Text style={styles.encryptedPairingText}>
                {t("pairing.encrypted.description")}
              </Text>
              <TextInput
                autoFocus
                keyboardType="number-pad"
                maxLength={4}
                placeholder={t("pairing.encrypted.placeholder")}
                placeholderTextColor="#64727c"
                secureTextEntry
                style={styles.encryptedPairingInput}
                value={encryptedPairingPassword}
                onChangeText={(value) => {
                  setEncryptedPairingPassword(
                    value.replace(/\D/g, "").slice(0, 4),
                  );
                  setEncryptedPairingError(undefined);
                }}
                onSubmitEditing={() => {
                  void handleEncryptedPairingSubmit();
                }}
              />
              {encryptedPairingError ? (
                <Text style={styles.encryptedPairingError}>
                  {encryptedPairingError}
                </Text>
              ) : null}
              <View style={styles.encryptedPairingActions}>
                <Button
                  style={styles.encryptedPairingAction}
                  variant="ghost"
                  onPress={handleEncryptedPairingCancel}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  disabled={encryptedPairingPassword.length !== 4}
                  style={styles.encryptedPairingAction}
                  tone="primary"
                  variant="solid"
                  onPress={() => {
                    void handleEncryptedPairingSubmit();
                  }}
                >
                  {t("pairing.encrypted.import")}
                </Button>
              </View>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#101417",
  },
  content: {
    flex: 1,
  },
  fullScreenPage: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#101417",
  },
  presentedBackdrop: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0, 0, 0, 0.34)",
  },
  presentedPage: {
    flex: 1,
    marginTop: 18,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    overflow: "hidden",
    backgroundColor: "#101417",
  },
  encryptedPairingBackdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    backgroundColor: "rgba(0, 0, 0, 0.52)",
  },
  encryptedPairingDialog: {
    width: "100%",
    maxWidth: 420,
    gap: 14,
    borderRadius: 22,
    borderColor: "#263037",
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
    backgroundColor: "#11181d",
  },
  encryptedPairingTitle: {
    color: "#f5f7f8",
    fontSize: 20,
    fontWeight: "800",
  },
  encryptedPairingText: {
    color: "#94a3ad",
    fontSize: 14,
    lineHeight: 20,
  },
  encryptedPairingInput: {
    borderRadius: 14,
    borderColor: "#263037",
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: "#f5f7f8",
    fontSize: 20,
    fontWeight: "800",
    letterSpacing: 8,
    textAlign: "center",
    backgroundColor: "#0d1317",
  },
  encryptedPairingError: {
    color: "#ff8b8b",
    fontSize: 13,
    fontWeight: "700",
  },
  encryptedPairingActions: {
    flexDirection: "row",
    gap: 10,
  },
  encryptedPairingAction: {
    flex: 1,
  },
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
  header: {
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 10,
    alignItems: "center",
    borderBottomColor: "#263037",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    color: "#f5f7f8",
    fontSize: 20,
    fontWeight: "700",
  },
  subtitle: {
    color: "#94a3ad",
    fontSize: 12,
    marginTop: 3,
    textAlign: "center",
  },
  tabBar: {
    flexDirection: "row",
    borderTopColor: "#263037",
    borderTopWidth: StyleSheet.hairlineWidth,
    backgroundColor: "#11181d",
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 10,
  },
  tabButton: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    minHeight: 46,
    borderRadius: 12,
  },
  tabButtonActive: {
    backgroundColor: "rgba(48, 196, 141, 0.12)",
  },
  tabButtonPressed: {
    opacity: 0.85,
  },
  tabLabel: {
    color: "#94a3ad",
    fontSize: 11,
    fontWeight: "800",
  },
  tabLabelActive: {
    color: "#30c48d",
  },
});

const PRIMARY_TABS: ReadonlyArray<{
  icon: IconName;
  value: PrimaryTabView;
}> = [
  { icon: "device", value: "devices" },
  { icon: "settings", value: "settings" },
];

function PrimaryTabBar({
  activeView,
  onChange,
}: {
  activeView: PrimaryTabView;
  onChange(view: PrimaryTabView): void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <View style={styles.tabBar} accessibilityRole="tablist">
      {PRIMARY_TABS.map((tab) => {
        const selected = tab.value === activeView;
        const tintColor = selected ? "#30c48d" : "#94a3ad";
        const label = t(`app.tabs.${tab.value}`);
        return (
          <Pressable
            key={tab.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={label}
            style={({ pressed }) => [
              styles.tabButton,
              selected && styles.tabButtonActive,
              pressed && styles.tabButtonPressed,
            ]}
            onPress={() => onChange(tab.value)}
          >
            <Icon name={tab.icon} color={tintColor} size={20} />
            <Text style={[styles.tabLabel, selected && styles.tabLabelActive]}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function toGitDiffCacheKey(
  relativePath: string | undefined,
  scope: GitDiffScope,
): string {
  return `${scope}:${relativePath ?? ""}`;
}

function parseGitDiffCacheKey(
  key: string | undefined,
): { relativePath?: string; scope: GitDiffScope } | undefined {
  if (!key) {
    return undefined;
  }
  const separatorIndex = key.indexOf(":");
  if (separatorIndex < 0) {
    return undefined;
  }
  const scope = key.slice(0, separatorIndex) as GitDiffScope;
  if (scope !== "all" && scope !== "staged" && scope !== "unstaged") {
    return undefined;
  }
  const relativePath = key.slice(separatorIndex + 1);
  return { scope, relativePath: relativePath || undefined };
}

function toWorkspaceFileKey(workspacePath: string, relativePath: string): string {
  return `${workspacePath}:${relativePath}`;
}

function getSessionFilesWorkspace(
  session: CodexSession,
  workspaces: readonly WorkspaceDefinition[],
): WorkspaceDefinition {
  if (session.workspace_path) {
    const exact = workspaces.find(
      (workspace) => workspace.path === session.workspace_path,
    );
    if (exact) {
      return exact;
    }
  }

  const matched = workspaces
    .filter((workspace) => isPathInside(session.cwd, workspace.path))
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (matched) {
    return matched;
  }

  const path = session.workspace_path || session.cwd;
  return {
    name: session.workspace_name ?? basename(path),
    path,
    isGitRepository: Boolean(session.git_repository),
    status: "available",
    source: "session",
  };
}

function isPathInside(path: string, parent: string): boolean {
  const normalizedPath = path.replace(/\/+$/g, "");
  const normalizedParent = parent.replace(/\/+$/g, "");
  return (
    normalizedPath === normalizedParent ||
    normalizedPath.startsWith(`${normalizedParent}/`)
  );
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}
