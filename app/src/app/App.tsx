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
  Dimensions,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import type {
  AgentProviderDefinition,
  AuthFailedPayload,
  CodexSession,
  FilesListPayload,
  FilesReadPayload,
  GitDiffPayload,
  GitStatusPayload,
  MessageEnvelope,
  RuntimeKind,
  SessionListPayload,
  SessionTransport,
  TerminalErrorPayload,
  TerminalFramePayload,
  TerminalInputPayload,
  TerminalResizePayload,
  TerminalSnapshotPayload,
  TransportPath,
  TransportPreference,
  TunnelUpgradeAnswerPayload,
  TunnelUpgradeCandidatePayload,
  TunnelUpgradeCommittedPayload,
  TunnelUpgradeDowngradePayload,
  TunnelUpgradeOfferPayload,
  TunnelUpgradeProposePayload,
  WorkspaceDefinition,
  WorkspaceFileEntry,
  WorkspaceGitStatus,
  WorkspaceListPayload,
} from "../../../packages/protocol-ts/src/index.ts";
import {
  DEFAULT_AGENT_PROVIDER_DEFINITIONS,
  createMessage,
  isTransportPreference,
} from "../../../packages/protocol-ts/src/index.ts";
import type { RelayCloseEvent } from "../../../packages/relay-client/src/index.ts";
import { appConfig } from "./appConfig";
import { PairingScreen } from "../screens/pairing/PairingScreen";
import { DeviceListScreen } from "../screens/devices/DeviceListScreen";
import { ConnectionPreferenceScreen } from "../screens/settings/ConnectionPreferenceScreen";
import { SettingsScreen } from "../screens/settings/SettingsScreen";
import { SessionListScreen } from "../screens/sessions/SessionListScreen";
import { TerminalScreen } from "../screens/terminal/TerminalScreen";
import type { PairingConfig } from "../features/auth/types";
import { parsePairingConfig } from "../features/auth/pairingConfig";
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
} from "../features/workspaces/workspaceMessages";
import {
  computeInitialTerminalSize,
  getDefaultTerminalTextSize,
  isTerminalTextSize,
  type TerminalTextSize,
} from "../features/terminal/terminalLayout";
import { MobileRelaySession } from "../lib/relay-client/mobileRelaySession";
import { MobileRelayPath, MobileSessionTransport } from "../lib/transport";
import { UpgradeCoordinator } from "../lib/transport/upgradeCoordinator";
import { createMobileWebRtcPeerAdapter } from "../lib/transport/webRtcPeerAdapter";
import {
  addAppUrlListener,
  getInitialAppUrl,
} from "../platform/linking/appLinking";
import {
  clearPairing,
  loadPairings,
  savePairings,
} from "../platform/secure-storage/securePairingStore";
import { ConfirmProvider, useConfirm } from "../ui/confirm/ConfirmProvider";
import { Icon, type IconName } from "../ui/icons";

type AppView =
  | "pairing"
  | "devices"
  | "settings"
  | "connectionPreference"
  | "sessions"
  | "terminal";
type PrimaryTabView = "devices" | "settings";
type ConnectionStatus =
  | "idle"
  | "connecting"
  | "authenticating"
  | "authenticated"
  | "failed";

type AppSessionTransport = Omit<SessionTransport, "close"> & {
  connect(): Promise<void>;
  onClose(handler: (event: RelayCloseEvent) => void): () => void;
  close(reason?: string): void;
  getCurrentPath(): TransportPath;
  onPathChange(handler: (path: TransportPath) => void): () => void;
  /**
   * 阶段 5：暴露给业务层用于在 AppState 变化、网络变化时主动触发降级，
   * 以及处理来自 Relay 的 tunnel.upgrade.* 控制消息。
   */
  forceDowngrade(reason: string): void;
  /**
   * Direct only（底层 prefer_p2p）模式下，Relay 主动下发 strict_unavailable 时由 wiring 层调用，
   * 直接让 transport 进入 forceClose 并通知 onForceClose handler。
   */
  forceClose(reason: string): void;
  handleUpgradeMessage(message: MessageEnvelope): void;
  /**
   * Direct only（底层 prefer_p2p）模式下，AppState 进/出后台时调用：暂停时不会触发协商失败，
   * 仅暂停 ping/buffered 采样并把 currentPath 标记回 relay 入口（业务消息
   * 仍受 strict 准入门保护，不会真的发到 relay）。
   */
  pauseForBackground(): void;
  resumeForForeground(): void;
  /**
   * 是否运行在 Direct only 模式（由 transportPreference === "prefer_p2p" 推导）。
   */
  isStrictP2p(): boolean;
};

const EMPTY_TERMINAL_FRAME = "Waiting for the Mac Agent terminal snapshot...";

/**
 * AsyncStorage 中保存的用户传输偏好键；缺省时回退到 appConfig.transportPreference。
 * 取值范围由 packages/protocol-ts isTransportPreference 守卫校验。
 */
const TRANSPORT_PREFERENCE_STORAGE_KEY = "omniwork.transportPreference";
const TERMINAL_TEXT_SIZE_STORAGE_KEY = "omniwork.terminal.textSize";

export default function App(): JSX.Element {
  return (
    <ConfirmProvider>
      <AppContent />
    </ConfirmProvider>
  );
}

function AppContent(): JSX.Element {
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
  >([...DEFAULT_AGENT_PROVIDER_DEFINITIONS]);
  const [workspaces, setWorkspaces] = useState<WorkspaceDefinition[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] =
    useState<WorkspaceDefinition | null>(null);
  const [fileEntries, setFileEntries] = useState<WorkspaceFileEntry[]>([]);
  const [fileRelativePath, setFileRelativePath] = useState("");
  const [selectedFile, setSelectedFile] = useState<FilesReadPayload>();
  const [gitStatus, setGitStatus] = useState<WorkspaceGitStatus>();
  const [gitDiff, setGitDiff] = useState<GitDiffPayload>();
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
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
  const [terminalTextSize, setTerminalTextSizeState] =
    useState<TerminalTextSize>(() =>
      getDefaultTerminalTextSize(Dimensions.get("window")),
    );
  const relayRef = useRef<AppSessionTransport | null>(null);
  const pendingCreateRef = useRef(false);
  const pendingAutoOpenSessionsRef = useRef(false);
  const pairingsRef = useRef<PairingConfig[]>([]);
  const selectedSessionRef = useRef<CodexSession | null>(null);
  const terminalTextSizeLoadedRef = useRef(false);
  // 标记当前失败状态是否已经在交互流程中提示过用户，避免重复弹出
  // "Connection lost" 对话框（例如重试再次失败时立刻又弹一次）。
  const failureDialogActiveRef = useRef(false);
  const confirm = useConfirm();

  const canUseWorkspace = pairings.length > 0;
  const showPrimaryTabs = canUseWorkspace && isPrimaryTabView(view);
  const title = useMemo(() => {
    if (view === "pairing") return editingPairing ? "Edit Device" : "Pair Mac";
    if (view === "terminal") return selectedSession?.title ?? "Terminal";
    if (view === "sessions") return "Workspaces";
    if (view === "connectionPreference") return "Connection Mode";
    if (view === "settings") return "Settings";
    return "Devices";
  }, [editingPairing, selectedSession?.title, view]);

  const selectedFrame = selectedSession
    ? (terminalFrames[selectedSession.session_id] ?? EMPTY_TERMINAL_FRAME)
    : EMPTY_TERMINAL_FRAME;
  const showHeader = view === "pairing";

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

  useEffect(() => {
    pairingsRef.current = pairings;
  }, [pairings]);

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

  const handleChangeTerminalTextSize = useCallback(
    (next: TerminalTextSize) => {
      setTerminalTextSizeState(next);
      if (!terminalTextSizeLoadedRef.current) {
        return;
      }

      AsyncStorage.setItem(TERMINAL_TEXT_SIZE_STORAGE_KEY, next).catch(() => {
        // 字号偏好持久化失败不影响终端使用。
      });
    },
    [],
  );

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
      relay.close();
      if (relayRef.current === relay) {
        relayRef.current = null;
      }
    };
  }, [pairing, transportPreference]);

  // 阶段 5：进入后台时主动降级到 relay path（PeerConnection 在后台会被系统挂起），
  // 回到前台后由下次 propose 周期重新尝试 upgrade。NetInfo 网络变化暂未接入，
  // TODO(阶段 5)：订阅 NetInfo，发生网络切换时同样调用 forceDowngrade 并清理 backoff。
  // 严格 P2P 模式下不能 forceDowngrade（那等价于把业务消息切回 Relay），改为
  // pauseForBackground/resumeForForeground：暂停 ping/buffered 采样并暂停业务消息，
  // 前台恢复后等下次 propose 重新建链。
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      const relay = relayRef.current;
      if (!relay) {
        return;
      }
      if (relay.isStrictP2p()) {
        if (next === "active") {
          relay.resumeForForeground();
        } else {
          relay.pauseForBackground();
        }
        return;
      }
      if (next !== "active") {
        relay.forceDowngrade("app_background");
      }
    });
    return () => subscription.remove();
  }, []);

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
      (view !== "sessions" && view !== "terminal") ||
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
    const confirmed = await confirm({
      title: "Delete device",
      message: `Delete ${targetPairing.deviceId} from linked devices?`,
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
    setAgentProviders([...DEFAULT_AGENT_PROVIDER_DEFINITIONS]);
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
    setAgentProviders([...DEFAULT_AGENT_PROVIDER_DEFINITIONS]);
    setWorkspaces([]);
    setSelectedSession(null);
    setSelectedWorkspace(null);
    setTerminalFrames({});
    setClosingSessionIds([]);
    setKillingSessionIds([]);

    const errorText = `Authentication failed for "${targetPairing.deviceId}": ${reason}. Edit the device to enter a new key, or delete it.`;
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
      setAgentProviders([...DEFAULT_AGENT_PROVIDER_DEFINITIONS]);
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

  function handleOpenWorkspaceFiles(workspace: WorkspaceDefinition): void {
    if (!pairing || connectionStatus !== "authenticated") {
      return;
    }
    setSelectedWorkspace(workspace);
    setFileRelativePath("");
    setSelectedFile(undefined);
    setFileEntries([]);
    setWorkspaceLoading(true);
    sendToRelay(
      listFilesRequest(pairing.deviceId, {
        workspacePath: workspace.path,
        relativePath: "",
      }),
    );
  }

  function handleOpenWorkspaceGit(workspace: WorkspaceDefinition): void {
    if (
      !pairing ||
      connectionStatus !== "authenticated" ||
      !workspace.isGitRepository
    ) {
      return;
    }
    setSelectedWorkspace(workspace);
    setGitStatus(undefined);
    setGitDiff(undefined);
    setWorkspaceLoading(true);
    sendToRelay(
      gitStatusRequest(pairing.deviceId, { workspacePath: workspace.path }),
    );
  }

  function handleOpenDirectory(relativePath: string): void {
    if (
      !pairing ||
      !selectedWorkspace ||
      connectionStatus !== "authenticated"
    ) {
      return;
    }
    setFileRelativePath(relativePath);
    setSelectedFile(undefined);
    setWorkspaceLoading(true);
    sendToRelay(
      listFilesRequest(pairing.deviceId, {
        workspacePath: selectedWorkspace.path,
        relativePath,
      }),
    );
  }

  function handleReadFile(relativePath: string): void {
    if (
      !pairing ||
      !selectedWorkspace ||
      connectionStatus !== "authenticated"
    ) {
      return;
    }
    setWorkspaceLoading(true);
    sendToRelay(
      readFileRequest(pairing.deviceId, {
        workspacePath: selectedWorkspace.path,
        relativePath,
      }),
    );
  }

  function handleOpenGitDiff(relativePath?: string): void {
    if (
      !pairing ||
      !selectedWorkspace ||
      connectionStatus !== "authenticated"
    ) {
      return;
    }
    setWorkspaceLoading(true);
    sendToRelay(
      gitDiffRequest(pairing.deviceId, {
        workspacePath: selectedWorkspace.path,
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
        setConnectionStatus("authenticated");
        setConnectionMessage("Connected to Mac Agent.");
        failureDialogActiveRef.current = false;
        relay.send(listSessionsRequest(activePairing.deviceId));
        relay.send(listWorkspacesRequest(activePairing.deviceId));
        if (pendingAutoOpenSessionsRef.current) {
          pendingAutoOpenSessionsRef.current = false;
          setView("sessions");
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
            : [...DEFAULT_AGENT_PROVIDER_DEFINITIONS],
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
        setFileRelativePath(payload.relativePath);
        setFileEntries(payload.entries);
        setWorkspaceLoading(false);
        break;
      }
      case "files.read": {
        setSelectedFile(message.payload as FilesReadPayload);
        setWorkspaceLoading(false);
        break;
      }
      case "git.status": {
        const payload = message.payload as GitStatusPayload;
        setGitStatus(payload.status);
        setWorkspaceLoading(false);
        break;
      }
      case "git.diff": {
        setGitDiff(message.payload as GitDiffPayload);
        setWorkspaceLoading(false);
        break;
      }
      case "terminal.snapshot": {
        const payload = message.payload as TerminalSnapshotPayload;
        if (message.session_id) {
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
          setTerminalFrames((current) => ({
            ...current,
            [message.session_id as string]: payload.data,
          }));
        }
        break;
      }
      case "terminal.error": {
        const payload = message.payload as TerminalErrorPayload;
        setCreatingSession(false);
        pendingCreateRef.current = false;
        setWorkspaceLoading(false);
        const detail = payload.message || "Terminal error from Mac Agent.";
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
            ? "Failed to create session"
            : payload.code === "TMUX_TARGET_MISSING"
              ? "Session no longer available"
              : "Mac Agent error";
        confirm({
          title,
          message: detail,
          confirmText: "OK",
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
                {getHeaderSubtitle(view, pairings.length, pairing)}
              </Text>
            ) : null}
          </View>
        ) : null}

        <View style={styles.content}>
          {view === "pairing" ? (
            <PairingScreen
              errorMessage={pairingError}
              initialPairing={editingPairing}
              submitLabel={editingPairing ? "Save Device" : "Pair Mac"}
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
              onChangeTerminalTextSize={handleChangeTerminalTextSize}
              onOpenConnectionPreference={() => setView("connectionPreference")}
            />
          ) : view === "connectionPreference" ? (
            <ConnectionPreferenceScreen
              transportPreference={transportPreference}
              onChangeTransportPreference={handleChangeTransportPreference}
              onBack={() => setView("settings")}
            />
          ) : view === "sessions" ? (
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
              selectedFile={selectedFile}
              gitStatus={gitStatus}
              gitDiff={gitDiff}
              workspaceLoading={workspaceLoading}
              onBack={() => setView("devices")}
              onRefreshSessions={handleRefreshSessions}
              onCreateSession={handleCreateSession}
              onOpenWorkspaceFiles={handleOpenWorkspaceFiles}
              onOpenWorkspaceGit={handleOpenWorkspaceGit}
              onOpenDirectory={handleOpenDirectory}
              onReadFile={handleReadFile}
              onOpenGitDiff={handleOpenGitDiff}
              onOpenSession={handleOpenSession}
              onCloseSession={handleCloseSession}
              onRenameSession={handleRenameSession}
              onKillTmuxSession={handleKillTmuxSession}
            />
          ) : selectedSession ? (
            <TerminalScreen
              session={selectedSession}
              frame={selectedFrame}
              connectionStatus={connectionStatus}
              statusLabel={connectionMessage}
              readOnlyReason={
                selectedSessionCapabilities?.canInput
                  ? undefined
                  : (selectedSessionCapabilities?.unavailableReason ??
                    "This session is not interactive right now.")
              }
              canInput={Boolean(selectedSessionCapabilities?.canInput)}
              canResize={Boolean(selectedSessionCapabilities?.canResize)}
              textSize={terminalTextSize}
              onBack={() => setView("sessions")}
              onChangeTextSize={handleChangeTerminalTextSize}
              onRefreshSessions={handleRefreshSessions}
              onInput={handleTerminalInput}
              onResize={handleTerminalResize}
            />
          ) : null}
        </View>
        {showPrimaryTabs ? (
          <PrimaryTabBar activeView={view} onChange={setView} />
        ) : null}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function createAppSessionTransport(
  pairing: PairingConfig,
  transportPreference: TransportPreference,
  options: { onForceClose?: (reason: string) => void } = {},
): AppSessionTransport {
  const session = new MobileRelaySession(pairing, { transportPreference });
  const relayPath = new MobileRelayPath(session);
  const strictP2p = transportPreference === "prefer_p2p";
  const onForceClose = options.onForceClose;
  const transport = new MobileSessionTransport(relayPath, {
    strictP2p,
    onForceClose,
  });
  const logTransport =
    typeof process !== "undefined" &&
    process.env?.OMNIWORK_LOG_TRANSPORT === "1";

  // App 端固定为 offerer。
  const coordinator = new UpgradeCoordinator({
    role: "offerer",
    deviceId: pairing.deviceId,
    // 防御性兜底：即便 Relay 端 respectClientPreference 被运维关闭，
    // 用户选择 relay_only 时 App 仍拒绝创建 PeerConnection，触发 coordinator
    // 的 peer_unavailable 失败计数让链路稳定回退到 relay。
    // 严格 P2P 模式下若 react-native-webrtc / wrtc 不可用同样返回 null，
    // coordinator 会调用 onForceClose("peer_unavailable") 关闭 session。
    peerFactory: (opts) => {
      if (transportPreference === "relay_only") {
        console.info("[omniwork-app] upgrade refused by transport_preference", {
          preference: transportPreference,
        });
        return null;
      }
      return createMobileWebRtcPeerAdapter({
        iceServers: opts.iceServers,
        role: opts.role,
      });
    },
    sendControl: (envelope) => session.send(envelope),
    onSwitchPath: (path) => {
      if (path === "p2p") {
        const peer = coordinator.getPeer();
        const upgradeId = coordinator.getUpgradeId();
        if (peer) {
          transport.attachP2pPeer(peer, {
            upgradeId: upgradeId ?? undefined,
            onDowngrade: (reason) => coordinator.downgrade(reason),
          });
        }
      }
      void transport.switchPath(path);
    },
    onForceClose: (reason) => {
      // 协商期失败 → 让 transport 通过 forceCloseHandler 通知上层
      transport.forceClose(reason);
    },
  });

  transport.onEvent((event) => {
    switch (event.type) {
      case "path_change":
        console.info("[omniwork-app] transport path changed", {
          from: event.from,
          to: event.to,
        });
        break;
      case "ping_timeout":
        console.warn("[omniwork-app] transport ping timeout", {
          seq: event.seq,
          count: event.count,
        });
        break;
      case "pong_received":
        if (logTransport) {
          console.info("[omniwork-app] transport pong received", {
            seq: event.seq,
            rtt_ms: event.rtt_ms,
          });
        }
        break;
      case "downgrade":
        console.warn("[omniwork-app] transport downgrade", {
          reason: event.reason,
        });
        break;
      case "force_close":
        console.warn("[omniwork-app] strict_p2p force_close", {
          reason: event.reason,
        });
        break;
      case "strict_send_blocked":
        console.warn("[omniwork-app] strict_p2p send blocked", {
          envelope_type: event.envelope_type,
        });
        break;
      case "background_pause":
        console.info("[omniwork-app] strict_p2p background pause");
        break;
      case "background_resume":
        console.info("[omniwork-app] strict_p2p background resume");
        break;
    }
  });

  coordinator.onEvent((event) => {
    switch (event.type) {
      case "propose":
        console.info("[omniwork-app] upgrade propose", {
          upgrade_id: event.upgrade_id,
          role: event.role,
        });
        break;
      case "upgrade_success":
        console.info("[omniwork-app] upgrade success", {
          upgrade_id: event.upgrade_id,
        });
        break;
      case "upgrade_failed":
        console.warn("[omniwork-app] upgrade failed", {
          upgrade_id: event.upgrade_id,
          reason: event.reason,
        });
        break;
    }
  });

  return {
    connect: () => session.connect(),
    onMessage: (handler) => transport.onMessage(handler),
    onClose: (handler) => relayPath.onClose(handler),
    send: (message) => transport.send(message),
    close: () => {
      // 切偏好/退出时若 currentPath==='p2p'，先让 coordinator 发出
      // tunnel.upgrade.downgrade(reason="client_closing")，让 agent 端
      // 立即 cleanup PeerConnection，避免之后 agent 仅靠 pong_timeout
      // (~5s) 才被动感知，期间 strict 端会出现 strict_p2p_disconnect 噪音、
      // auto 端业务消息（如新链路鉴权）也得不到清场。
      if (transport.getCurrentPath() === "p2p") {
        coordinator.downgrade("client_closing");
      }
      transport.close("client closing");
      session.close();
    },
    getCurrentPath: () => transport.getCurrentPath(),
    onPathChange: (handler) => transport.onPathChange(handler),
    forceDowngrade: (reason) => {
      transport.forceDowngrade(reason);
      coordinator.downgrade(reason);
    },
    forceClose: (reason) => transport.forceClose(reason),
    handleUpgradeMessage: (message) => {
      switch (message.type) {
        case "tunnel.upgrade.propose":
          void coordinator.propose(
            (message as MessageEnvelope<TunnelUpgradeProposePayload>).payload,
          );
          break;
        case "tunnel.upgrade.offer":
          void coordinator.handleOffer(
            (message as MessageEnvelope<TunnelUpgradeOfferPayload>).payload,
          );
          break;
        case "tunnel.upgrade.answer":
          void coordinator.handleAnswer(
            (message as MessageEnvelope<TunnelUpgradeAnswerPayload>).payload,
          );
          break;
        case "tunnel.upgrade.candidate":
          void coordinator.handleCandidate(
            (message as MessageEnvelope<TunnelUpgradeCandidatePayload>).payload,
          );
          break;
        case "tunnel.upgrade.committed":
          coordinator.handleCommitted(
            (message as MessageEnvelope<TunnelUpgradeCommittedPayload>).payload,
          );
          break;
        case "tunnel.upgrade.downgrade": {
          const reason = (
            message as MessageEnvelope<TunnelUpgradeDowngradePayload>
          ).payload.reason;
          // strict 偏好下，Relay 端 enabled/blocklist/backoff 守门会主动
          // 下发 reason="strict_unavailable:*" —— 此时 coordinator 还在
          // idle，downgrade() 直接 return 不会触发 forceClose；这里兜底
          // 让 strict transport 立即关闭 session 让 UI 透出原因。
          if (
            reason.startsWith("strict_unavailable") &&
            transport.isStrictP2p()
          ) {
            transport.forceClose(reason);
            break;
          }
          coordinator.downgrade(reason);
          break;
        }
        default:
          break;
      }
    },
    pauseForBackground: () => transport.pauseForBackground(),
    resumeForForeground: () => transport.resumeForForeground(),
    isStrictP2p: () => transport.isStrictP2p(),
  };
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#101417",
  },
  content: {
    flex: 1,
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
  label: string;
  value: PrimaryTabView;
}> = [
  { icon: "device", label: "Devices", value: "devices" },
  { icon: "settings", label: "Settings", value: "settings" },
];

function PrimaryTabBar({
  activeView,
  onChange,
}: {
  activeView: PrimaryTabView;
  onChange(view: PrimaryTabView): void;
}): JSX.Element {
  return (
    <View style={styles.tabBar} accessibilityRole="tablist">
      {PRIMARY_TABS.map((tab) => {
        const selected = tab.value === activeView;
        const tintColor = selected ? "#30c48d" : "#94a3ad";
        return (
          <Pressable
            key={tab.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={tab.label}
            style={({ pressed }) => [
              styles.tabButton,
              selected && styles.tabButtonActive,
              pressed && styles.tabButtonPressed,
            ]}
            onPress={() => onChange(tab.value)}
          >
            <Icon name={tab.icon} color={tintColor} size={20} />
            <Text style={[styles.tabLabel, selected && styles.tabLabelActive]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function upsertSession(
  sessions: CodexSession[],
  nextSession: CodexSession,
): CodexSession[] {
  const index = sessions.findIndex(
    (session) => session.session_id === nextSession.session_id,
  );
  if (index < 0) {
    return [nextSession, ...sessions];
  }

  const nextSessions = [...sessions];
  nextSessions[index] = nextSession;
  return nextSessions;
}

function upsertPairing(
  pairings: PairingConfig[],
  nextPairing: PairingConfig,
): PairingConfig[] {
  const index = pairings.findIndex((pairing) =>
    isSamePairing(pairing, nextPairing),
  );
  if (index < 0) {
    return [...pairings, nextPairing];
  }

  const nextPairings = [...pairings];
  nextPairings[index] = nextPairing;
  return nextPairings;
}

function isSamePairing(left: PairingConfig, right: PairingConfig): boolean {
  return left.relayUrl === right.relayUrl && left.deviceId === right.deviceId;
}

function getHeaderSubtitle(
  view: AppView,
  deviceCount: number,
  activePairing: PairingConfig | null,
): string {
  if (view === "devices") {
    return `${deviceCount} linked ${deviceCount === 1 ? "device" : "devices"}`;
  }
  if (view === "settings") {
    return "Global preferences";
  }
  if (view === "connectionPreference") {
    return "Connection settings";
  }

  return activePairing?.deviceId ?? "";
}

function isPrimaryTabView(view: AppView): view is PrimaryTabView {
  return view === "devices" || view === "settings";
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

function isTransitionalSessionStatus(status: CodexSession["status"]): boolean {
  return status === "created" || status === "starting";
}

function formatRelayCloseMessage(event: {
  code?: number;
  reason?: string;
}): string {
  const reason = event.reason ? `: ${event.reason}` : "";
  return `Connection closed${event.code ? ` (${event.code})` : ""}${reason}`;
}

/**
 * 把 transport.forceClose 透出来的 strict 失败 reason 翻译成面向用户的 UI 文案。
 * - 协商期失败（peer_unavailable / create_offer_failed / handle_offer_failed /
 *   handle_answer_failed / timeout）：常见于双端 ICE/SDP 错配，提示用户重连或换偏好；
 * - 运行期降级（pong_timeout / ice_failed / ice_disconnected / buffered_overflow /
 *   peer_closed / peer_missing）：通常是网络抖动，提示用户重连；
 * - relay 主动 strict_unavailable:*：来自 P1-1E/1F 守门，附带 cause 供排查。
 *
 * 未识别的 reason 走兜底文案 + 原始 token，便于线上抓 bug。
 */
function formatStrictForceCloseMessage(reason: string): string {
  if (reason.startsWith("strict_unavailable:")) {
    const cause = reason.slice("strict_unavailable:".length);
    if (cause === "relay_disabled") {
      return "Direct only is unavailable on this Relay. Switch Connection mode or contact the operator.";
    }
    if (cause === "blocklisted") {
      return "Direct only is unavailable: this device is blocked by the Relay.";
    }
    if (cause === "backoff_active") {
      return "Direct only is cooling down after recent failures. Retry in a few minutes or switch Connection mode.";
    }
    return `Direct only unavailable (${cause}). Switch Connection mode or reconnect.`;
  }
  switch (reason) {
    case "peer_unavailable":
      return "Direct connection unavailable. Check that the App and Mac Agent are reachable and try again.";
    case "create_offer_failed":
    case "handle_offer_failed":
    case "handle_answer_failed":
      return "Direct connection setup failed. Reconnect, and if the issue persists switch Connection mode.";
    case "timeout":
      return "Direct connection setup timed out. Check the network and retry.";
    case "pong_timeout":
      return "Direct connection lost (no heartbeat). Reconnect or switch Connection mode.";
    case "ice_failed":
    case "ice_disconnected":
      return "Direct connection lost. Reconnect or switch Connection mode.";
    case "buffered_overflow":
      return "Direct connection lost (send buffer overflow). Reconnect or switch Connection mode.";
    case "peer_closed":
    case "peer_missing":
      return "Direct connection closed unexpectedly. Reconnect or switch Connection mode.";
    default:
      return `Direct connection unavailable: ${reason}. Switch Connection mode or reconnect.`;
  }
}
