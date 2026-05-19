import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import { Alert, StatusBar, StyleSheet, Text, View } from "react-native";
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
  TerminalErrorPayload,
  TerminalFramePayload,
  TerminalInputPayload,
  TerminalResizePayload,
  TerminalSnapshotPayload,
  WorkspaceDefinition,
  WorkspaceFileEntry,
  WorkspaceGitStatus,
  WorkspaceListPayload,
} from "../../../packages/protocol-ts/src/index.ts";
import {
  DEFAULT_AGENT_PROVIDER_DEFINITIONS,
  createMessage,
  parsePairingLink,
} from "../../../packages/protocol-ts/src/index.ts";
import type { RelayCloseEvent } from "../../../packages/relay-client/src/index.ts";
import { PairingScreen } from "../screens/pairing/PairingScreen";
import { DeviceListScreen } from "../screens/devices/DeviceListScreen";
import { SessionListScreen } from "../screens/sessions/SessionListScreen";
import { TerminalScreen } from "../screens/terminal/TerminalScreen";
import type { PairingConfig } from "../features/auth/types";
import {
  closeSessionRequest,
  renameSessionRequest,
  recoverSessionRequest,
  restartSessionRequest,
  retrySessionRequest,
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
import { computeInitialTerminalSize } from "../features/terminal/terminalLayout";
import { MobileRelaySession } from "../lib/relay-client/mobileRelaySession";
import { AppWebRtcTunnelSession } from "../lib/tunnel-client/appWebRtcTunnelSession";
import { DEFAULT_PAIRING_TRANSPORT } from "../features/auth/types";
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

type AppView = "pairing" | "devices" | "sessions" | "terminal";
type ConnectionStatus =
  | "idle"
  | "connecting"
  | "authenticating"
  | "authenticated"
  | "failed";

interface AppSessionTransport {
  connect(): Promise<void>;
  onMessage(handler: (message: MessageEnvelope) => void): () => void;
  onClose(handler: (event: RelayCloseEvent) => void): () => void;
  send(message: MessageEnvelope): void;
  close(): void;
}

const EMPTY_TERMINAL_FRAME = "Waiting for the Mac Agent terminal snapshot...";
const TERMINAL_IDLE_SNAPSHOT_INTERVAL_MS = 3000;
const TERMINAL_INPUT_SNAPSHOT_DELAYS_MS = [120, 350, 800, 1600] as const;

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
  const [connectionMessage, setConnectionMessage] = useState(
    "Enter the Mac Agent key to pair.",
  );
  const [pairingError, setPairingError] = useState<string | undefined>();
  const [creatingSession, setCreatingSession] = useState(false);
  const [closingSessionIds, setClosingSessionIds] = useState<string[]>([]);
  const [killingSessionIds, setKillingSessionIds] = useState<string[]>([]);
  const relayRef = useRef<AppSessionTransport | null>(null);
  const pendingCreateRef = useRef(false);
  const pendingAutoOpenSessionsRef = useRef(false);
  const pairingsRef = useRef<PairingConfig[]>([]);
  const selectedSessionRef = useRef<CodexSession | null>(null);
  const confirm = useConfirm();

  const canUseWorkspace = pairings.length > 0;
  const title = useMemo(() => {
    if (view === "pairing") return editingPairing ? "Edit Device" : "Pair Mac";
    if (view === "terminal") return selectedSession?.title ?? "Terminal";
    if (view === "sessions") return "Workspaces";
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

  useEffect(() => {
    if (!pairing) {
      relayRef.current?.close();
      relayRef.current = null;
      setConnectionStatus("idle");
      setConnectionMessage("Enter the Mac Agent key to pair.");
      return undefined;
    }

    let closed = false;
    const relay = createAppSessionTransport(pairing);
    relayRef.current = relay;
    setConnectionStatus("connecting");
    setConnectionMessage(
      pairing.transport === "webrtc"
        ? "Connecting with WebRTC P2P tunnel..."
        : "Connecting to Relay...",
    );

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
            `Relay connection failed: ${formatErrorMessage(error)}`,
          );
        }
      });

    return () => {
      closed = true;
      unsubscribe();
      unsubscribeClose();
      relay.close();
      if (relayRef.current === relay) {
        relayRef.current = null;
      }
    };
  }, [pairing]);

  useEffect(() => {
    if (
      connectionStatus !== "authenticated" ||
      view !== "terminal" ||
      !pairing ||
      !selectedSession
    ) {
      return undefined;
    }

    requestTerminalSnapshot(pairing.deviceId, selectedSession.session_id);
    const timer = setInterval(() => {
      requestTerminalSnapshot(pairing.deviceId, selectedSession.session_id);
    }, TERMINAL_IDLE_SNAPSHOT_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [connectionStatus, pairing, selectedSession, view]);

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
    }
  }

  function handleRefreshSessions(): void {
    if (!pairing) {
      return;
    }
    if (connectionStatus !== "authenticated") {
      setPairing({ ...pairing });
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
        terminal_size: computeInitialTerminalSize(),
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
      session.status === "error" ||
      session.status === "exited" ||
      session.status === "archived";
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

  function handleRecoverSession(session: CodexSession): void {
    if (!pairing || connectionStatus !== "authenticated") {
      return;
    }

    const capabilities = getSessionCapabilities(session, {
      closing: closingSessionIds.includes(session.session_id),
      killing: killingSessionIds.includes(session.session_id),
    });
    if (!capabilities.canRecover) {
      setConnectionMessage(
        capabilities.unavailableReason ??
          "This session cannot be recovered right now.",
      );
      return;
    }

    setConnectionMessage(
      `${capabilities.recoveryActionLabel ?? "Recover"} requested for ${session.title}.`,
    );

    if (session.status === "exited") {
      sendToRelay(restartSessionRequest(pairing.deviceId, session.session_id));
      return;
    }
    if (session.status === "recovering") {
      sendToRelay(recoverSessionRequest(pairing.deviceId, session.session_id));
      return;
    }

    sendToRelay(retrySessionRequest(pairing.deviceId, session.session_id));
  }

  function handleOpenSession(session: CodexSession): void {
    const capabilities = getSessionCapabilities(session);
    if (!capabilities.canOpen) {
      setConnectionMessage(
        capabilities.unavailableReason ?? "This session is not ready to open.",
      );
      return;
    }

    setSelectedSession(session);
    setView("terminal");
    if (pairing && connectionStatus === "authenticated") {
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
    requestTerminalSnapshotsAfterInput(
      pairing.deviceId,
      selectedSession.session_id,
    );
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

  function requestTerminalSnapshotsAfterInput(
    deviceId: string,
    sessionId: string,
  ): void {
    for (const delayMs of TERMINAL_INPUT_SNAPSHOT_DELAYS_MS) {
      setTimeout(() => {
        requestTerminalSnapshot(deviceId, sessionId);
      }, delayMs);
    }
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
    switch (message.type) {
      case "auth.challenge":
        setConnectionStatus("authenticating");
        setConnectionMessage("Verifying temporary key...");
        break;
      case "auth.ok":
        setConnectionStatus("authenticated");
        setConnectionMessage("Connected to Mac Agent.");
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
        setPairingError(undefined);
        pendingAutoOpenSessionsRef.current = false;
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
        setConnectionMessage(
          payload.message || "Terminal error from Mac Agent.",
        );
        if (payload.code === "TMUX_TARGET_MISSING") {
          setSelectedSession(null);
          setView("sessions");
        }
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
            connectionMessage={connectionMessage}
            onAddDevice={handleAddDevice}
            onEditDevice={handleEditDevice}
            onDeleteDevice={handleDeleteDevice}
            onOpenDevice={handleOpenDevice}
            onRefreshSessions={handleRefreshSessions}
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
            onRecoverSession={handleRecoverSession}
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
            canKillTmux={Boolean(selectedSessionCapabilities?.canKill)}
            onBack={() => setView("sessions")}
            onKillTmux={() => handleKillTmuxSession(selectedSession)}
            onRefreshSessions={handleRefreshSessions}
            onInput={handleTerminalInput}
            onResize={handleTerminalResize}
          />
        ) : null}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function createAppSessionTransport(
  pairing: PairingConfig,
): AppSessionTransport {
  if (pairing.transport === "webrtc") {
    return new AppWebRtcTunnelSession(pairing);
  }

  return new MobileRelaySession(pairing);
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#101417",
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
});

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

function parsePairingConfig(input: string): PairingConfig | null {
  const payload = parsePairingLink(input);
  if (!payload) {
    return null;
  }

  return {
    relayUrl: payload.relay_url,
    deviceId: payload.device_id,
    key: payload.key,
    keyId: payload.key_id,
    transport:
      payload.transport === "websocket" || payload.transport === "webrtc"
        ? payload.transport
        : DEFAULT_PAIRING_TRANSPORT,
  };
}

function getHeaderSubtitle(
  view: AppView,
  deviceCount: number,
  activePairing: PairingConfig | null,
): string {
  if (view === "devices") {
    return `${deviceCount} linked ${deviceCount === 1 ? "device" : "devices"}`;
  }

  return activePairing?.deviceId ?? "";
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
  return (
    status === "created" || status === "starting" || status === "recovering"
  );
}

function formatRelayCloseMessage(event: {
  code?: number;
  reason?: string;
}): string {
  const reason = event.reason ? `: ${event.reason}` : "";
  return `Relay connection closed${event.code ? ` (${event.code})` : ""}${reason}`;
}
