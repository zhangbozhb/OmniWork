import type { GitDiffScope } from "@omniwork/protocol-ts";

export function toGitDiffCacheKey(
  relativePath: string | undefined,
  scope: GitDiffScope,
): string {
  return `${scope}:${relativePath ?? ""}`;
}

export function parseGitDiffCacheKey(
  key: string | undefined,
): { relativePath?: string; scope: GitDiffScope } | undefined {
  if (!key) {
    return undefined;
  }
  const separatorIndex = key.indexOf(":");
  if (separatorIndex < 0) {
    return undefined;
  }
  const scope = key.slice(0, separatorIndex) as GitDiffScope;
  if (scope !== "all" && scope !== "staged" && scope !== "unstaged") {
    return undefined;
  }
  const relativePath = key.slice(separatorIndex + 1);
  return { scope, relativePath: relativePath || undefined };
}

export function toWorkspaceFileKey(
  workspacePath: string,
  relativePath: string,
): string {
  return `${workspacePath}:${relativePath}`;
}
