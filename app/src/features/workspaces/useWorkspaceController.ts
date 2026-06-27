import { useState } from "react";
import type {
  FilesListPayload,
  FilesReadPayload,
  FilesWritePayload,
  GitDiffPayload,
  GitDiffScope,
  GitStatusPayload,
  MessageEnvelope,
  WorkspaceDefinition,
} from "@omniwork/protocol-ts";

import type { AppView, ConnectionStatus } from "../../app/appTypes";
import type { PairingConfig } from "../auth/types";
import {
  createWorkspaceDataCache,
  createWorkspaceFilesCache,
  createWorkspaceGitCache,
  omitKey,
  type WorkspaceDataCache,
} from "./workspaceCache";
import {
  parseGitDiffCacheKey,
  toGitDiffCacheKey,
  toWorkspaceFileKey,
} from "./workspaceKeys";
import {
  gitDiffRequest,
  gitStatusRequest,
  listFilesRequest,
  readFileRequest,
  writeFileRequest,
} from "./workspaceMessages";

type WorkspaceDirectoryOptions = {
  force?: boolean;
  activate?: boolean;
};

type WorkspaceFileOptions = {
  activatePreview?: boolean;
  force?: boolean;
};

type GitDiffOptions = {
  activate?: boolean;
};

type UseWorkspaceControllerOptions = {
  pairing: PairingConfig | null;
  connectionStatus: ConnectionStatus;
  currentView: AppView;
  setView(view: AppView): void;
  sendToRelay(message: MessageEnvelope): void;
};

export function useWorkspaceController({
  pairing,
  connectionStatus,
  currentView,
  setView,
  sendToRelay,
}: UseWorkspaceControllerOptions) {
  const [selectedWorkspace, setSelectedWorkspace] =
    useState<WorkspaceDefinition | null>(null);
  const [workspaceCache, setWorkspaceCache] = useState<
    Record<string, WorkspaceDataCache>
  >({});
  const [gitReviewPath, setGitReviewPath] = useState<string | undefined>();
  const [gitReviewScope, setGitReviewScope] = useState<GitDiffScope>("all");
  const [fileEditorPath, setFileEditorPath] = useState<string | undefined>();
  const [fileEditorReturnView, setFileEditorReturnView] =
    useState<AppView>("workbench");
  const [fileWriteLoadingKeys, setFileWriteLoadingKeys] = useState<
    Record<string, boolean>
  >({});
  const [lastFileWriteResult, setLastFileWriteResult] = useState<
    FilesWritePayload | undefined
  >();

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

  function selectWorkspace(workspace: WorkspaceDefinition | null): void {
    setSelectedWorkspace(workspace);
  }

  function clearSelectedWorkspace(): void {
    setSelectedWorkspace(null);
  }

  function clearWorkspaceState(): void {
    setSelectedWorkspace(null);
    setWorkspaceCache({});
    setGitReviewPath(undefined);
    setGitReviewScope("all");
  }

  function reconcileSelectedWorkspace(
    workspaces: readonly WorkspaceDefinition[],
  ): void {
    setSelectedWorkspace((current) =>
      current
        ? (workspaces.find((workspace) => workspace.path === current.path) ??
          current)
        : current,
    );
  }

  function requestWorkspaceDirectory(
    workspace: WorkspaceDefinition,
    relativePath: string,
    options: WorkspaceDirectoryOptions = {},
  ): void {
    if (!pairing || connectionStatus !== "authenticated") {
      return;
    }
    const activate = options.activate ?? true;
    const workspacePath = workspace.path;
    const filesCache =
      workspaceCache[workspacePath]?.files ?? createWorkspaceFilesCache();
    const hasCachedEntries = Boolean(
      filesCache.directoriesByPath[relativePath],
    );
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
    options: WorkspaceFileOptions = {},
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
        selectedFilePath: activatePreview
          ? relativePath
          : cache.files.selectedFilePath,
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
    setFileEditorReturnView(currentView);
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
    options: GitDiffOptions = {},
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
    if (!selectedWorkspace || connectionStatus !== "authenticated") {
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

  function applyFilesList(payload: FilesListPayload): void {
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
  }

  function applyFilesRead(payload: FilesReadPayload): void {
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
  }

  function applyFilesWrite(payload: FilesWritePayload): void {
    const writeKey = toWorkspaceFileKey(
      payload.workspacePath,
      payload.relativePath,
    );
    const previousActiveDiffKey =
      workspaceCache[payload.workspacePath]?.git.activeDiffKey;
    const previousActiveDiff = parseGitDiffCacheKey(previousActiveDiffKey);
    setFileWriteLoadingKeys((current) => omitKey(current, writeKey));
    setLastFileWriteResult(payload);
    if (payload.status !== "saved") {
      return;
    }
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

  function applyGitStatus(payload: GitStatusPayload): void {
    updateWorkspaceDataCache(payload.workspacePath, (cache) => ({
      ...cache,
      git: {
        ...cache.git,
        status: payload.status,
        statusLoading: false,
      },
    }));
  }

  function applyGitDiff(payload: GitDiffPayload): void {
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
  }

  return {
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
    selectWorkspace,
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
  };
}
