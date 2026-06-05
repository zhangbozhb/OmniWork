import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type {
  GitDiffPayload,
  GitDiffScope,
  GitStatusPayload,
  WorkspaceDefinition,
  WorkspaceGitStatus,
} from "@omniwork/protocol-ts";

const execFileAsync = promisify(execFile);

export class GitService {
  async status(workspace: WorkspaceDefinition): Promise<GitStatusPayload> {
    if (!workspace.isGitRepository) {
      return {
        workspacePath: workspace.path,
        status: {
          workspacePath: workspace.path,
          isGitRepository: false,
          hasChanges: false,
          files: [],
        },
      };
    }

    const [branchInfo, headSha, porcelain, unstagedStats, stagedStats] =
      await Promise.all([
      runGit(workspace.path, ["status", "--short", "--branch"]),
      runGit(workspace.path, ["rev-parse", "--short", "HEAD"]),
      runGit(workspace.path, ["status", "--porcelain"]),
      runGit(workspace.path, ["diff", "--numstat"]),
      runGit(workspace.path, ["diff", "--cached", "--numstat"]),
    ]);
    const unstagedFileStats = parseNumstat(unstagedStats);
    const stagedFileStats = parseNumstat(stagedStats);
    const parsedFiles = porcelain
      .split("\n")
      .filter(Boolean)
      .map(parseStatusLine);
    const files = await Promise.all(
      parsedFiles.map(async (file) => {
        const staged = stagedFileStats.get(file.path) ?? emptyStats();
        const unstaged =
          file.status === "untracked"
            ? await getUntrackedStats(workspace.path, file.path)
            : unstagedFileStats.get(file.path) ?? emptyStats();
        return {
          ...file,
          stagedAdditions: staged.additions,
          stagedDeletions: staged.deletions,
          unstagedAdditions: unstaged.additions,
          unstagedDeletions: unstaged.deletions,
          additions: staged.additions + unstaged.additions,
          deletions: staged.deletions + unstaged.deletions,
        };
      }),
    );

    const status: WorkspaceGitStatus = {
      workspacePath: workspace.path,
      isGitRepository: true,
      ...parseBranchLine(branchInfo.split("\n")[0] ?? ""),
      headSha: headSha.trim() || undefined,
      hasChanges: porcelain.trim().length > 0,
      files,
    };

    return {
      workspacePath: workspace.path,
      status,
    };
  }

  async diff(
    workspace: WorkspaceDefinition,
    relativePath?: string,
    scope: GitDiffScope = "unstaged",
  ): Promise<GitDiffPayload> {
    if (!workspace.isGitRepository) {
      return {
        workspacePath: workspace.path,
        relativePath,
        scope,
        diff: "",
      };
    }

    if (relativePath) {
      await assertPathInsideWorkspace(workspace.path, relativePath);
    }

    return {
      workspacePath: workspace.path,
      relativePath,
      scope,
      diff: await getDiff(workspace.path, scope, relativePath),
    };
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 5 * 1024 * 1024,
  });
  return stdout;
}

function parseBranchLine(line: string): Pick<
  WorkspaceGitStatus,
  "branch" | "ahead" | "behind"
> {
  const trimmed = line.replace(/^##\s*/, "");
  const [branchPart, trackingPart] = trimmed.split("...");
  const branch = branchPart || undefined;
  const ahead = trackingPart?.match(/ahead\s+(\d+)/)?.[1];
  const behind = trackingPart?.match(/behind\s+(\d+)/)?.[1];
  return {
    branch,
    ahead: ahead ? Number(ahead) : undefined,
    behind: behind ? Number(behind) : undefined,
  };
}

function parseStatusLine(line: string): WorkspaceGitStatus["files"][number] {
  const code = line.slice(0, 2);
  const rawPath = line.slice(3).trim();
  const [oldPath, nextPath] = rawPath.includes(" -> ")
    ? rawPath.split(" -> ")
    : [undefined, rawPath];
  const path = nextPath ?? rawPath;
  const indexStatus = code[0];
  const worktreeStatus = code[1];
  return {
    path,
    oldPath,
    status: mapGitStatus(indexStatus, worktreeStatus),
    indexStatus,
    worktreeStatus,
    staged: indexStatus !== " " && indexStatus !== "?",
    unstaged: worktreeStatus !== " " || code === "??",
  };
}

function mapGitStatus(
  indexStatus: string,
  worktreeStatus: string,
): WorkspaceGitStatus["files"][number]["status"] {
  const code = `${indexStatus}${worktreeStatus}`;
  const visibleStatus = worktreeStatus !== " " ? worktreeStatus : indexStatus;
  if (code === "??") {
    return "untracked";
  }
  if (visibleStatus === "A") {
    return "added";
  }
  if (visibleStatus === "D") {
    return "deleted";
  }
  if (indexStatus === "R") {
    return "renamed";
  }
  return "modified";
}

async function getDiff(
  workspacePath: string,
  scope: GitDiffScope,
  relativePath?: string,
): Promise<string> {
  if (scope === "staged") {
    return runGitDiff(workspacePath, ["diff", "--cached"], relativePath);
  }
  if (scope === "all") {
    const [staged, unstaged] = await Promise.all([
      runGitDiff(workspacePath, ["diff", "--cached"], relativePath),
      runGitDiff(workspacePath, ["diff"], relativePath),
    ]);
    return [
      staged ? "## Staged changes\n\n" + staged : "",
      unstaged ? "## Unstaged changes\n\n" + unstaged : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (scope === "untracked") {
    return "";
  }
  return runGitDiff(workspacePath, ["diff"], relativePath);
}

async function runGitDiff(
  workspacePath: string,
  baseArgs: string[],
  relativePath?: string,
): Promise<string> {
  const args = [...baseArgs, "--"];
  if (relativePath) {
    args.push(relativePath);
  }
  return runGit(workspacePath, args);
}

interface FileLineStats {
  additions: number;
  deletions: number;
}

function emptyStats(): FileLineStats {
  return { additions: 0, deletions: 0 };
}

function parseNumstat(output: string): Map<string, FileLineStats> {
  const stats = new Map<string, FileLineStats>();
  for (const line of output.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const [additionsRaw, deletionsRaw, ...pathParts] = line.split("\t");
    const path = normalizeNumstatPath(pathParts.join("\t"));
    const additions = additionsRaw === "-" ? 0 : Number(additionsRaw);
    const deletions = deletionsRaw === "-" ? 0 : Number(deletionsRaw);
    stats.set(path, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    });
  }
  return stats;
}

function normalizeNumstatPath(path: string): string {
  const renamed = path.match(/\{.* => (.*)\}/)?.[1];
  if (renamed) {
    return path.replace(/\{.* => (.*)\}/, renamed);
  }
  return path;
}

async function getUntrackedStats(
  workspacePath: string,
  relativePath: string,
): Promise<FileLineStats> {
  try {
    await assertPathInsideWorkspace(workspacePath, relativePath);
    const content = await readFile(resolve(workspacePath, relativePath), "utf8");
    if (content.length === 0) {
      return emptyStats();
    }
    const additions = content.endsWith("\n")
      ? content.split("\n").length - 1
      : content.split("\n").length;
    return { additions, deletions: 0 };
  } catch {
    return emptyStats();
  }
}

async function assertPathInsideWorkspace(
  workspacePath: string,
  relativePath: string,
): Promise<void> {
  const root = await realpath(workspacePath);
  const target = resolve(root, relativePath);
  if (!isPathInside(target, root)) {
    throw new Error("Path escapes workspace root.");
  }
}

function isPathInside(path: string, parent: string): boolean {
  const normalizedPath = path.replace(/\/+$/g, "");
  const normalizedParent = parent.replace(/\/+$/g, "");
  return (
    normalizedPath === normalizedParent ||
    normalizedPath.startsWith(`${normalizedParent}/`)
  );
}
