import {
  type JSX,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import type {
  TerminalSession,
  MessageEnvelope,
  WorkspaceDefinition,
} from "@omniwork/protocol-ts";
import { createMessage } from "@omniwork/protocol-ts";
import type {
  AppSessionTransport,
  AppView,
  ConnectionStatus,
  PrimaryTabView,
} from "./appTypes";
import { getHeaderSubtitle, isPrimaryTabView } from "./appPresentation";
import { handleAppRelayMessage } from "./appRelayMessageHandler";
import { buildAppRouterProps } from "./appScreenProps";
import { AppRouter } from "./AppRouter";
import { AppShell, type PrimaryTabPressEvent } from "./AppShell";
import { useTransportController } from "./useTransportController";
import { usePreferenceController } from "./usePreferenceController";
import { useAppLifecycleController } from "./useAppLifecycleController";
import type { PairingConfig } from "../features/auth/types";
import { usePairingController } from "../features/auth/usePairingController";
import { useAppLockController } from "../features/app-lock/useAppLockController";
import { getSessionCapabilities } from "../features/sessions/sessionCapabilities";
import { useSessionController } from "../features/sessions/useSessionController";
import { useTerminalController } from "../features/terminal/useTerminalController";
import { useWorkspaceController } from "../features/workspaces/useWorkspaceController";
import { useAgentMessageController } from "../features/agent/useAgentMessageController";
import type { LocalAgentMessageRecord } from "../features/agent/agentMessageStore";
import type { MessageDetailReason } from "../screens/messages/AgentMessageDetailScreen";
import { ConfirmProvider, useConfirm } from "../ui/confirm/ConfirmProvider";

function isWorkbenchView(view: AppView): boolean {
  return (
    view === "workbench" ||
    view === "terminal" ||
    view === "terminalFiles" ||
    view === "fileEditor" ||
    view === "gitReview"
  );
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
  const [view, setView] = useState<AppView>("pairing");
  const [agentMessageRefreshRevealToken, setAgentMessageRefreshRevealToken] =
    useState(0);
  const [agentMessageDetail, setAgentMessageDetail] = useState<{
    record: LocalAgentMessageRecord;
    reason?: MessageDetailReason;
  } | null>(null);
  const pendingAutoOpenSessionsRef = useRef(false);
  const viewRef = useRef<AppView>("pairing");
  const selectedSessionRef = useRef<TerminalSession | null>(null);
  const confirm = useConfirm();

  const {
    transportPreference,
    language,
    terminalTextSize,
    handleChangeLanguage,
    handleChangeTerminalTextSize,
    handleChangeTransportPreference,
  } = usePreferenceController(confirm);

  const {
    pairings,
    pairing,
    pairingRef,
    pairingsRef,
    editingPairing,
    pairingError,
    pendingEncryptedPairingLink,
    encryptedPairingPassword,
    encryptedPairingError,
    setPairing,
    setEncryptedPairingPassword,
    setEncryptedPairingError,
    handlePair,
    handleEncryptedPairingSubmit,
    handleEncryptedPairingCancel,
    handleAddDevice,
    handleEditDevice,
    handleCancelPairing,
    handleDeleteDevice,
    handleOpenDevice,
    handleAuthFailureCleanup,
    resetPairingState,
  } = usePairingController({
    t,
    confirm,
    getConnectionStatus: () => connectionStatus,
    setView,
    setConnectionStatus: (status) => setConnectionStatus(status),
    setConnectionMessage: (message) => setConnectionMessage(message),
    onClearActiveDeviceData: clearLocalAgentData,
    onCloseActiveTransport: () => closeActiveTransport(),
    onReconnectActivePairing: reconnectActivePairing,
    onRequestActiveDeviceRefresh: () => requestSessionListRefresh(),
    setPendingAutoOpenSessions: (value) => {
      pendingAutoOpenSessionsRef.current = value;
    },
  });

  const {
    connectionStatus,
    connectionPath,
    connectionMessage,
    setConnectionStatus,
    setConnectionMessage,
    sendToRelay,
    reconnectActivePairing: reconnectTransport,
    closeActiveTransport,
    getAppConnectionId,
    withActiveTransport,
    requestP2pReconnect,
  } = useTransportController({
    pairing,
    transportPreference,
    onMessage: handleRelayMessage,
    onPreferP2pConnectStart: clearLocalAgentData,
    onDirectConnectionReady: markDirectConnectionReady,
    setPairing,
  });

  const {
    selectedWorkspace,
    workspaceCache,
    gitReviewPath,
    gitReviewScope,
    fileEditorPath,
    fileRelativePath,
    fileEntries,
    selectedFilePath,
    selectedFile,
    editorFile,
    editorLoading,
    editorSaving,
    filesLoading,
    gitStatus,
    gitDiffCache,
    gitFileContentCache,
    gitFileContentLoadingKeys,
    gitDiff,
    gitDiffLoading,
    gitLoading,
    lastFileWriteResult,
    selectWorkspace: setSelectedWorkspace,
    clearSelectedWorkspace,
    clearWorkspaceState,
    reconcileSelectedWorkspace,
    requestWorkspaceDirectory,
    handleOpenWorkspaceFiles,
    handleRefreshWorkspaceFiles,
    handleOpenWorkspaceGit,
    handleRefreshWorkspaceGit,
    handleOpenDirectory,
    handleReadFile,
    handleOpenFileEditor,
    handleReloadEditorFile,
    handleSaveEditorFile,
    handleEditorContentChange,
    handleCloseFileEditor,
    handleCloseFilePreview,
    handleOpenGitDiff,
    handleOpenGitReview,
    handlePrefetchGitDiff,
    handleReadGitFileContent,
    applyFilesList,
    applyFilesRead,
    applyFilesWrite,
    applyGitStatus,
    applyGitDiff,
  } = useWorkspaceController({
    pairing,
    connectionStatus,
    currentView: view,
    setView,
    sendToRelay,
  });

  const {
    selectedSession,
    selectedSessionCapabilities,
    sessions,
    terminalProviders,
    workspaces,
    defaultSessionCwd,
    creatingSession,
    closingSessionIds,
    killingSessionIds,
    selectSession: setSelectedSession,
    clearSessionState,
    resetSessionProgress,
    requestSessionListRefresh,
    handleRefreshSessions,
    handleCreateSession,
    handleCloseSession,
    handleRenameSession,
    handleKillTerminalSession,
    applySessionList,
    applySessionStatus,
    applyWorkspaceList,
    applySelectedSessionTerminalSize,
  } = useSessionController({
    pairing,
    connectionStatus,
    terminalTextSize,
    confirm,
    setView,
    setConnectionMessage,
    reconnectActivePairing,
    sendToRelay,
    onSessionWorkspaces: reconcileSelectedWorkspace,
  });

  const {
    selectedFrame,
    terminalStreamChunk,
    handleTerminalInput,
    handleTerminalResize,
    requestTerminalSnapshot,
    requestTerminalSnapshotForCurrentSession,
    clearTerminalState,
    pruneTerminalSurfaces,
    applyTerminalSnapshot,
    applyTerminalFrame,
    applyTerminalStreamReady,
    applyTerminalStreamData,
    applyTerminalStreamError,
  } = useTerminalController({
    pairing,
    connectionStatus,
    connectionPath,
    currentView: view,
    selectedSession,
    closingSessionIds,
    killingSessionIds,
    sendToRelay,
    setConnectionMessage,
    applySelectedSessionTerminalSize,
  });

  const {
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
  } = useAppLockController({
    t,
    confirm,
    pairingsCount: () => pairingsRef.current.length,
    setView,
    onResetAppData: (message) => {
      closeActiveTransport("app_lock_reset");
      pendingAutoOpenSessionsRef.current = false;
      resetSessionProgress();
      resetPairingState();
      clearLocalAgentData();
      resetSessionProgress();
      setConnectionStatus("idle");
      setConnectionMessage(message);
    },
  });

  const {
    agentNotificationSettings,
    agentMessages,
    agentUnreadCount,
    agentMessageBanner,
    agentMessagesRefreshing,
    agentMessageEditing,
    selectedAgentMessageIds,
    dismissAgentMessageBanner,
    handleChangeAgentNotifications,
    handleRefreshAgentMessages,
    handleMarkAgentMessageRead,
    handleMarkAgentMessageHandled,
    handleChangeAgentMessageEditing,
    handleToggleAgentMessageSelected,
    handleSelectAllAgentMessages,
    handleClearSelectedAgentMessages,
    handleDeleteAgentMessage,
    handleDeleteSelectedAgentMessages,
    handleOpenAgentMessage,
    handleAgentMessage,
    handleAgentNotificationSettings,
  } = useAgentMessageController({
    t,
    confirm,
    getPairing: () => pairingRef.current,
    getConnectionStatus: () => connectionStatus,
    getAppConnectionId,
    getCurrentSessionId: () => selectedSessionRef.current?.session_id,
    getCurrentView: () => viewRef.current,
    sendToRelay,
    setConnectionMessage,
    onOpenMessageTarget: openAgentMessageTarget,
  });

  const { clearFailureDialogState } = useAppLifecycleController({
    appLockAvailable,
    connectionPath,
    connectionStatus,
    connectionMessage,
    pairing,
    currentView: view,
    selectedSessionId: selectedSession?.session_id,
    selectedSurfaceId: selectedSession?.primary_surface_id,
    transportPreference,
    confirm,
    lockIfInactive,
    withActiveTransport,
    requestP2pReconnect,
    requestTerminalSnapshotForCurrentSession,
    shouldRefreshWorkbenchOnConnection,
    requestSessionListRefresh,
    reconnectActivePairing,
    clearSelectedSession: () => setSelectedSession(null),
    setView,
  });

  const canUseWorkspace = pairings.length > 0;
  const showPrimaryTabs = canUseWorkspace && isPrimaryTabView(view);
  const title = useMemo(() => {
    if (view === "pairing") {
      return editingPairing
        ? t("app.titles.editDevice")
        : t("app.titles.pairDesktop");
    }
    if (view === "terminal") {
      return selectedSession?.title ?? t("app.titles.terminal");
    }
    if (view === "terminalFiles") return t("workspaces.tabs.files");
    if (view === "workbench") return t("app.titles.workspaces");
    if (view === "connectionPreference") return t("app.titles.connectionMode");
    if (view === "securitySettings") return t("appLock.settings.title");
    if (view === "messages") return t("app.titles.messages");
    if (view === "settings") return t("app.titles.settings");
    return t("app.titles.devices");
  }, [editingPairing, selectedSession?.title, t, view]);

  const showHeader = view === "pairing" && !showingAppLockScreen;

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  function reconnectActivePairing(): void {
    clearFailureDialogState();
    reconnectTransport();
  }

  function handleRefreshDevices(): void {
    if (!pairing) {
      return;
    }
    if (connectionStatus !== "authenticated") {
      reconnectActivePairing();
      return;
    }
    setConnectionMessage(
      connectionPath === "p2p"
        ? "Direct P2P connection is ready."
        : "Connected to Desktop.",
    );
  }

  function openAgentMessageTarget(record: LocalAgentMessageRecord): void {
    const message = record.message;
    const target = resolveAgentMessageOpenTarget(message);
    if (target.kind === "detail") {
      setAgentMessageDetail({
        record,
        reason: target.reason,
      });
      setView("messageDetail");
      return;
    }

    openAgentMessageSession(message.id, target.session, Boolean(message.action));
  }

  function openAgentMessageSession(
    messageId: string,
    session: TerminalSession,
    markHandled: boolean,
  ): void {
    setAgentMessageDetail(null);
    setSelectedSession(session);
    const workspace = getSessionFilesWorkspace(session, workspaces);
    setSelectedWorkspace(workspace);
    setView("terminal");
    if (connectionStatus === "authenticated" && pairing) {
      requestTerminalSnapshot(pairing.deviceId, session);
    }
    if (markHandled) {
      handleMarkAgentMessageHandled(messageId);
    }
  }

  function resolveAgentMessageOpenTarget(
    message: LocalAgentMessageRecord["message"],
  ):
    | { kind: "session"; session: TerminalSession }
    | { kind: "detail"; reason: MessageDetailReason } {
    const sessionId = message.action?.session_id ?? message.session_id;
    if (!sessionId) {
      return { kind: "detail", reason: "missing_session_id" };
    }
    const session = sessions.find(
      (candidate) => candidate.session_id === sessionId,
    );
    if (!session) {
      return { kind: "detail", reason: "session_not_found" };
    }
    const capabilities = getSessionCapabilities(session, {
      closing: closingSessionIds.includes(session.session_id),
      killing: killingSessionIds.includes(session.session_id),
    });
    if (!capabilities.canOpen) {
      return { kind: "detail", reason: "session_unavailable" };
    }
    return { kind: "session", session };
  }

  function handleBackAgentMessageDetail(): void {
    setAgentMessageDetail(null);
    setView("messages");
  }

  function handleOpenAgentMessageDetailSession(): void {
    if (!agentMessageDetail) {
      return;
    }
    const target = resolveAgentMessageOpenTarget(
      agentMessageDetail.record.message,
    );
    if (target.kind !== "session") {
      setAgentMessageDetail({
        record: agentMessageDetail.record,
        reason: target.reason,
      });
      return;
    }
    openAgentMessageSession(
      agentMessageDetail.record.message.id,
      target.session,
      Boolean(agentMessageDetail.record.message.action),
    );
  }

  function handleChangePrimaryTab(
    nextView: PrimaryTabView,
    event: PrimaryTabPressEvent,
  ): void {
    setView(nextView);
    if (nextView === "messages" && event.doubleTap) {
      setAgentMessageRefreshRevealToken((token) => token + 1);
      void handleRefreshAgentMessages();
    }
  }

  function handleOpenSession(session: TerminalSession): void {
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
            surface_id: session.primary_surface_id,
          },
        ),
      );
      requestTerminalSnapshot(pairing.deviceId, session);
    }
  }

  function handleOpenTerminalFiles(session: TerminalSession): void {
    const workspace = getSessionFilesWorkspace(session, workspaces);
    setSelectedWorkspace(workspace);
    requestWorkspaceDirectory(
      workspace,
      workspaceCache[workspace.path]?.files.currentPath ?? "",
      { activate: true },
    );
    setView("terminalFiles");
  }

  function shouldRefreshWorkbenchOnConnection(): boolean {
    return (
      pendingAutoOpenSessionsRef.current ||
      isWorkbenchView(viewRef.current)
    );
  }

  function markDirectConnectionReady(): void {
    setConnectionStatus("authenticated");
    setConnectionMessage("Direct P2P connection is ready.");
    if (shouldRefreshWorkbenchOnConnection()) {
      requestSessionListRefresh();
    }
    if (pendingAutoOpenSessionsRef.current) {
      pendingAutoOpenSessionsRef.current = false;
      setView("workbench");
    }
  }

  function clearLocalAgentData(): void {
    clearSessionState({ clearDefaultCwd: true, clearCreating: true });
    clearWorkspaceState();
    clearTerminalState();
  }

  function handleRelayMessage(
    message: MessageEnvelope,
    relay: AppSessionTransport,
    activePairing: PairingConfig,
  ): void {
    handleAppRelayMessage(message, relay, activePairing, {
      t,
      confirm,
      currentView: view,
      pendingAutoOpenSessionsRef,
      clearFailureDialogState,
      clearLocalAgentData,
      shouldRefreshWorkbenchOnConnection,
      setConnectionStatus,
      setConnectionMessage,
      setView,
      setSelectedSession,
      resetSessionProgress,
      handleAuthFailureCleanup,
      applySessionList,
      pruneTerminalSurfaces,
      applySessionStatus,
      applyWorkspaceList,
      applyFilesList,
      applyFilesRead,
      applyFilesWrite,
      applyGitStatus,
      applyGitDiff,
      handleAgentMessage,
      handleAgentNotificationSettings,
      applyTerminalSnapshot,
      applyTerminalFrame,
      applyTerminalStreamReady,
      applyTerminalStreamData,
      applyTerminalStreamError,
    });
  }

  const agentMessageDetailTarget = agentMessageDetail
    ? resolveAgentMessageOpenTarget(agentMessageDetail.record.message)
    : null;

  const routerProps = buildAppRouterProps({
    t,
    view,
    setView,
    appLockScreen,
    appLockAvailable,
    appLockConfig,
    autoLockPickerVisible,
    selectedAutoLockOption,
    setGestureSetupMode,
    setPendingSecurityAction,
    setAutoLockPickerVisible,
    setSelectedAutoLockOption,
    handleConfirmAutoLockOption,
    pairings,
    pairing,
    editingPairing,
    pairingError,
    handlePair,
    handleCancelPairing,
    handleAddDevice,
    handleEditDevice,
    handleDeleteDevice,
    handleOpenDevice,
    handleRefreshDevices,
    connectionStatus,
    connectionPath,
    connectionMessage,
    agentMessages,
    agentMessagesRefreshing,
    agentMessageRefreshRevealToken,
    agentMessageEditing,
    selectedAgentMessageIds,
    agentNotificationSettings,
    handleChangeAgentNotifications,
    handleRefreshAgentMessages,
    handleOpenAgentMessage,
    handleMarkAgentMessageRead,
    handleMarkAgentMessageHandled,
    handleChangeAgentMessageEditing,
    handleToggleAgentMessageSelected,
    handleSelectAllAgentMessages,
    handleClearSelectedAgentMessages,
    handleDeleteAgentMessage,
    handleDeleteSelectedAgentMessages,
    agentMessageDetail: agentMessageDetail?.record ?? null,
    agentMessageDetailReason:
      agentMessageDetailTarget?.kind === "detail"
        ? agentMessageDetailTarget.reason
        : undefined,
    agentMessageDetailCanOpenSession:
      agentMessageDetailTarget?.kind === "session",
    handleBackAgentMessageDetail,
    handleOpenAgentMessageDetailSession,
    transportPreference,
    terminalTextSize,
    language,
    handleChangeLanguage,
    handleChangeTerminalTextSize,
    handleChangeTransportPreference,
    sessions,
    terminalProviders,
    workspaces,
    creatingSession,
    closingSessionIds,
    killingSessionIds,
    defaultSessionCwd,
    fileRelativePath,
    fileEntries,
    selectedFilePath,
    selectedFile,
    filesLoading,
    gitStatus,
    gitDiff,
    gitDiffCache,
    gitFileContentCache,
    gitFileContentLoadingKeys,
    gitLoading,
    gitDiffLoading,
    gitReviewPath,
    gitReviewScope,
    selectedWorkspace,
    selectedSession,
    selectedFrame,
    selectedSessionCapabilities,
    terminalStreamChunk,
    fileEditorPath,
    editorFile,
    editorLoading,
    editorSaving,
    lastFileWriteResult,
    handleRefreshSessions,
    handleCreateSession,
    handleOpenWorkspaceFiles,
    handleOpenWorkspaceGit,
    handleRefreshWorkspaceFiles,
    handleRefreshWorkspaceGit,
    handleOpenDirectory,
    handleReadFile,
    handleOpenFileEditor,
    handleCloseFilePreview,
    handleOpenGitDiff,
    handleOpenGitReview,
    handlePrefetchGitDiff,
    handleReadGitFileContent,
    handleOpenSession,
    handleCloseSession,
    handleRenameSession,
    handleKillTerminalSession,
    handleOpenTerminalFiles,
    handleTerminalInput,
    handleTerminalResize,
    handleCloseFileEditor,
    handleEditorContentChange,
    handleReloadEditorFile,
    handleSaveEditorFile,
  });

  return (
    <AppShell
      title={title}
      subtitle={
        canUseWorkspace ? getHeaderSubtitle(view, pairings.length, pairing, t) : undefined
      }
      showHeader={showHeader}
      showPrimaryTabs={!appLockScreen && showPrimaryTabs}
      activeTab={view}
      unreadMessages={agentUnreadCount}
      agentMessageBanner={!appLockScreen ? (agentMessageBanner ?? undefined) : undefined}
      encryptedPairingModal={{
        visible: Boolean(pendingEncryptedPairingLink),
        password: encryptedPairingPassword,
        error: encryptedPairingError,
        onPasswordChange: (password) => {
          setEncryptedPairingPassword(password);
          setEncryptedPairingError(undefined);
        },
        onSubmit: () => {
          void handleEncryptedPairingSubmit();
        },
        onCancel: handleEncryptedPairingCancel,
      }}
      onContentTouchStart={updateLastInteraction}
      onChangeTab={handleChangePrimaryTab}
      onDismissAgentMessageBanner={dismissAgentMessageBanner}
      onOpenAgentMessageBanner={(record) => {
        dismissAgentMessageBanner();
        handleOpenAgentMessage(record);
      }}
    >
          <AppRouter {...routerProps} />
    </AppShell>
  );
}

function getSessionFilesWorkspace(
  session: TerminalSession,
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
