import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  type LayoutChangeEvent,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useTranslation } from "react-i18next";

import type {
  AgentCapability,
  TerminalProviderDefinition,
  TerminalSession,
  FilesReadPayload,
  GitDiffPayload,
  GitDiffScope,
  TerminalProviderKind,
  WorkspaceDefinition,
  WorkspaceFileEntry,
  WorkspaceGitStatus,
} from "@omniwork/protocol-ts";
import {
  getTerminalProviderDefinition,
  getCreatableTerminalProviders,
  isCreatableTerminalProviderKind,
} from "@omniwork/protocol-ts";
import i18n from "../../i18n";
import { getSessionCapabilities } from "../../features/sessions/sessionCapabilities";
import { Badge, Button, Card } from "../../ui/components";
import { colors, radii, spacing, typography } from "../../ui/theme";
import { FileBrowserScreen } from "../workspaces/FileBrowserScreen";
import { GitStatusScreen } from "../workspaces/GitStatusScreen";

type CreatableTerminalProviderKind = TerminalProviderKind;
type WorkspaceTab = "sessions" | "git" | "files";

type TerminalProviderGroup = {
  kind: TerminalProviderKind;
  label: string;
  summary: string;
  capability?: AgentCapability;
  creatable: boolean;
  hidden?: boolean;
  default?: boolean;
};

export interface SessionListScreenProps {
  sessions: TerminalSession[];
  providers: TerminalProviderDefinition[];
  workspaces: WorkspaceDefinition[];
  providerPreferenceScope: string;
  creating: boolean;
  closingSessionIds?: string[];
  killingSessionIds?: string[];
  defaultCwd: string;
  fileRelativePath: string;
  fileEntries: WorkspaceFileEntry[];
  selectedFilePath?: string;
  selectedFile?: FilesReadPayload;
  filesLoading?: boolean;
  gitStatus?: WorkspaceGitStatus;
  gitDiff?: GitDiffPayload;
  gitDiffCache?: Record<string, GitDiffPayload>;
  gitFileContentCache?: Record<string, FilesReadPayload>;
  gitFileContentLoadingKeys?: Record<string, boolean>;
  gitLoading?: boolean;
  onBack(): void;
  onRefreshSessions(): void;
  onCreateSession(input: {
    cwd: string;
    terminalProviderKind: CreatableTerminalProviderKind;
    workspacePath?: string;
  }): void;
  onOpenWorkspaceFiles(workspace: WorkspaceDefinition): void;
  onOpenWorkspaceGit(workspace: WorkspaceDefinition): void;
  onRefreshWorkspaceFiles(
    workspace: WorkspaceDefinition,
    relativePath: string,
  ): void;
  onRefreshWorkspaceGit(workspace: WorkspaceDefinition): void;
  onPrefetchWorkspaceTab(
    workspace: WorkspaceDefinition,
    tab: "git" | "files",
  ): void;
  onOpenDirectory(relativePath: string): void;
  onReadFile(relativePath: string): void;
  onEditFile(workspace: WorkspaceDefinition, relativePath: string): void;
  onCloseFilePreview(): void;
  onOpenGitDiff(relativePath?: string, scope?: GitDiffScope): void;
  onOpenGitReview(
    workspace: WorkspaceDefinition,
    relativePath?: string,
    scope?: GitDiffScope,
  ): void;
  onPrefetchGitDiff(relativePath?: string, scope?: GitDiffScope): void;
  onReadGitFileContent(relativePath: string): void;
  onOpenSession(session: TerminalSession): void;
  onCloseSession(session: TerminalSession): void;
  onRenameSession(session: TerminalSession, title: string): void;
  onKillTerminalSession(session: TerminalSession): void;
}

type ProviderPreferences = {
  hiddenKinds: string[];
  orderedKinds: string[];
  defaultKind?: string;
};

const EMPTY_PROVIDER_PREFERENCES: ProviderPreferences = {
  hiddenKinds: [],
  orderedKinds: [],
};

const PROVIDER_PREFERENCES_STORAGE_PREFIX =
  "omniwork.session.providerPreferences";
const UNASSIGNED_WORKSPACE_PATH = "__unassigned__";

export function SessionListScreen({
  sessions,
  providers,
  workspaces,
  providerPreferenceScope,
  creating,
  closingSessionIds = [],
  killingSessionIds = [],
  defaultCwd,
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
  onBack,
  onRefreshSessions,
  onCreateSession,
  onOpenWorkspaceFiles,
  onOpenWorkspaceGit,
  onRefreshWorkspaceFiles,
  onRefreshWorkspaceGit,
  onPrefetchWorkspaceTab,
  onOpenDirectory,
  onReadFile,
  onEditFile,
  onCloseFilePreview,
  onOpenGitDiff,
  onOpenGitReview,
  onPrefetchGitDiff,
  onReadGitFileContent,
  onOpenSession,
  onCloseSession,
  onRenameSession,
  onKillTerminalSession,
}: SessionListScreenProps): JSX.Element {
  const { t } = useTranslation();
  const [providerPreferences, setProviderPreferences] =
    useState<ProviderPreferences>(EMPTY_PROVIDER_PREFERENCES);
  const [providerPreferencesLoaded, setProviderPreferencesLoaded] =
    useState(false);
  const [providersModalVisible, setProvidersModalVisible] = useState(false);
  const orderedProviders = useMemo(
    () => orderProviders(providers, providerPreferences.orderedKinds),
    [providerPreferences.orderedKinds, providers],
  );
  const enabledProviders = useMemo(
    () =>
      orderedProviders.filter(
        (provider) => !providerPreferences.hiddenKinds.includes(provider.kind),
      ),
    [orderedProviders, providerPreferences.hiddenKinds],
  );
  const creatableProviders = useMemo(
    () => getCreatableTerminalProviders(enabledProviders),
    [enabledProviders],
  );
  const defaultCreateTerminalProviderKind = creatableProviders[0]?.kind ?? "other";
  const preferredCreateTerminalProviderKind =
    creatableProviders.find(
      (provider) => provider.kind === providerPreferences.defaultKind,
    )?.kind ?? defaultCreateTerminalProviderKind;
  const effectiveDefaultProviderKind = preferredCreateTerminalProviderKind;
  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [createCwd, setCreateCwd] = useState(defaultCwd);
  const [createWorkspacePath, setCreateWorkspacePath] = useState<
    string | undefined
  >();
  const [createWorkspaceLocked, setCreateWorkspaceLocked] = useState(false);
  const [createTerminalProviderKind, setCreateTerminalProviderKind] =
    useState<CreatableTerminalProviderKind>(preferredCreateTerminalProviderKind);
  const [renamingSession, setRenamingSession] = useState<TerminalSession | null>(
    null,
  );
  const [renameTitle, setRenameTitle] = useState("");
  const [managingSession, setManagingSession] = useState<TerminalSession | null>(
    null,
  );
  const [selectedWorkspace, setSelectedWorkspace] =
    useState<WorkspaceDefinition | null>(null);
  const [activeWorkspaceTab, setActiveWorkspaceTab] =
    useState<WorkspaceTab>("sessions");
  const { width: windowWidth } = useWindowDimensions();
  const workspacePagerRef = useRef<ScrollView | null>(null);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const enteredWorkspacePathsRef = useRef<Set<string>>(new Set());
  const [workspacePagerWidth, setWorkspacePagerWidth] = useState(0);
  const [sessionRefreshing, setSessionRefreshing] = useState(false);

  const providerGroups = useMemo<TerminalProviderGroup[]>(
    () => [
      ...orderedProviders.map((provider) => ({
        kind: provider.kind,
        label: provider.displayName,
        summary: provider.summary,
        capability: provider.capability,
        creatable: provider.creatable,
        hidden: providerPreferences.hiddenKinds.includes(provider.kind),
        default: provider.kind === effectiveDefaultProviderKind,
      })),
      {
        kind: "other",
        label: t("workspaces.provider.other"),
        summary: t("workspaces.provider.otherSummary"),
        creatable: true,
      },
    ],
    [effectiveDefaultProviderKind, orderedProviders, providerPreferences, t],
  );

  useEffect(() => {
    setProviderPreferencesLoaded(false);
    AsyncStorage.getItem(
      getProviderPreferencesStorageKey(providerPreferenceScope),
    )
      .then((value) => {
        setProviderPreferences(parseProviderPreferences(value));
      })
      .catch(() => {
        setProviderPreferences(EMPTY_PROVIDER_PREFERENCES);
      })
      .finally(() => {
        setProviderPreferencesLoaded(true);
      });
  }, [providerPreferenceScope]);

  useEffect(() => {
    if (!providerPreferencesLoaded) {
      return;
    }

    AsyncStorage.setItem(
      getProviderPreferencesStorageKey(providerPreferenceScope),
      JSON.stringify(providerPreferences),
    ).catch(() => {
      // Non-critical: provider preferences can be rebuilt from Agent metadata.
    });
  }, [providerPreferenceScope, providerPreferences, providerPreferencesLoaded]);

  useEffect(() => {
    if (
      !isCreatableTerminalProviderKind(createTerminalProviderKind, enabledProviders) ||
      providerPreferences.hiddenKinds.includes(createTerminalProviderKind)
    ) {
      setCreateTerminalProviderKind(preferredCreateTerminalProviderKind);
    }
  }, [
    createTerminalProviderKind,
    enabledProviders,
    preferredCreateTerminalProviderKind,
    providerPreferences.hiddenKinds,
  ]);

  useEffect(() => {
    setProviderPreferences((current) =>
      normalizeProviderPreferences(current, providers),
    );
  }, [providers]);

  useEffect(
    () => () => {
      if (sessionRefreshTimerRef.current) {
        clearTimeout(sessionRefreshTimerRef.current);
      }
    },
    [],
  );

  function handleRefreshSessionTab(): void {
    setSessionRefreshing(true);
    onRefreshSessions();
    if (sessionRefreshTimerRef.current) {
      clearTimeout(sessionRefreshTimerRef.current);
    }
    sessionRefreshTimerRef.current = setTimeout(() => {
      setSessionRefreshing(false);
      sessionRefreshTimerRef.current = undefined;
    }, 1000);
  }

  function openCreateModal(
    terminalProviderKind: CreatableTerminalProviderKind,
    preferredWorkspace?: WorkspaceDefinition,
    lockedWorkspace = Boolean(preferredWorkspace),
  ): void {
    setCreateTerminalProviderKind(terminalProviderKind);
    const workspace = preferredWorkspace ?? workspaces[0];
    setCreateWorkspacePath(workspace?.path);
    setCreateCwd(workspace?.path ?? defaultCwd);
    setCreateWorkspaceLocked(lockedWorkspace);
    setCreateModalVisible(true);
  }

  function confirmCreateSession(): void {
    const cwd = createCwd.trim();
    if (!cwd) {
      return;
    }
    setCreateModalVisible(false);
    onCreateSession({
      cwd:
        createWorkspaceLocked && createWorkspacePath
          ? createWorkspacePath
          : cwd,
      terminalProviderKind: createTerminalProviderKind,
      workspacePath: createWorkspacePath,
    });
  }

  function openRenameModal(session: TerminalSession): void {
    setRenamingSession(session);
    setRenameTitle(session.title);
  }

  function confirmRenameSession(): void {
    const title = renameTitle.trim();
    if (!renamingSession || !title) {
      return;
    }

    onRenameSession(renamingSession, title);
    setRenamingSession(null);
    setRenameTitle("");
  }

  function openWorkspace(workspace: WorkspaceDefinition): void {
    setSelectedWorkspace(workspace);
    setActiveWorkspaceTab("sessions");
    if (refreshWorkspaceOnFirstEntry(workspace)) {
      return;
    }
    prefetchAdjacentWorkspaceTabs(workspace, "sessions");
  }

  function refreshWorkspaceOnFirstEntry(
    workspace: WorkspaceDefinition,
  ): boolean {
    if (enteredWorkspacePathsRef.current.has(workspace.path)) {
      return false;
    }
    enteredWorkspacePathsRef.current.add(workspace.path);
    onRefreshSessions();
    onRefreshWorkspaceFiles(workspace, "");
    if (workspace.isGitRepository) {
      onRefreshWorkspaceGit(workspace);
    }
    return true;
  }

  function prefetchAdjacentWorkspaceTabs(
    workspace: WorkspaceDefinition,
    tab: WorkspaceTab,
  ): void {
    const tabs = getWorkspaceTabs(workspace);
    const currentIndex = tabs.indexOf(tab);
    for (const adjacentTab of [
      tabs[currentIndex - 1],
      tabs[currentIndex + 1],
    ]) {
      if (adjacentTab === "git" || adjacentTab === "files") {
        onPrefetchWorkspaceTab(workspace, adjacentTab);
      }
    }
  }

  function switchWorkspaceTab(
    workspace: WorkspaceDefinition,
    tab: WorkspaceTab,
  ): void {
    if (!getWorkspaceTabs(workspace).includes(tab)) {
      return;
    }
    setSelectedWorkspace(workspace);
    setActiveWorkspaceTab(tab);
    if (tab === "files") {
      onOpenWorkspaceFiles(workspace);
    }
    if (tab === "git" && workspace.isGitRepository) {
      onOpenWorkspaceGit(workspace);
    }
    prefetchAdjacentWorkspaceTabs(workspace, tab);
  }

  function openWorkspaceTab(
    workspace: WorkspaceDefinition,
    tab: WorkspaceTab,
  ): void {
    switchWorkspaceTab(workspace, tab);
  }

  function renderSessionRow(session: TerminalSession): JSX.Element {
    const closing = closingSessionIds.includes(session.session_id);
    const killing = killingSessionIds.includes(session.session_id);
    const external = session.origin === "external";
    const capabilities = getSessionCapabilities(session, {
      closing,
      killing,
    });
    const statusColors = getStatusColors(capabilities.statusTone);

    return (
      <Pressable
        key={session.session_id}
        disabled={!capabilities.canOpen}
        style={[styles.sessionRow, !capabilities.canOpen && styles.disabled]}
        onPress={() => onOpenSession(session)}
      >
        <View
          style={[styles.sessionDot, { backgroundColor: statusColors.color }]}
        />
        <View style={styles.sessionRowContent}>
          <Text numberOfLines={1} style={styles.sessionRowTitle}>
            {session.title}
          </Text>
          <Text numberOfLines={1} style={styles.sessionRowMeta}>
            {formatRelativeTime(session.last_active_at, t)}
            {external ? " · ext" : ""}
          </Text>
        </View>
        <Pressable
          accessibilityLabel={t("workspaces.actions.manageSession", {
            title: session.title,
          })}
          hitSlop={8}
          style={styles.sessionRowMore}
          onPress={() => setManagingSession(session)}
        >
          <Text style={styles.sessionRowMoreText}>···</Text>
        </Pressable>
      </Pressable>
    );
  }

  const workspaceGroups = useMemo(
    () => groupSessionsByWorkspace(sessions, workspaces),
    [sessions, workspaces],
  );
  const realWorkspaceGroups = workspaceGroups.filter(
    (group) => group.workspace.path !== UNASSIGNED_WORKSPACE_PATH,
  );
  const unassignedSessions =
    workspaceGroups.find(
      (group) => group.workspace.path === UNASSIGNED_WORKSPACE_PATH,
    )?.sessions ?? [];
  const activeWorkspace = selectedWorkspace
    ? (workspaces.find(
        (workspace) => workspace.path === selectedWorkspace.path,
      ) ?? selectedWorkspace)
    : null;
  const activeWorkspaceSessions = activeWorkspace
    ? sessions.filter(
        (session) =>
          findSessionWorkspace(session, workspaces).path ===
          activeWorkspace.path,
      )
    : [];
  const activeProviderGroups = activeWorkspace
    ? groupSessionsByProvider(activeWorkspaceSessions, providerGroups, providers)
    : [];
  const workspaceTabs = activeWorkspace ? getWorkspaceTabs(activeWorkspace) : [];
  const activeWorkspaceTabIndex = Math.max(
    0,
    workspaceTabs.indexOf(activeWorkspaceTab),
  );
  const effectiveWorkspacePagerWidth =
    Platform.OS === "web"
      ? workspacePagerWidth || Math.max(0, windowWidth - spacing.xl * 2)
      : workspacePagerWidth;
  useEffect(() => {
    if (!activeWorkspace || effectiveWorkspacePagerWidth <= 0) {
      return;
    }
    workspacePagerRef.current?.scrollTo({
      x: activeWorkspaceTabIndex * effectiveWorkspacePagerWidth,
      animated: false,
    });
  }, [activeWorkspace, activeWorkspaceTabIndex, effectiveWorkspacePagerWidth]);

  function handleWorkspacePagerLayout(event: LayoutChangeEvent): void {
    const nextWidth = event.nativeEvent.layout.width;
    if (nextWidth > 0 && nextWidth !== workspacePagerWidth) {
      setWorkspacePagerWidth(nextWidth);
    }
  }

  function handleWorkspacePagerScrollEnd(
    event: NativeSyntheticEvent<NativeScrollEvent>,
  ): void {
    if (Platform.OS === "web") {
      return;
    }
    if (!activeWorkspace || effectiveWorkspacePagerWidth <= 0) {
      return;
    }
    const nextIndex = Math.round(
      event.nativeEvent.contentOffset.x / effectiveWorkspacePagerWidth,
    );
    const nextTab = workspaceTabs[nextIndex];
    if (nextTab && nextTab !== activeWorkspaceTab) {
      switchWorkspaceTab(activeWorkspace, nextTab);
    }
  }

  function workspaceTabPaneStyle(tab: WorkspaceTab) {
    return [
      styles.workspaceTabPane,
      { width: effectiveWorkspacePagerWidth },
      Platform.OS === "web" && activeWorkspaceTab !== tab
        ? styles.webHiddenWorkspaceTabPane
        : null,
    ];
  }

  return (
    <View style={styles.screen}>
      <View style={styles.actions}>
        <Button
          accessibilityLabel={
            activeWorkspace
              ? t("workspaces.backToWorkspaces")
              : t("workspaces.backToDevices")
          }
          icon="arrowLeft"
          iconOnly
          style={styles.backButton}
          onPress={activeWorkspace ? () => setSelectedWorkspace(null) : onBack}
        >
          {t("common.back")}
        </Button>
        <View style={styles.toolbarTitleArea}>
          <Text style={styles.toolbarTitle}>
            {activeWorkspace
              ? getWorkspaceDisplayName(activeWorkspace)
              : t("workspaces.title")}
          </Text>
          <Text numberOfLines={1} style={styles.toolbarMeta}>
            {activeWorkspace
              ? activeWorkspace.path
              : t("workspaces.meta", {
                  workspaceCount: realWorkspaceGroups.length,
                  sessionCount: sessions.length,
                })}
          </Text>
        </View>
        {!activeWorkspace ? (
          <>
            <Button
              accessibilityLabel={t("workspaces.refreshSessions")}
              icon="refresh"
              iconOnly
              style={styles.toolbarIconButton}
              onPress={onRefreshSessions}
            >
              {t("common.refresh")}
            </Button>
            <Button
              accessibilityLabel={t("workspaces.manageProviders")}
              icon="provider"
              iconOnly
              style={styles.toolbarIconButton}
              onPress={() => setProvidersModalVisible(true)}
            >
              {t("workspaces.manageProviders")}
            </Button>
          </>
        ) : null}
      </View>

      {activeWorkspace ? (
        <ScrollView
          ref={workspacePagerRef}
          directionalLockEnabled
          horizontal
          pagingEnabled
          scrollEventThrottle={16}
          scrollEnabled={effectiveWorkspacePagerWidth > 0}
          showsHorizontalScrollIndicator={false}
          style={styles.workspacePager}
          onLayout={handleWorkspacePagerLayout}
          onMomentumScrollEnd={handleWorkspacePagerScrollEnd}
          onScrollEndDrag={handleWorkspacePagerScrollEnd}
        >
          <ScrollView
            alwaysBounceVertical
            directionalLockEnabled
            contentContainerStyle={styles.workspaceTabScrollContent}
            refreshControl={
              Platform.OS !== "web" ? (
                <RefreshControl
                  refreshing={sessionRefreshing}
                  tintColor={colors.success}
                  onRefresh={handleRefreshSessionTab}
                />
              ) : undefined
            }
            style={workspaceTabPaneStyle("sessions")}
          >
            <View style={styles.providerSection}>
              {activeProviderGroups.length === 0 ? (
                <View style={styles.sessionsEmptyState}>
                  <Text style={styles.empty}>
                    {t("workspaces.noSessions")}
                  </Text>
                  <Button
                    disabled={
                      creating ||
                      !isCreatableTerminalProviderKind(
                        preferredCreateTerminalProviderKind,
                        enabledProviders,
                      )
                    }
                    icon="add"
                    style={styles.emptyCreateButton}
                    tone="primary"
                    onPress={() =>
                      openCreateModal(
                        preferredCreateTerminalProviderKind,
                        activeWorkspace,
                      )
                    }
                  >
                    {t("workspaces.newSession")}
                  </Button>
                </View>
              ) : (
                <View style={styles.sessionsList}>
                  {activeProviderGroups.map((group) => (
                    <View key={group.kind} style={styles.sessionGroup}>
                      <View style={styles.sessionGroupHeader}>
                        <Text style={styles.sessionGroupLabel}>
                          {group.label} · {group.sessions.length}
                        </Text>
                        <Button
                          accessibilityLabel={t(
                            "workspaces.newProviderSession",
                            { provider: group.label },
                          )}
                          disabled={creating || !group.creatable}
                          icon="add"
                          iconOnly
                          style={styles.sessionGroupAdd}
                          onPress={() =>
                            openCreateModal(
                              group.kind as CreatableTerminalProviderKind,
                              activeWorkspace,
                            )
                          }
                        >
                          {t("workspaces.add")}
                        </Button>
                      </View>
                      {group.sessions.map((session) =>
                        renderSessionRow(session),
                      )}
                    </View>
                  ))}
                </View>
              )}
            </View>
          </ScrollView>

          {activeWorkspace.isGitRepository ? (
            <ScrollView
              alwaysBounceVertical
              directionalLockEnabled
              contentContainerStyle={styles.workspaceTabScrollContent}
              refreshControl={
                Platform.OS !== "web" ? (
                  <RefreshControl
                    refreshing={Boolean(gitLoading)}
                    tintColor={colors.success}
                    onRefresh={() => onRefreshWorkspaceGit(activeWorkspace)}
                  />
                ) : undefined
              }
              style={workspaceTabPaneStyle("git")}
            >
              <GitStatusScreen
                embedded
                workspace={activeWorkspace}
                status={gitStatus}
                diff={gitDiff}
                diffCache={gitDiffCache}
                fileContentCache={gitFileContentCache}
                fileContentLoadingKeys={gitFileContentLoadingKeys}
                loading={gitLoading}
                onRefresh={() => onRefreshWorkspaceGit(activeWorkspace)}
                onOpenDiff={onOpenGitDiff}
                onOpenReview={(relativePath, scope) =>
                  onOpenGitReview(activeWorkspace, relativePath, scope)
                }
                onPrefetchDiff={onPrefetchGitDiff}
                onReadFileContent={onReadGitFileContent}
                onEditFile={(relativePath) =>
                  onEditFile(activeWorkspace, relativePath)
                }
              />
            </ScrollView>
          ) : null}

          <ScrollView
            alwaysBounceVertical
            directionalLockEnabled
            contentContainerStyle={styles.workspaceTabScrollContent}
            refreshControl={
              Platform.OS !== "web" ? (
                <RefreshControl
                  refreshing={Boolean(filesLoading)}
                  tintColor={colors.success}
                  onRefresh={() =>
                    onRefreshWorkspaceFiles(activeWorkspace, fileRelativePath)
                  }
                />
              ) : undefined
            }
            style={workspaceTabPaneStyle("files")}
          >
            <FileBrowserScreen
              embedded
              workspace={activeWorkspace}
              relativePath={fileRelativePath}
              entries={fileEntries}
              selectedFilePath={selectedFilePath}
              file={selectedFile}
              loading={filesLoading}
              onRefresh={() =>
                onRefreshWorkspaceFiles(activeWorkspace, fileRelativePath)
              }
              onOpenDirectory={onOpenDirectory}
              onReadFile={onReadFile}
              onEditFile={(relativePath) =>
                onEditFile(activeWorkspace, relativePath)
              }
              onCloseFilePreview={onCloseFilePreview}
            />
          </ScrollView>
        </ScrollView>
      ) : (
        <ScrollView
          alwaysBounceVertical
          contentContainerStyle={[styles.list, styles.listStretch]}
          refreshControl={
            Platform.OS !== "web" ? (
              <RefreshControl
                refreshing={sessionRefreshing}
                tintColor={colors.success}
                onRefresh={handleRefreshSessionTab}
              />
            ) : undefined
          }
        >
          <>
            {realWorkspaceGroups.length === 0 ? (
              <Text style={styles.empty}>
                {t("workspaces.empty")}
              </Text>
            ) : (
              <View style={styles.workspaceList}>
                {realWorkspaceGroups.map(
                  ({ workspace, sessions: workspaceSessions }) => (
                    <Pressable
                      key={workspace.path}
                      style={styles.workspaceRow}
                      onPress={() => openWorkspace(workspace)}
                    >
                      <View style={styles.workspaceRowIcon}>
                        <Text style={styles.workspaceRowIconText}>
                          {getWorkspaceDisplayName(workspace)
                            .charAt(0)
                            .toUpperCase()}
                        </Text>
                      </View>
                      <View style={styles.workspaceRowContent}>
                        <View style={styles.workspaceRowTitleLine}>
                          <Text
                            numberOfLines={1}
                            style={styles.workspaceRowName}
                          >
                            {getWorkspaceDisplayName(workspace)}
                          </Text>
                          {workspace.isGitRepository ? (
                            <View style={styles.gitDot} />
                          ) : null}
                        </View>
                        <Text
                          ellipsizeMode="middle"
                          numberOfLines={1}
                          style={styles.workspaceRowPath}
                        >
                          {workspace.path}
                        </Text>
                      </View>
                      <Text style={styles.workspaceRowMeta}>
                        {workspaceSessions.length > 0
                          ? `${workspaceSessions.length}`
                          : ""}
                      </Text>
                    </Pressable>
                  ),
                )}
              </View>
            )}

            {unassignedSessions.length > 0 ? (
              <View style={styles.providerSection}>
                <Text style={styles.sessionGroupLabel}>
                  {t("workspaces.unassigned")}
                </Text>
                <View style={styles.sessionGroup}>
                  {unassignedSessions.map((session) =>
                    renderSessionRow(session),
                  )}
                </View>
              </View>
            ) : null}
          </>
        </ScrollView>
      )}

      {activeWorkspace ? (
        <View style={styles.workspaceTabBar}>
          <Button
            icon="terminal"
            style={[
              styles.workspaceTabButton,
              activeWorkspaceTab === "sessions" &&
                styles.workspaceTabButtonActive,
            ]}
            onPress={() => openWorkspaceTab(activeWorkspace, "sessions")}
          >
            {t("workspaces.tabs.sessions")}
          </Button>
          {activeWorkspace.isGitRepository ? (
            <Button
              icon="git"
              style={[
                styles.workspaceTabButton,
                activeWorkspaceTab === "git" && styles.workspaceTabButtonActive,
              ]}
              onPress={() => openWorkspaceTab(activeWorkspace, "git")}
            >
              {t("workspaces.tabs.git")}
            </Button>
          ) : null}
          <Button
            icon="folder"
            style={[
              styles.workspaceTabButton,
              activeWorkspaceTab === "files" && styles.workspaceTabButtonActive,
            ]}
            onPress={() => openWorkspaceTab(activeWorkspace, "files")}
          >
            {t("workspaces.tabs.files")}
          </Button>
        </View>
      ) : null}

      {!activeWorkspace ? (
        <Button
          accessibilityLabel={t("workspaces.newWorkspace")}
          icon="add"
          iconOnly
          style={styles.floatingCreateButton}
          tone="primary"
          onPress={() => {
            setCreateWorkspaceLocked(false);
            setCreateWorkspacePath(undefined);
            setCreateCwd("");
            setCreateTerminalProviderKind(preferredCreateTerminalProviderKind);
            setCreateModalVisible(true);
          }}
        >
          {t("workspaces.newWorkspace")}
        </Button>
      ) : null}

      <Modal
        transparent
        animationType="fade"
        visible={createModalVisible}
        onRequestClose={() => setCreateModalVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.modalAvoidingView}
        >
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => {
              Keyboard.dismiss();
              setCreateModalVisible(false);
            }}
          >
            <Pressable onPress={() => {}}>
              <Card style={styles.modalCard}>
                <Text style={styles.modalTitle}>
                  {createWorkspaceLocked
                    ? t("workspaces.newSession")
                    : t("workspaces.newWorkspace")}
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.workspacePicker}
                >
                  {creatableProviders.map((provider) => {
                    const selected = provider.kind === createTerminalProviderKind;
                    return (
                      <Pressable
                        accessibilityRole="button"
                        key={provider.kind}
                        style={[
                          styles.workspaceChip,
                          selected && styles.workspaceChipSelected,
                        ]}
                        onPress={() => setCreateTerminalProviderKind(provider.kind)}
                      >
                        <Text
                          numberOfLines={1}
                          style={[
                            styles.workspaceChipText,
                            selected && styles.workspaceChipTextSelected,
                          ]}
                        >
                          {provider.displayName}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
                {!createWorkspaceLocked && workspaces.length > 0 ? (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.workspacePicker}
                  >
                    {workspaces.map((workspace) => {
                      const selected = workspace.path === createWorkspacePath;
                      return (
                        <Pressable
                          accessibilityRole="button"
                          key={workspace.path}
                          style={[
                            styles.workspaceChip,
                            selected && styles.workspaceChipSelected,
                          ]}
                          onPress={() => {
                            setCreateWorkspacePath(workspace.path);
                            setCreateCwd(workspace.path);
                          }}
                        >
                          <Text
                            numberOfLines={1}
                            style={[
                              styles.workspaceChipText,
                              selected && styles.workspaceChipTextSelected,
                            ]}
                          >
                            {getWorkspaceDisplayName(workspace)}
                          </Text>
                          {workspace.isGitRepository ? (
                            <Text style={styles.workspaceChipMeta}>Git</Text>
                          ) : null}
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                ) : null}
                {!createWorkspaceLocked ? (
                  <TextInput
                    value={createCwd}
                    onChangeText={(value) => {
                      setCreateWorkspacePath(undefined);
                      setCreateCwd(value);
                    }}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder={t("workspaces.modal.workingDirectory")}
                    placeholderTextColor="#66727c"
                    style={styles.cwdInput}
                  />
                ) : null}
                <View style={styles.modalActions}>
                  <Button
                    icon="close"
                    style={styles.modalSecondaryButton}
                    onPress={() => setCreateModalVisible(false)}
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button
                    disabled={!createCwd.trim() || creating}
                    icon={creating ? "refresh" : "add"}
                    style={styles.modalPrimaryButton}
                    tone="primary"
                    onPress={confirmCreateSession}
                  >
                    {creating ? t("common.starting") : t("common.create")}
                  </Button>
                </View>
              </Card>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        transparent
        animationType="fade"
        visible={Boolean(renamingSession)}
        onRequestClose={() => setRenamingSession(null)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.modalAvoidingView}
        >
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => {
              Keyboard.dismiss();
              setRenamingSession(null);
            }}
          >
            <Pressable onPress={() => {}}>
              <Card style={styles.modalCard}>
                <Text style={styles.modalTitle}>
                  {t("workspaces.modal.renameSession")}
                </Text>
                <TextInput
                  value={renameTitle}
                  onChangeText={setRenameTitle}
                  autoCapitalize="sentences"
                  autoCorrect
                  maxLength={80}
                  placeholder={t("workspaces.modal.sessionTitle")}
                  placeholderTextColor="#66727c"
                  style={styles.cwdInput}
                />
                <View style={styles.modalActions}>
                  <Button
                    icon="close"
                    style={styles.modalSecondaryButton}
                    onPress={() => setRenamingSession(null)}
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button
                    disabled={!renameTitle.trim()}
                    icon="save"
                    style={styles.modalPrimaryButton}
                    tone="primary"
                    onPress={confirmRenameSession}
                  >
                    {t("common.save")}
                  </Button>
                </View>
              </Card>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        transparent
        animationType="fade"
        visible={Boolean(managingSession)}
        onRequestClose={() => setManagingSession(null)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setManagingSession(null)}
        >
          <Pressable onPress={() => {}}>
            <Card style={styles.modalCard}>
              {managingSession ? (
                <>
                  {(() => {
                    const session = managingSession;
                    const external = session.origin === "external";
                    const registered = session.registered !== false;
                    const closing = closingSessionIds.includes(
                      session.session_id,
                    );
                    const killing = killingSessionIds.includes(
                      session.session_id,
                    );
                    const capabilities = getSessionCapabilities(session, {
                      closing,
                      killing,
                    });
                    const statusColors = getStatusColors(
                      capabilities.statusTone,
                    );
                    return (
                      <>
                        <View style={styles.manageHeader}>
                          <Text numberOfLines={2} style={styles.modalTitle}>
                            {session.title}
                          </Text>
                          <Badge
                            backgroundColor={statusColors.backgroundColor}
                            color={statusColors.color}
                            style={styles.statusBadge}
                          >
                            {capabilities.statusLabel}
                          </Badge>
                        </View>
                        <View style={styles.manageDetails}>
                          <DetailRow
                            label={t("workspaces.details.folder")}
                            value={formatCompactPath(session.cwd)}
                          />
                          <DetailRow
                            label={t("workspaces.details.created")}
                            value={formatAbsoluteTime(session.created_at)}
                          />
                        </View>
                        {capabilities.unavailableReason ? (
                          <Text style={styles.unavailableReason}>
                            {capabilities.unavailableReason}
                          </Text>
                        ) : null}
                        <View style={styles.manageActions}>
                          <Button
                            icon="edit"
                            style={styles.manageActionButton}
                            onPress={() => {
                              setManagingSession(null);
                              openRenameModal(session);
                            }}
                          >
                            {t("workspaces.actions.rename")}
                          </Button>
                        </View>
                        <View style={styles.manageDangerRow}>
                          {registered ? (
                            <Button
                              disabled={!capabilities.canClose}
                              icon={external ? "eyeOff" : "close"}
                              style={styles.manageDangerButton}
                              tone="danger"
                              onPress={() => {
                                setManagingSession(null);
                                onCloseSession(session);
                              }}
                            >
                              {closing
                                ? t("workspaces.actions.closing")
                                : external
                                  ? t("workspaces.actions.forget")
                                  : getCloseActionLabel(session, t)}
                            </Button>
                          ) : null}
                          <Button
                            disabled={!capabilities.canKill}
                            icon="trash"
                            style={styles.manageDangerButton}
                            tone="danger"
                            onPress={() => {
                              setManagingSession(null);
                              onKillTerminalSession(session);
                            }}
                          >
                            {killing
                              ? t("workspaces.actions.killing")
                              : t("workspaces.actions.killTerminal")}
                          </Button>
                        </View>
                      </>
                    );
                  })()}
                </>
              ) : null}
            </Card>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        transparent
        animationType="fade"
        visible={providersModalVisible}
        onRequestClose={() => setProvidersModalVisible(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setProvidersModalVisible(false)}
        >
          <Pressable onPress={() => {}}>
            <Card style={styles.modalCard}>
              <Text style={styles.modalTitle}>
                {t("workspaces.modal.providerPreferences")}
              </Text>
              <ScrollView contentContainerStyle={styles.providerStack}>
                {orderedProviders.map((provider, index) => {
                  const hidden = providerPreferences.hiddenKinds.includes(
                    provider.kind,
                  );
                  const isDefault = provider.kind === effectiveDefaultProviderKind;
                  return (
                    <View
                      key={provider.kind}
                      style={[
                        styles.providerRow,
                        hidden && styles.providerRowHidden,
                      ]}
                    >
                      <View style={styles.providerInfo}>
                        <View style={styles.providerTitleRow}>
                          <Text style={styles.providerTitle}>
                            {provider.displayName}
                          </Text>
                          {isDefault ? (
                            <Badge
                              backgroundColor={colors.successSoft}
                              color={colors.success}
                              style={styles.defaultBadge}
                            >
                              {t("common.default")}
                            </Badge>
                          ) : null}
                          {hidden ? (
                            <Badge
                              backgroundColor={colors.neutralSoft}
                              color={colors.textMuted}
                              style={styles.defaultBadge}
                            >
                              {t("common.hidden")}
                            </Badge>
                          ) : null}
                        </View>
                        <Text numberOfLines={1} style={styles.providerSummary}>
                          {provider.summary}
                        </Text>
                      </View>
                      <View style={styles.providerActions}>
                        <Button
                          accessibilityLabel={t("workspaces.actions.moveUp", {
                            provider: provider.displayName,
                          })}
                          disabled={index === 0}
                          icon="chevronUp"
                          iconOnly
                          style={styles.providerActionButton}
                          onPress={() => moveProvider(provider.kind, -1)}
                        >
                          {t("common.up")}
                        </Button>
                        <Button
                          accessibilityLabel={t("workspaces.actions.moveDown", {
                            provider: provider.displayName,
                          })}
                          disabled={index === orderedProviders.length - 1}
                          icon="chevronDown"
                          iconOnly
                          style={styles.providerActionButton}
                          onPress={() => moveProvider(provider.kind, 1)}
                        >
                          {t("common.down")}
                        </Button>
                        <Button
                          icon={hidden ? "eye" : "eyeOff"}
                          iconOnly
                          style={styles.providerActionButton}
                          onPress={() => toggleProviderHidden(provider.kind)}
                        >
                          {hidden ? t("common.show") : t("common.hide")}
                        </Button>
                        <Button
                          disabled={hidden || isDefault || !provider.creatable}
                          icon="check"
                          iconOnly
                          style={[
                            styles.providerActionButton,
                            isDefault && styles.providerDefaultActive,
                          ]}
                          tone={isDefault ? "primary" : "secondary"}
                          onPress={() => setDefaultProvider(provider.kind)}
                        >
                          {t("common.default")}
                        </Button>
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
              <View style={styles.modalActions}>
                <Button
                  icon="refresh"
                  style={styles.modalSecondaryButton}
                  onPress={resetProviderPreferences}
                >
                  {t("common.reset")}
                </Button>
                <Button
                  icon="check"
                  style={styles.modalPrimaryButton}
                  tone="primary"
                  onPress={() => setProvidersModalVisible(false)}
                >
                  {t("common.done")}
                </Button>
              </View>
            </Card>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );

  function toggleProviderHidden(kind: TerminalProviderKind): void {
    setProviderPreferences((current) => {
      const hiddenKinds = current.hiddenKinds.includes(kind)
        ? current.hiddenKinds.filter((item) => item !== kind)
        : [...current.hiddenKinds, kind];
      const defaultKind =
        current.defaultKind === kind ? undefined : current.defaultKind;
      return normalizeProviderPreferences(
        {
          ...current,
          hiddenKinds,
          defaultKind,
        },
        providers,
      );
    });
  }

  function moveProvider(kind: TerminalProviderKind, direction: -1 | 1): void {
    setProviderPreferences((current) => {
      const orderedKinds = orderProviders(providers, current.orderedKinds).map(
        (provider) => provider.kind,
      );
      const index = orderedKinds.indexOf(kind);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= orderedKinds.length) {
        return current;
      }

      const nextOrderedKinds = [...orderedKinds];
      const [item] = nextOrderedKinds.splice(index, 1);
      nextOrderedKinds.splice(nextIndex, 0, item);
      return normalizeProviderPreferences(
        { ...current, orderedKinds: nextOrderedKinds },
        providers,
      );
    });
  }

  function setDefaultProvider(kind: TerminalProviderKind): void {
    setProviderPreferences((current) =>
      normalizeProviderPreferences(
        {
          ...current,
          defaultKind: kind,
        },
        providers,
      ),
    );
  }

  function resetProviderPreferences(): void {
    setProviderPreferences(EMPTY_PROVIDER_PREFERENCES);
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.xl,
  },
  toolbarTitleArea: {
    flex: 1,
    justifyContent: "center",
  },
  backButton: {
    minHeight: 40,
    width: 40,
    paddingHorizontal: 0,
    borderRadius: 20,
  },
  toolbarIconButton: {
    minHeight: 40,
    width: 44,
    paddingHorizontal: 0,
    borderRadius: radii.md,
  },
  toolbarTitle: {
    color: colors.textPrimary,
    fontSize: 22,
    fontWeight: "800",
  },
  toolbarMeta: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  secondaryButton: {
    minHeight: 38,
    minWidth: 86,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    borderColor: "#34424c",
    borderWidth: 1,
  },
  primaryText: {
    color: colors.successText,
    ...typography.action,
  },
  secondaryText: {
    color: colors.textSecondary,
    fontWeight: "700",
  },
  disabled: {
    opacity: 0.55,
  },
  list: {
    gap: spacing.xl,
    paddingBottom: 84,
  },
  listStretch: {
    flexGrow: 1,
  },
  providerSection: {
    gap: spacing.md,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  sectionTitleArea: {
    flex: 1,
    minWidth: 0,
  },
  sectionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: "800",
  },
  sectionMeta: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: "800",
  },
  defaultBadge: {
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  sectionDescription: {
    color: colors.textDim,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 4,
    maxWidth: 420,
  },
  sectionCreateButton: {
    minHeight: 40,
    width: 40,
    paddingHorizontal: 0,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.success,
  },
  workspaceList: {
    gap: spacing.md,
  },
  workspaceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    borderColor: colors.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
  workspaceRowIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.successSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  workspaceRowIconText: {
    color: colors.success,
    fontSize: 15,
    fontWeight: "800",
  },
  workspaceRowContent: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  workspaceRowTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  workspaceRowName: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: "700",
    flexShrink: 1,
  },
  gitDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.success,
  },
  workspaceRowPath: {
    color: colors.textMuted,
    fontSize: 12,
  },
  workspaceRowMeta: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: "700",
    minWidth: 20,
    textAlign: "right",
  },
  workspaceDetail: {
    gap: spacing.lg,
  },
  workspacePager: {
    width: "100%",
  },
  workspaceTabPane: {
    gap: spacing.lg,
  },
  webHiddenWorkspaceTabPane: {
    display: "none",
  },
  workspaceTabScrollContent: {
    gap: spacing.lg,
    paddingBottom: 84,
  },
  workspaceHeroTitle: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: 20,
    fontWeight: "800",
  },
  workspaceHeroActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  workspaceHeroActionButton: {
    minHeight: 40,
    minWidth: 108,
  },
  providerSessionGroup: {
    gap: spacing.md,
  },
  sessionsEmptyState: {
    alignItems: "center",
    gap: spacing.lg,
    paddingVertical: spacing.xl,
  },
  emptyCreateButton: {
    minHeight: 40,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.xl,
  },
  sessionsList: {
    gap: spacing.lg,
  },
  sessionGroup: {
    borderColor: colors.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    overflow: "hidden",
    backgroundColor: colors.surface,
  },
  sessionGroupHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    backgroundColor: colors.surfaceRaised,
  },
  sessionGroupLabel: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  sessionGroupAdd: {
    width: 28,
    height: 28,
    minHeight: 28,
    paddingHorizontal: 0,
    borderRadius: 14,
  },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    borderTopColor: colors.borderSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sessionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  sessionRowContent: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  sessionRowTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: "700",
  },
  sessionRowMeta: {
    color: colors.textMuted,
    fontSize: 12,
  },
  sessionRowMore: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
  },
  sessionRowMoreText: {
    color: colors.textDim,
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 1,
  },
  sectionActionButton: {
    minHeight: 40,
    minWidth: 126,
    borderRadius: radii.pill,
  },
  workspaceTabBar: {
    alignSelf: "center",
    flexDirection: "row",
    gap: 4,
    marginBottom: spacing.sm,
    borderColor: colors.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.pill,
    padding: 3,
    backgroundColor: "rgba(17, 24, 29, 0.82)",
  },
  workspaceTabButton: {
    minHeight: 36,
    minWidth: 82,
    borderRadius: radii.pill,
    paddingHorizontal: 10,
    backgroundColor: "transparent",
  },
  workspaceTabButtonActive: {
    borderColor: colors.success,
    backgroundColor: "rgba(32, 211, 145, 0.14)",
  },
  empty: {
    color: colors.textMuted,
    borderColor: colors.borderSubtle,
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: 13,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  unavailableReason: {
    color: colors.warning,
    fontSize: 12,
    lineHeight: 17,
    marginTop: spacing.sm,
  },
  closeText: {
    color: colors.danger,
    fontWeight: "800",
  },
  killSessionText: {
    color: colors.danger,
    fontWeight: "800",
  },
  attachHint: {
    color: colors.success,
    fontWeight: "800",
  },
  manageHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
  },
  manageDetails: {
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  detailRow: {
    gap: 3,
  },
  detailLabel: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
  },
  detailValue: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  manageActions: {
    gap: spacing.sm,
  },
  manageActionButton: {
    minHeight: 40,
  },
  manageDangerRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  manageDangerButton: {
    flex: 1,
    minHeight: 38,
  },
  floatingCreateButton: {
    position: "absolute",
    right: spacing.xl,
    bottom: spacing.xl,
    width: 52,
    height: 52,
    minHeight: 52,
    paddingHorizontal: 0,
    borderRadius: 26,
    shadowColor: colors.success,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.28,
    shadowRadius: 18,
  },
  modalAvoidingView: {
    flex: 1,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: "center",
    padding: 22,
    backgroundColor: "rgba(0, 0, 0, 0.58)",
  },
  modalCard: {
    padding: spacing.xl,
    gap: spacing.md,
  },
  modalTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: "800",
  },
  modalDescription: {
    color: colors.textMuted,
    fontSize: 13,
  },
  cwdInput: {
    minHeight: 48,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    color: colors.textPrimary,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.background,
  },
  workspacePicker: {
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  workspaceChip: {
    minWidth: 104,
    maxWidth: 156,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: colors.surfaceRaised,
  },
  workspaceChipSelected: {
    borderColor: colors.success,
    backgroundColor: colors.successSoft,
  },
  workspaceChipText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "800",
    textAlign: "center",
  },
  workspaceChipTextSelected: {
    color: colors.success,
  },
  workspaceChipMeta: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "800",
    marginTop: 2,
  },
  modalActions: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: spacing.xs,
  },
  modalSecondaryButton: {
    flex: 1,
    minHeight: 44,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  modalPrimaryButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.success,
  },
  providerStack: {
    gap: spacing.md,
    maxHeight: 420,
  },
  providerRow: {
    borderColor: colors.borderSubtle,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.lg,
    gap: spacing.md,
  },
  providerRowHidden: {
    opacity: 0.62,
  },
  providerInfo: {
    gap: spacing.xs,
  },
  providerTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  providerTitle: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: "800",
  },
  providerSummary: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  providerActions: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  providerActionButton: {
    minHeight: 36,
    width: 36,
    paddingHorizontal: 0,
    borderRadius: radii.pill,
  },
  providerDefaultActive: {
    backgroundColor: colors.successSoft,
  },
});

function DetailRow({
  label,
  value,
}: {
  label: string;
  value?: string;
}): JSX.Element | null {
  if (!value) {
    return null;
  }

  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text ellipsizeMode="middle" numberOfLines={1} style={styles.detailValue}>
        {value}
      </Text>
    </View>
  );
}

function getProviderPreferencesStorageKey(scope: string): string {
  return `${PROVIDER_PREFERENCES_STORAGE_PREFIX}.${scope || "default"}`;
}

function parseProviderPreferences(value: string | null): ProviderPreferences {
  if (!value) {
    return EMPTY_PROVIDER_PREFERENCES;
  }

  try {
    const parsed = JSON.parse(value) as Partial<ProviderPreferences>;
    return {
      hiddenKinds: Array.isArray(parsed.hiddenKinds)
        ? parsed.hiddenKinds.filter(isNonEmptyString)
        : [],
      orderedKinds: Array.isArray(parsed.orderedKinds)
        ? parsed.orderedKinds.filter(isNonEmptyString)
        : [],
      defaultKind: isNonEmptyString(parsed.defaultKind)
        ? parsed.defaultKind
        : undefined,
    };
  } catch {
    return EMPTY_PROVIDER_PREFERENCES;
  }
}

function normalizeProviderPreferences(
  preferences: ProviderPreferences,
  providers: readonly TerminalProviderDefinition[],
): ProviderPreferences {
  const providerKinds = new Set(providers.map((provider) => provider.kind));
  const hiddenKinds = preferences.hiddenKinds.filter((kind) =>
    providerKinds.has(kind),
  );
  const orderedKinds = preferences.orderedKinds.filter((kind) =>
    providerKinds.has(kind),
  );
  const defaultKind =
    preferences.defaultKind &&
    providerKinds.has(preferences.defaultKind) &&
    !hiddenKinds.includes(preferences.defaultKind)
      ? preferences.defaultKind
      : undefined;

  return {
    hiddenKinds,
    orderedKinds,
    defaultKind,
  };
}

function orderProviders(
  providers: readonly TerminalProviderDefinition[],
  orderedKinds: readonly string[],
): TerminalProviderDefinition[] {
  const priority = new Map(
    orderedKinds.map((kind, index) => [kind, index] as const),
  );

  return [...providers].sort((left, right) => {
    const leftPriority = priority.get(left.kind) ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = priority.get(right.kind) ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return providers.indexOf(left) - providers.indexOf(right);
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function formatRelativeTime(
  value: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return t("common.unknown");
  }

  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) {
    return t("workspaces.time.justNow");
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return t("workspaces.time.minutesAgo", { count: diffMinutes });
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return t("workspaces.time.hoursAgo", { count: diffHours });
  }

  const diffDays = Math.floor(diffHours / 24);
  return t("workspaces.time.daysAgo", { count: diffDays });
}

function formatAbsoluteTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return i18n.t("common.unknown");
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function formatCompactPath(path: string): string {
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return "";
  }

  const normalizedPath = trimmedPath.replace(/\/+$/g, "") || "/";
  const parts = normalizedPath.split("/").filter(Boolean);
  if (parts.length <= 2) {
    return normalizedPath;
  }

  const prefix = normalizedPath.startsWith("/") ? `/${parts[0]}` : parts[0];
  return `${prefix}/.../${parts[parts.length - 1]}`;
}

function getProviderGroupKind(
  session: TerminalSession,
  providers: readonly TerminalProviderDefinition[],
): TerminalProviderKind {
  return getTerminalProviderDefinition(session.terminal_provider_kind, providers)
    ? session.terminal_provider_kind
    : "other";
}

function groupSessionsByWorkspace(
  sessions: readonly TerminalSession[],
  workspaces: readonly WorkspaceDefinition[],
): Array<{ workspace: WorkspaceDefinition; sessions: TerminalSession[] }> {
  const groups = new Map<
    string,
    { workspace: WorkspaceDefinition; sessions: TerminalSession[] }
  >();
  for (const session of sessions) {
    const workspace = findSessionWorkspace(session, workspaces);
    const existing = groups.get(workspace.path);
    if (existing) {
      existing.sessions.push(session);
    } else {
      groups.set(workspace.path, { workspace, sessions: [session] });
    }
  }
  return Array.from(groups.values()).sort((left, right) =>
    getWorkspaceDisplayName(left.workspace).localeCompare(
      getWorkspaceDisplayName(right.workspace),
    ),
  );
}

function groupSessionsByProvider(
  sessions: readonly TerminalSession[],
  providerGroups: readonly TerminalProviderGroup[],
  providers: readonly TerminalProviderDefinition[],
): Array<TerminalProviderGroup & { sessions: TerminalSession[] }> {
  return providerGroups
    .filter((group) => !group.hidden)
    .map((group) => ({
      ...group,
      sessions: sessions.filter(
        (session) => getProviderGroupKind(session, providers) === group.kind,
      ),
    }))
    .filter((group) => group.sessions.length > 0);
}

function findSessionWorkspace(
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
  return {
    name: session.workspace_name ?? i18n.t("workspaces.fallback.otherWorkspace"),
    path: UNASSIGNED_WORKSPACE_PATH,
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

function getWorkspaceTabs(workspace: WorkspaceDefinition): WorkspaceTab[] {
  return workspace.isGitRepository
    ? ["sessions", "git", "files"]
    : ["sessions", "files"];
}

function getWorkspaceDisplayName(workspace: WorkspaceDefinition): string {
  return workspace.name?.trim() || basename(workspace.path);
}

function basename(path: string): string {
  const normalized = path.replace(/\/+$/g, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? i18n.t("workspaces.fallback.workspace");
}

function getCloseActionLabel(
  session: TerminalSession,
  t: (key: string) => string,
): string {
  if (session.status === "exited" || session.status === "archived") {
    return t("workspaces.actions.remove");
  }

  return t("workspaces.actions.closeSession");
}

function getStatusColors(tone: "success" | "warning" | "danger" | "neutral"): {
  backgroundColor: string;
  color: string;
} {
  switch (tone) {
    case "success":
      return {
        backgroundColor: colors.successSoft,
        color: "#d7ffe9",
      };
    case "warning":
      return {
        backgroundColor: colors.warningSoft,
        color: colors.warning,
      };
    case "danger":
      return {
        backgroundColor: colors.dangerSoft,
        color: colors.danger,
      };
    case "neutral":
    default:
      return {
        backgroundColor: colors.neutralSoft,
        color: colors.textMuted,
      };
  }
}
