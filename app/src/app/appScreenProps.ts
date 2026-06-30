import type { ComponentProps } from "react";

import { AppRouter } from "./AppRouter";
import type { ConnectionStatus } from "./appTypes";

type AppRouterProps = ComponentProps<typeof AppRouter>;
type PairingScreenProps = AppRouterProps["pairingScreenProps"];
type DeviceListScreenProps = AppRouterProps["deviceListScreenProps"];
type AgentMessageInboxScreenProps =
  AppRouterProps["agentMessageInboxScreenProps"];
type AgentMessageDetailScreenProps = NonNullable<
  AppRouterProps["agentMessageDetailScreenProps"]
>;
type SettingsScreenProps = AppRouterProps["settingsScreenProps"];
type SecuritySettingsScreenProps =
  AppRouterProps["securitySettingsScreenProps"];
type ConnectionPreferenceScreenProps =
  AppRouterProps["connectionPreferenceScreenProps"];
type WorkbenchScreenProps = AppRouterProps["workbenchScreenProps"];
type GitReviewScreenProps = NonNullable<AppRouterProps["gitReviewScreenProps"]>;
type TerminalScreenProps = NonNullable<AppRouterProps["terminalScreenProps"]>;
type TerminalFilesScreenProps = NonNullable<
  AppRouterProps["terminalFilesScreenProps"]
>;
type FileEditorScreenProps = NonNullable<
  AppRouterProps["fileEditorScreenProps"]
>;

type SessionCapabilities = {
  canInput: boolean;
  canResize: boolean;
  unavailableReason?: string;
};

type GestureSetupMode = "firstRun" | "enable" | "change" | null;
type PendingSecurityAction = "disable" | "change" | null;

type BuildAppRouterPropsOptions = {
  t(key: string): string;
  view: AppRouterProps["view"];
  setView(view: AppRouterProps["view"]): void;
  appLockScreen: AppRouterProps["appLockScreen"];
  appLockAvailable: boolean;
  appLockConfig: SecuritySettingsScreenProps["config"];
  autoLockPickerVisible: SecuritySettingsScreenProps["pickerVisible"];
  selectedAutoLockOption: SecuritySettingsScreenProps["selectedAutoLockOption"];
  setGestureSetupMode(mode: GestureSetupMode): void;
  setPendingSecurityAction(action: PendingSecurityAction): void;
  setAutoLockPickerVisible(visible: boolean): void;
  setSelectedAutoLockOption: SecuritySettingsScreenProps["onSelectAutoLockOption"];
  handleConfirmAutoLockOption: SecuritySettingsScreenProps["onConfirmAutoLockOption"];
  pairings: DeviceListScreenProps["pairings"];
  pairing: DeviceListScreenProps["activePairing"] | null;
  editingPairing: PairingScreenProps["initialPairing"];
  pairingError: PairingScreenProps["errorMessage"];
  handlePair: PairingScreenProps["onPair"];
  handleCancelPairing: NonNullable<PairingScreenProps["onCancel"]>;
  handleAddDevice: DeviceListScreenProps["onAddDevice"];
  handleEditDevice: DeviceListScreenProps["onEditDevice"];
  handleDeleteDevice: DeviceListScreenProps["onDeleteDevice"];
  handleOpenDevice: DeviceListScreenProps["onOpenDevice"];
  handleRefreshDevices: DeviceListScreenProps["onRefreshDevices"];
  connectionStatus: ConnectionStatus;
  connectionPath: DeviceListScreenProps["connectionPath"];
  connectionMessage: DeviceListScreenProps["connectionMessage"];
  agentMessages: AgentMessageInboxScreenProps["messages"];
  agentMessagesRefreshing: AgentMessageInboxScreenProps["refreshing"];
  agentMessageRefreshRevealToken: AgentMessageInboxScreenProps["refreshRevealToken"];
  agentMessageEditing: AgentMessageInboxScreenProps["editing"];
  selectedAgentMessageIds: AgentMessageInboxScreenProps["selectedMessageIds"];
  agentNotificationSettings: {
    enabled: SettingsScreenProps["agentNotificationsEnabled"];
  };
  handleChangeAgentNotifications: SettingsScreenProps["onChangeAgentNotifications"];
  handleRefreshAgentMessages: AgentMessageInboxScreenProps["onRefresh"];
  handleOpenAgentMessage: AgentMessageInboxScreenProps["onOpenMessage"];
  handleMarkAgentMessageRead: AgentMessageInboxScreenProps["onMarkRead"];
  handleMarkAgentMessageHandled: AgentMessageInboxScreenProps["onMarkHandled"];
  handleChangeAgentMessageEditing: AgentMessageInboxScreenProps["onChangeEditing"];
  handleToggleAgentMessageSelected: AgentMessageInboxScreenProps["onToggleSelected"];
  handleSelectAllAgentMessages: AgentMessageInboxScreenProps["onSelectAll"];
  handleClearSelectedAgentMessages: AgentMessageInboxScreenProps["onClearSelection"];
  handleDeleteAgentMessage: AgentMessageInboxScreenProps["onDeleteMessage"];
  handleDeleteSelectedAgentMessages: AgentMessageInboxScreenProps["onDeleteSelected"];
  agentMessageDetail: AgentMessageDetailScreenProps["record"] | null;
  agentMessageDetailReason: AgentMessageDetailScreenProps["reason"];
  agentMessageDetailCanOpenSession: AgentMessageDetailScreenProps["canOpenSession"];
  handleBackAgentMessageDetail: AgentMessageDetailScreenProps["onBack"];
  handleOpenAgentMessageDetailSession: AgentMessageDetailScreenProps["onOpenSession"];
  transportPreference: ConnectionPreferenceScreenProps["transportPreference"];
  terminalTextSize: SettingsScreenProps["terminalTextSize"];
  language: SettingsScreenProps["language"];
  handleChangeLanguage: SettingsScreenProps["onChangeLanguage"];
  handleChangeTerminalTextSize: SettingsScreenProps["onChangeTerminalTextSize"];
  handleChangeTransportPreference: ConnectionPreferenceScreenProps["onChangeTransportPreference"];
  sessions: WorkbenchScreenProps["sessions"];
  terminalProviders: WorkbenchScreenProps["providers"];
  workspaces: WorkbenchScreenProps["workspaces"];
  creatingSession: WorkbenchScreenProps["creating"];
  closingSessionIds: WorkbenchScreenProps["closingSessionIds"];
  killingSessionIds: WorkbenchScreenProps["killingSessionIds"];
  defaultSessionCwd: string;
  fileRelativePath: WorkbenchScreenProps["fileRelativePath"];
  fileEntries: WorkbenchScreenProps["fileEntries"];
  selectedFilePath: WorkbenchScreenProps["selectedFilePath"];
  selectedFile: WorkbenchScreenProps["selectedFile"];
  filesLoading: WorkbenchScreenProps["filesLoading"];
  gitStatus: WorkbenchScreenProps["gitStatus"];
  gitDiff: WorkbenchScreenProps["gitDiff"];
  gitDiffCache: WorkbenchScreenProps["gitDiffCache"];
  gitFileContentCache: WorkbenchScreenProps["gitFileContentCache"];
  gitFileContentLoadingKeys: WorkbenchScreenProps["gitFileContentLoadingKeys"];
  gitLoading: WorkbenchScreenProps["gitLoading"];
  gitDiffLoading: GitReviewScreenProps["loading"];
  gitReviewPath: GitReviewScreenProps["initialPath"];
  gitReviewScope: GitReviewScreenProps["initialScope"];
  selectedWorkspace: TerminalFilesScreenProps["workspace"] | null | undefined;
  selectedSession: TerminalScreenProps["session"] | null;
  selectedFrame: TerminalScreenProps["frame"];
  selectedSessionCapabilities: SessionCapabilities | null | undefined;
  terminalStreamChunk: TerminalScreenProps["streamChunk"] | null;
  fileEditorPath: FileEditorScreenProps["relativePath"] | undefined;
  editorFile: FileEditorScreenProps["file"];
  editorLoading: FileEditorScreenProps["loading"];
  editorSaving: FileEditorScreenProps["saving"];
  lastFileWriteResult: FileEditorScreenProps["writeResult"];
  handleRefreshSessions: WorkbenchScreenProps["onRefreshSessions"];
  handleCreateSession: WorkbenchScreenProps["onCreateSession"];
  handleOpenWorkspaceFiles: WorkbenchScreenProps["onOpenWorkspaceFiles"];
  handleOpenWorkspaceGit: WorkbenchScreenProps["onOpenWorkspaceGit"];
  handleRefreshWorkspaceFiles: WorkbenchScreenProps["onRefreshWorkspaceFiles"];
  handleRefreshWorkspaceGit: WorkbenchScreenProps["onRefreshWorkspaceGit"];
  handleOpenDirectory: WorkbenchScreenProps["onOpenDirectory"];
  handleReadFile: WorkbenchScreenProps["onReadFile"];
  handleOpenFileEditor: WorkbenchScreenProps["onEditFile"];
  handleCloseFilePreview: WorkbenchScreenProps["onCloseFilePreview"];
  handleOpenGitDiff: WorkbenchScreenProps["onOpenGitDiff"];
  handleOpenGitReview: WorkbenchScreenProps["onOpenGitReview"];
  handlePrefetchGitDiff: WorkbenchScreenProps["onPrefetchGitDiff"];
  handleReadGitFileContent: WorkbenchScreenProps["onReadGitFileContent"];
  handleOpenSession: WorkbenchScreenProps["onOpenSession"];
  handleCloseSession: WorkbenchScreenProps["onCloseSession"];
  handleRenameSession: WorkbenchScreenProps["onRenameSession"];
  handleKillTerminalSession: WorkbenchScreenProps["onKillTerminalSession"];
  handleOpenTerminalFiles(session: TerminalScreenProps["session"]): void;
  handleTerminalInput: TerminalScreenProps["onInput"];
  handleTerminalResize: TerminalScreenProps["onResize"];
  handleCloseFileEditor: FileEditorScreenProps["onBack"];
  handleEditorContentChange: FileEditorScreenProps["onContentChange"];
  handleReloadEditorFile: FileEditorScreenProps["onReload"];
  handleSaveEditorFile: FileEditorScreenProps["onSave"];
};

export function buildAppRouterProps(
  o: BuildAppRouterPropsOptions,
): AppRouterProps {
  const selectedWorkspace = o.selectedWorkspace;
  const selectedSession = o.selectedSession;

  return {
    appLockScreen: o.appLockScreen,
    view: o.view,
    pairingScreenProps: {
      errorMessage: o.pairingError,
      initialPairing: o.editingPairing,
      submitLabel: o.editingPairing ? o.t("app.actions.saveDevice") : undefined,
      onCancel: o.pairings.length > 0 ? o.handleCancelPairing : undefined,
      onPair: o.handlePair,
    },
    deviceListScreenProps: {
      pairings: o.pairings,
      activePairing: o.pairing ?? undefined,
      connectionStatus: o.connectionStatus,
      connectionPath: o.connectionPath,
      connectionMessage: o.connectionMessage,
      onAddDevice: o.handleAddDevice,
      onEditDevice: o.handleEditDevice,
      onDeleteDevice: o.handleDeleteDevice,
      onOpenDevice: o.handleOpenDevice,
      onRefreshDevices: o.handleRefreshDevices,
    },
    agentMessageInboxScreenProps: {
      messages: o.agentMessages,
      refreshing: o.agentMessagesRefreshing,
      refreshRevealToken: o.agentMessageRefreshRevealToken,
      editing: o.agentMessageEditing,
      selectedMessageIds: o.selectedAgentMessageIds,
      onRefresh: o.handleRefreshAgentMessages,
      onOpenMessage: o.handleOpenAgentMessage,
      onMarkRead: o.handleMarkAgentMessageRead,
      onMarkHandled: o.handleMarkAgentMessageHandled,
      onChangeEditing: o.handleChangeAgentMessageEditing,
      onToggleSelected: o.handleToggleAgentMessageSelected,
      onSelectAll: o.handleSelectAllAgentMessages,
      onClearSelection: o.handleClearSelectedAgentMessages,
      onDeleteMessage: o.handleDeleteAgentMessage,
      onDeleteSelected: o.handleDeleteSelectedAgentMessages,
    },
    agentMessageDetailScreenProps: o.agentMessageDetail
      ? {
          record: o.agentMessageDetail,
          reason: o.agentMessageDetailReason,
          canOpenSession: o.agentMessageDetailCanOpenSession,
          onBack: o.handleBackAgentMessageDetail,
          onOpenSession: o.handleOpenAgentMessageDetailSession,
          onMarkHandled: o.handleMarkAgentMessageHandled,
        }
      : undefined,
    settingsScreenProps: {
      terminalTextSize: o.terminalTextSize,
      language: o.language,
      agentNotificationsEnabled: o.agentNotificationSettings.enabled,
      onChangeLanguage: o.handleChangeLanguage,
      onChangeTerminalTextSize: o.handleChangeTerminalTextSize,
      onChangeAgentNotifications: o.handleChangeAgentNotifications,
      onOpenConnectionPreference: () => o.setView("connectionPreference"),
      onOpenSecuritySettings: o.appLockAvailable
        ? () => o.setView("securitySettings")
        : undefined,
    },
    securitySettingsScreenProps: {
      config: o.appLockConfig,
      pickerVisible: o.autoLockPickerVisible,
      selectedAutoLockOption: o.selectedAutoLockOption,
      onBack: () => o.setView("settings"),
      onEnable: () => o.setGestureSetupMode("enable"),
      onChangeGesture: () => o.setPendingSecurityAction("change"),
      onDisable: () => o.setPendingSecurityAction("disable"),
      onOpenAutoLockPicker: () => {
        o.setSelectedAutoLockOption(o.appLockConfig.autoLockOption);
        o.setAutoLockPickerVisible(true);
      },
      onCloseAutoLockPicker: () => o.setAutoLockPickerVisible(false),
      onSelectAutoLockOption: o.setSelectedAutoLockOption,
      onConfirmAutoLockOption: o.handleConfirmAutoLockOption,
    },
    connectionPreferenceScreenProps: {
      transportPreference: o.transportPreference,
      onChangeTransportPreference: o.handleChangeTransportPreference,
      onBack: () => o.setView("settings"),
    },
    workbenchScreenProps: {
      sessions: o.sessions,
      providers: o.terminalProviders,
      workspaces: o.workspaces,
      providerPreferenceScope: o.pairing?.deviceId ?? "default",
      creating: o.creatingSession,
      closingSessionIds: o.closingSessionIds,
      killingSessionIds: o.killingSessionIds,
      defaultCwd: o.defaultSessionCwd || o.sessions[0]?.cwd || "",
      fileRelativePath: o.fileRelativePath,
      fileEntries: o.fileEntries,
      selectedFilePath: o.selectedFilePath,
      selectedFile: o.selectedFile,
      filesLoading: o.filesLoading,
      gitStatus: o.gitStatus,
      gitDiff: o.gitDiff,
      gitDiffCache: o.gitDiffCache,
      gitFileContentCache: o.gitFileContentCache,
      gitFileContentLoadingKeys: o.gitFileContentLoadingKeys,
      gitLoading: o.gitLoading,
      onBack: () => o.setView("devices"),
      onRefreshSessions: o.handleRefreshSessions,
      onCreateSession: o.handleCreateSession,
      onOpenWorkspaceFiles: o.handleOpenWorkspaceFiles,
      onOpenWorkspaceGit: o.handleOpenWorkspaceGit,
      onRefreshWorkspaceFiles: o.handleRefreshWorkspaceFiles,
      onRefreshWorkspaceGit: o.handleRefreshWorkspaceGit,
      onOpenDirectory: o.handleOpenDirectory,
      onReadFile: o.handleReadFile,
      onEditFile: o.handleOpenFileEditor,
      onCloseFilePreview: o.handleCloseFilePreview,
      onOpenGitDiff: o.handleOpenGitDiff,
      onOpenGitReview: o.handleOpenGitReview,
      onPrefetchGitDiff: o.handlePrefetchGitDiff,
      onReadGitFileContent: o.handleReadGitFileContent,
      onOpenSession: o.handleOpenSession,
      onCloseSession: o.handleCloseSession,
      onRenameSession: o.handleRenameSession,
      onKillTerminalSession: o.handleKillTerminalSession,
    },
    gitReviewScreenProps:
      o.view === "gitReview" && selectedWorkspace
        ? {
            workspace: selectedWorkspace,
            status: o.gitStatus,
            diff: o.gitDiff,
            diffCache: o.gitDiffCache,
            fileContentCache: o.gitFileContentCache,
            fileContentLoadingKeys: o.gitFileContentLoadingKeys,
            loading: o.gitDiffLoading,
            initialMode: "review",
            initialPath: o.gitReviewPath,
            initialScope: o.gitReviewScope,
            onBack: () => o.setView("workbench"),
            onRefresh: () => o.handleRefreshWorkspaceGit(selectedWorkspace),
            onOpenDiff: o.handleOpenGitDiff,
            onEditFile: (relativePath: string) =>
              o.handleOpenFileEditor(selectedWorkspace, relativePath),
            onPrefetchDiff: o.handlePrefetchGitDiff,
            onReadFileContent: o.handleReadGitFileContent,
          }
        : undefined,
    terminalScreenProps:
      (o.view === "terminal" || o.view === "terminalFiles") && selectedSession
        ? {
            session: selectedSession,
            frame: o.selectedFrame,
            streamChunk:
              o.terminalStreamChunk?.surfaceId ===
              selectedSession.primary_surface_id
                ? o.terminalStreamChunk
                : undefined,
            connectionStatus: o.connectionStatus,
            statusLabel: o.connectionMessage,
            readOnlyReason: o.selectedSessionCapabilities?.canInput
              ? undefined
              : (o.selectedSessionCapabilities?.unavailableReason ??
                o.t("app.errors.readOnlySession")),
            canInput: Boolean(o.selectedSessionCapabilities?.canInput),
            canResize: Boolean(o.selectedSessionCapabilities?.canResize),
            textSize: o.terminalTextSize,
            onBack: () => o.setView("workbench"),
            onOpenFiles: () => o.handleOpenTerminalFiles(selectedSession),
            onChangeTextSize: o.handleChangeTerminalTextSize,
            onRefreshSessions: o.handleRefreshSessions,
            onInput: o.handleTerminalInput,
            onResize: o.handleTerminalResize,
          }
        : undefined,
    terminalFilesScreenProps:
      o.view === "terminalFiles" && selectedWorkspace
        ? {
            workspace: selectedWorkspace,
            relativePath: o.fileRelativePath,
            entries: o.fileEntries,
            selectedFilePath: o.selectedFilePath,
            file: o.selectedFile,
            loading: o.filesLoading,
            presentation: "modal",
            onBack: () => o.setView("terminal"),
            onRefresh: () =>
              o.handleRefreshWorkspaceFiles(
                selectedWorkspace,
                o.fileRelativePath,
              ),
            onOpenDirectory: o.handleOpenDirectory,
            onReadFile: o.handleReadFile,
            onEditFile: (relativePath: string) =>
              o.handleOpenFileEditor(selectedWorkspace, relativePath),
            onCloseFilePreview: o.handleCloseFilePreview,
          }
        : undefined,
    fileEditorScreenProps:
      o.view === "fileEditor" && selectedWorkspace && o.fileEditorPath
        ? {
            workspace: selectedWorkspace,
            relativePath: o.fileEditorPath,
            file: o.editorFile,
            loading: o.editorLoading,
            saving: o.editorSaving,
            writeResult: o.lastFileWriteResult,
            onBack: o.handleCloseFileEditor,
            onContentChange: o.handleEditorContentChange,
            onReload: o.handleReloadEditorFile,
            onSave: o.handleSaveEditorFile,
          }
        : undefined,
    onCloseTerminalFiles: () => o.setView("terminal"),
  };
}
