import type {
  FilesReadPayload,
  GitDiffPayload,
  WorkspaceFileEntry,
  WorkspaceGitStatus,
} from "@omniwork/protocol-ts";

export type WorkspaceFilesCache = {
  currentPath: string;
  selectedFilePath?: string;
  directoriesByPath: Record<string, WorkspaceFileEntry[]>;
  filesByPath: Record<string, FilesReadPayload>;
  loadingDirectoryKeys: Record<string, boolean>;
  loadingFileKeys: Record<string, boolean>;
};

export type WorkspaceGitCache = {
  status?: WorkspaceGitStatus;
  statusLoading?: boolean;
  activeDiffKey?: string;
  diffCache: Record<string, GitDiffPayload>;
  diffLoadingKeys: Record<string, boolean>;
  fileContentCache: Record<string, FilesReadPayload>;
  fileContentLoadingKeys: Record<string, boolean>;
};

export type WorkspaceDataCache = {
  files: WorkspaceFilesCache;
  git: WorkspaceGitCache;
};

export function createWorkspaceFilesCache(): WorkspaceFilesCache {
  return {
    currentPath: "",
    directoriesByPath: {},
    filesByPath: {},
    loadingDirectoryKeys: {},
    loadingFileKeys: {},
  };
}

export function createWorkspaceGitCache(): WorkspaceGitCache {
  return {
    diffCache: {},
    diffLoadingKeys: {},
    fileContentCache: {},
    fileContentLoadingKeys: {},
  };
}

export function createWorkspaceDataCache(): WorkspaceDataCache {
  return {
    files: createWorkspaceFilesCache(),
    git: createWorkspaceGitCache(),
  };
}

export function omitKey<T>(
  record: Record<string, T>,
  key: string,
): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}
