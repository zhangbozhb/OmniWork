import { type JSX, useEffect, useMemo, useRef, useState } from "react";
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  type ScrollView,
  useWindowDimensions,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useTranslation } from "react-i18next";

import type {
  TerminalProviderDefinition,
  TerminalSession,
  FilesReadPayload,
  GitDiffPayload,
  GitDiffScope,
  TerminalProviderKind,
  WorkspaceDefinition,
  WorkspaceFileEntry,
  WorkspaceGitStatus,
} from "@omni-work/protocol-ts";
import {
  getCreatableTerminalProviders,
  isCreatableTerminalProviderKind,
} from "@omni-work/protocol-ts";
import { Button } from "../../ui/components";
import { spacing } from "../../ui/theme";
import { CreateSessionModal } from "./CreateSessionModal";
import { ManageSessionModal } from "./ManageSessionModal";
import {
  EMPTY_PROVIDER_PREFERENCES,
  getProviderPreferencesStorageKey,
  normalizeProviderPreferences,
  orderProviders,
  parseProviderPreferences,
  type ProviderPreferences,
} from "./providerPreferences";
import { ProviderPreferencesModal } from "./ProviderPreferencesModal";
import { RenameSessionModal } from "./RenameSessionModal";
import { SessionRow } from "./SessionRow";
import { styles } from "./styles";
import { WorkbenchToolbar } from "./WorkbenchToolbar";
import {
  findSessionWorkspace,
  getWorkspaceTabs,
  groupSessionsByProvider,
  groupSessionsByWorkspace,
  UNASSIGNED_WORKSPACE_PATH,
} from "./workbenchModel";
import { WorkspaceList } from "./WorkspaceList";
import { WorkspacePager } from "./WorkspacePager";
import { WorkspaceTabBar } from "./WorkspaceTabBar";
import type {
  CreatableTerminalProviderKind,
  RuntimePreference,
  TerminalProviderGroup,
  WorkspaceTab,
} from "./workbenchTypes";

export interface WorkbenchScreenProps {
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
    runtimePreference: RuntimePreference;
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

export function WorkbenchScreen({
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
}: WorkbenchScreenProps): JSX.Element {
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
  const defaultCreateTerminalProviderKind =
    creatableProviders[0]?.kind ?? "other";
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
    useState<CreatableTerminalProviderKind>(
      preferredCreateTerminalProviderKind,
    );
  const [createRuntimePreference, setCreateRuntimePreference] =
    useState<RuntimePreference>("tmux");
  const [renamingSession, setRenamingSession] =
    useState<TerminalSession | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [managingSession, setManagingSession] =
    useState<TerminalSession | null>(null);
  const [selectedWorkspace, setSelectedWorkspace] =
    useState<WorkspaceDefinition | null>(null);
  const [activeWorkspaceTab, setActiveWorkspaceTab] =
    useState<WorkspaceTab>("sessions");
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const providerPreferencesModalMaxHeight = Math.max(320, windowHeight - 44);
  const providerPreferencesListMaxHeight = Math.max(
    180,
    Math.min(420, windowHeight - 220),
  );
  const workspacePagerRef = useRef<ScrollView | null>(null);
  const sessionRefreshTimerRef = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
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
      !isCreatableTerminalProviderKind(
        createTerminalProviderKind,
        enabledProviders,
      ) ||
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
    if (
      createRuntimePreference === "app_server" &&
      createTerminalProviderKind !== "codex"
    ) {
      setCreateRuntimePreference("tmux");
    }
  }, [createRuntimePreference, createTerminalProviderKind]);

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
    setCreateRuntimePreference("tmux");
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
      runtimePreference: createRuntimePreference,
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
    refreshSessionsOnFirstWorkspaceEntry(workspace);
  }

  function refreshSessionsOnFirstWorkspaceEntry(
    workspace: WorkspaceDefinition,
  ): void {
    if (enteredWorkspacePathsRef.current.has(workspace.path)) {
      return;
    }
    enteredWorkspacePathsRef.current.add(workspace.path);
    onRefreshSessions();
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
  }

  function openWorkspaceTab(
    workspace: WorkspaceDefinition,
    tab: WorkspaceTab,
  ): void {
    switchWorkspaceTab(workspace, tab);
  }

  function renderSessionRow(session: TerminalSession): JSX.Element {
    return (
      <SessionRow
        key={session.session_id}
        session={session}
        closingSessionIds={closingSessionIds}
        killingSessionIds={killingSessionIds}
        t={t}
        onOpenSession={onOpenSession}
        onManageSession={setManagingSession}
      />
    );
  }

  const workspaceGroups = useMemo(
    () => groupSessionsByWorkspace(sessions, workspaces, t),
    [sessions, t, workspaces],
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
          findSessionWorkspace(session, workspaces, t).path ===
          activeWorkspace.path,
      )
    : [];
  const activeProviderGroups = activeWorkspace
    ? groupSessionsByProvider(
        activeWorkspaceSessions,
        providerGroups,
        providers,
      )
    : [];
  const workspaceTabs = activeWorkspace
    ? getWorkspaceTabs(activeWorkspace)
    : [];
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

  return (
    <View style={styles.screen}>
      <WorkbenchToolbar
        activeWorkspace={activeWorkspace}
        realWorkspaceCount={realWorkspaceGroups.length}
        sessionCount={sessions.length}
        t={t}
        onBack={onBack}
        onLeaveWorkspace={() => setSelectedWorkspace(null)}
        onRefreshSessions={onRefreshSessions}
        onOpenProviders={() => setProvidersModalVisible(true)}
      />

      {activeWorkspace ? (
        <WorkspacePager
          pagerRef={workspacePagerRef}
          activeWorkspace={activeWorkspace}
          activeWorkspaceTab={activeWorkspaceTab}
          activeProviderGroups={activeProviderGroups}
          effectiveWorkspacePagerWidth={effectiveWorkspacePagerWidth}
          sessionRefreshing={sessionRefreshing}
          creating={creating}
          preferredCreateTerminalProviderKind={preferredCreateTerminalProviderKind}
          enabledProviders={enabledProviders}
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
          t={t}
          renderSessionRow={renderSessionRow}
          onPagerLayout={handleWorkspacePagerLayout}
          onPagerScrollEnd={handleWorkspacePagerScrollEnd}
          onRefreshSessionTab={handleRefreshSessionTab}
          onOpenCreateModal={openCreateModal}
          onRefreshWorkspaceFiles={onRefreshWorkspaceFiles}
          onRefreshWorkspaceGit={onRefreshWorkspaceGit}
          onOpenDirectory={onOpenDirectory}
          onReadFile={onReadFile}
          onEditFile={onEditFile}
          onCloseFilePreview={onCloseFilePreview}
          onOpenGitDiff={onOpenGitDiff}
          onOpenGitReview={onOpenGitReview}
          onPrefetchGitDiff={onPrefetchGitDiff}
          onReadGitFileContent={onReadGitFileContent}
        />
      ) : (
        <WorkspaceList
          realWorkspaceGroups={realWorkspaceGroups}
          unassignedSessions={unassignedSessions}
          sessionRefreshing={sessionRefreshing}
          t={t}
          renderSessionRow={renderSessionRow}
          onRefreshSessions={handleRefreshSessionTab}
          onOpenWorkspace={openWorkspace}
        />
      )}

      {activeWorkspace ? (
        <WorkspaceTabBar
          activeWorkspace={activeWorkspace}
          activeWorkspaceTab={activeWorkspaceTab}
          t={t}
          onOpenWorkspaceTab={openWorkspaceTab}
        />
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
            setCreateRuntimePreference("tmux");
            setCreateModalVisible(true);
          }}
        >
          {t("workspaces.newWorkspace")}
        </Button>
      ) : null}

      <CreateSessionModal
        visible={createModalVisible}
        createWorkspaceLocked={createWorkspaceLocked}
        createCwd={createCwd}
        createWorkspacePath={createWorkspacePath}
        createTerminalProviderKind={createTerminalProviderKind}
        createRuntimePreference={createRuntimePreference}
        creatableProviders={creatableProviders}
        workspaces={workspaces}
        creating={creating}
        t={t}
        onClose={() => setCreateModalVisible(false)}
        onChangeCwd={(value) => {
          setCreateWorkspacePath(undefined);
          setCreateCwd(value);
        }}
        onSelectWorkspace={(workspace) => {
          setCreateWorkspacePath(workspace.path);
          setCreateCwd(workspace.path);
        }}
        onSelectProvider={setCreateTerminalProviderKind}
        onSelectRuntime={setCreateRuntimePreference}
        onConfirm={confirmCreateSession}
      />

      <RenameSessionModal
        session={renamingSession}
        renameTitle={renameTitle}
        t={t}
        onClose={() => setRenamingSession(null)}
        onChangeTitle={setRenameTitle}
        onConfirm={confirmRenameSession}
      />

      <ManageSessionModal
        session={managingSession}
        closingSessionIds={closingSessionIds}
        killingSessionIds={killingSessionIds}
        t={t}
        onClose={() => setManagingSession(null)}
        onRenameSession={(session) => {
          setManagingSession(null);
          openRenameModal(session);
        }}
        onCloseSession={(session) => {
          setManagingSession(null);
          onCloseSession(session);
        }}
        onKillTerminalSession={(session) => {
          setManagingSession(null);
          onKillTerminalSession(session);
        }}
      />

      <ProviderPreferencesModal
        visible={providersModalVisible}
        orderedProviders={orderedProviders}
        providerPreferences={providerPreferences}
        effectiveDefaultProviderKind={effectiveDefaultProviderKind}
        modalMaxHeight={providerPreferencesModalMaxHeight}
        listMaxHeight={providerPreferencesListMaxHeight}
        t={t}
        onClose={() => setProvidersModalVisible(false)}
        onReset={resetProviderPreferences}
        onToggleProviderHidden={toggleProviderHidden}
        onMoveProvider={moveProvider}
        onSetDefaultProvider={setDefaultProvider}
      />
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
