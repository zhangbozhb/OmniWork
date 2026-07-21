import type {
  GitDiffPayload,
  GitDiffScope,
  WorkspaceGitStatus,
} from "@omniwork/protocol-ts";
import { isSupportedTextFilePath } from "@omniwork/protocol-ts";

import { toGitDiffCacheKey } from "../../features/workspaces/workspaceKeys.ts";

export type FileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked";
export type ChangedFile = WorkspaceGitStatus["files"][number];
export type DiffLineType = "add" | "delete" | "hunk" | "meta" | "context";

export interface DiffLine {
  content: string;
  type: DiffLineType;
}

export function isFileInScope(
  file: ChangedFile,
  scope: GitDiffScope,
): boolean {
  if (scope === "all") {
    return true;
  }
  if (scope === "staged") {
    return Boolean(file.staged);
  }
  if (scope === "untracked") {
    return file.status === "untracked";
  }
  return Boolean(file.unstaged) && file.status !== "untracked";
}

export function getChangeSummary(
  files: ChangedFile[],
): { additions: number; deletions: number } {
  return files.reduce(
    (summary, file) => ({
      additions: summary.additions + (file.additions ?? 0),
      deletions: summary.deletions + (file.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  );
}

export function getReviewScopeBadgeLabel(
  file: ChangedFile,
  scope: GitDiffScope,
  t: (key: string) => string,
): string {
  if (scope !== "all") {
    return t(`git.scope.${scope}`);
  }
  if (file.status === "untracked") {
    return t("git.scope.untracked");
  }
  if (file.staged && !file.unstaged) {
    return t("git.scope.staged");
  }
  if (file.unstaged && !file.staged) {
    return t("git.scope.unstaged");
  }
  return t("git.scope.all");
}

export function getScopedStats(
  file: ChangedFile,
  scope: GitDiffScope,
): { additions: number; deletions: number } {
  if (scope === "staged") {
    return {
      additions: file.stagedAdditions ?? 0,
      deletions: file.stagedDeletions ?? 0,
    };
  }
  if (scope === "unstaged" || scope === "untracked") {
    return {
      additions: file.unstagedAdditions ?? 0,
      deletions: file.unstagedDeletions ?? 0,
    };
  }
  return {
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
  };
}

export function getScopedStatus(
  file: ChangedFile,
  scope: GitDiffScope,
): FileStatus {
  if (file.status === "untracked") {
    return "untracked";
  }
  const code = scope === "staged" ? file.indexStatus : file.worktreeStatus;
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  return file.status;
}

export function statusCode(status: FileStatus): string {
  if (status === "untracked") return "?";
  if (status === "renamed") return "R";
  if (status === "added") return "A";
  if (status === "deleted") return "D";
  return "M";
}

export function parseDiffLines(diff: string): DiffLine[] {
  return diff
    .split("\n")
    .filter((line) => line.length > 0)
    .map((content) => ({ content, type: getDiffLineType(content) }));
}

export function getCachedDiff(
  cache: Record<string, GitDiffPayload>,
  fallback: GitDiffPayload | undefined,
  file: ChangedFile | undefined,
  scope: GitDiffScope,
): GitDiffPayload | undefined {
  if (!file) {
    return undefined;
  }
  const cached = cache[toGitDiffCacheKey(file.path, scope)];
  if (cached) {
    return cached;
  }
  if (
    fallback?.relativePath === file.path &&
    (fallback.scope ?? "unstaged") === scope
  ) {
    return fallback;
  }
  return undefined;
}

export function shouldUseUntrackedFileContentFallback(
  file: ChangedFile | undefined,
  diff: GitDiffPayload | undefined,
  scope: GitDiffScope,
): boolean {
  return Boolean(
    file &&
      scope === "untracked" &&
      file.status === "untracked" &&
      diff?.relativePath === file.path &&
      (diff.scope ?? "unstaged") === scope &&
      parseDiffLines(diff.diff).length === 0,
  );
}

export function canReadUntrackedFileContent(
  file: ChangedFile | undefined,
): boolean {
  return Boolean(file && isSupportedTextFilePath(file.path));
}

export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function getDiffLineType(content: string): DiffLineType {
  if (content.startsWith("@@")) return "hunk";
  if (
    content.startsWith("diff --git") ||
    content.startsWith("index ") ||
    content.startsWith("---") ||
    content.startsWith("+++") ||
    content.startsWith("## ")
  ) {
    return "meta";
  }
  if (content.startsWith("+")) return "add";
  if (content.startsWith("-")) return "delete";
  return "context";
}
