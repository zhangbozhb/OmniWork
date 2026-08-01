import type { JSX, RefObject } from "react";
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";

import type {
  FilesReadPayload,
  GitDiffPayload,
  GitDiffScope,
  TerminalProviderDefinition,
  TerminalSession,
  WorkspaceDefinition,
  WorkspaceFileEntry,
  WorkspaceGitStatus,
} from "@omni-work/protocol-ts";
import { isCreatableTerminalProviderKind } from "@omni-work/protocol-ts";

import { Button } from "../../ui/components";
import { colors } from "../../ui/theme";
import { FileBrowserScreen } from "../workspaces/FileBrowserScreen";
import { GitStatusScreen } from "../workspaces/GitStatusScreen";
import { styles } from "./styles";
import type {
  CreatableTerminalProviderKind,
  TerminalProviderGroup,
  WorkspaceTab,
} from "./workbenchTypes";

type Translate = (key: string, options?: Record<string, unknown>) => string;
type ProviderSessionGroup = TerminalProviderGroup & {
  sessions: TerminalSession[];
};

export function WorkspacePager({
  pagerRef,
  activeWorkspace,
  activeWorkspaceTab,
  activeProviderGroups,
  effectiveWorkspacePagerWidth,
  sessionRefreshing,
  creating,
  preferredCreateTerminalProviderKind,
  enabledProviders,
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
  gitActionError,
  t,
  renderSessionRow,
  onPagerLayout,
  onPagerScrollEnd,
  onRefreshSessionTab,
  onOpenCreateModal,
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
  onGitAction,
  isGitActionPending,
}: {
  pagerRef: RefObject<ScrollView | null>;
  activeWorkspace: WorkspaceDefinition;
  activeWorkspaceTab: WorkspaceTab;
  activeProviderGroups: readonly ProviderSessionGroup[];
  effectiveWorkspacePagerWidth: number;
  sessionRefreshing: boolean;
  creating: boolean;
  preferredCreateTerminalProviderKind: CreatableTerminalProviderKind;
  enabledProviders: readonly TerminalProviderDefinition[];
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
  gitActionError?: string;
  t: Translate;
  renderSessionRow(session: TerminalSession): JSX.Element;
  onPagerLayout(event: LayoutChangeEvent): void;
  onPagerScrollEnd(event: NativeSyntheticEvent<NativeScrollEvent>): void;
  onRefreshSessionTab(): void;
  onOpenCreateModal(
    terminalProviderKind: CreatableTerminalProviderKind,
    preferredWorkspace?: WorkspaceDefinition,
    lockedWorkspace?: boolean,
  ): void;
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
  onGitAction(relativePath: string, operation: "stage" | "unstage"): void;
  isGitActionPending(relativePath: string): boolean;
}): JSX.Element {
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
    <ScrollView
      ref={pagerRef}
      directionalLockEnabled
      horizontal
      pagingEnabled
      contentContainerStyle={styles.workspacePagerContent}
      scrollEventThrottle={16}
      scrollEnabled={effectiveWorkspacePagerWidth > 0}
      showsHorizontalScrollIndicator={false}
      style={styles.workspacePager}
      onLayout={onPagerLayout}
      onMomentumScrollEnd={onPagerScrollEnd}
      onScrollEndDrag={onPagerScrollEnd}
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
              onRefresh={onRefreshSessionTab}
            />
          ) : undefined
        }
        style={workspaceTabPaneStyle("sessions")}
      >
        <View style={styles.providerSection}>
          {activeProviderGroups.length === 0 ? (
            <View style={styles.sessionsEmptyState}>
              <Text style={styles.empty}>{t("workspaces.noSessions")}</Text>
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
                  onOpenCreateModal(
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
                        onOpenCreateModal(
                          group.kind as CreatableTerminalProviderKind,
                          activeWorkspace,
                        )
                      }
                    >
                      {t("workspaces.add")}
                    </Button>
                  </View>
                  {group.sessions.map(renderSessionRow)}
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
            gitActionError={gitActionError}
            onRefresh={() => onRefreshWorkspaceGit(activeWorkspace)}
            onOpenDiff={onOpenGitDiff}
            onOpenReview={(relativePath, scope) =>
              onOpenGitReview(activeWorkspace, relativePath, scope)
            }
            onPrefetchDiff={onPrefetchGitDiff}
            onReadFileContent={onReadGitFileContent}
            onGitAction={onGitAction}
            isGitActionPending={isGitActionPending}
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
  );
}
