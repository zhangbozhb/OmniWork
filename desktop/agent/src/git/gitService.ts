import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type {
  GitDiffPayload,
  GitDiffScope,
  GitActionRequestPayload,
  GitWorktree,
  GitStatusPayload,
  WorkspaceDefinition,
  WorkspaceGitStatus,
} from "@omni-work/protocol-ts";
import {
  MAX_UNTRACKED_GIT_STAT_CONCURRENCY,
  MAX_UNTRACKED_GIT_STAT_FILES,
  countTextLines,
  isLikelyBinary,
  shouldCountUntrackedGitLines,
} from "../files/fileTypePolicy.ts";

const execFileAsync = promisify(execFile);

export class GitService {
  private readonly managedWorktreeRoot: string;
  private readonly pendingWorktreeCreates = new Map<
    string,
    Promise<{ created: GitWorktree; worktrees: GitWorktree[] }>
  >();

  constructor(options: { managedWorktreeRoot?: string } = {}) {
    this.managedWorktreeRoot =
      options.managedWorktreeRoot ??
      join(homedir(), ".omniwork", "worktrees");
  }

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
        runGit(workspace.path, ["status", "--porcelain=v1", "-z"]),
        runGit(workspace.path, ["diff", "--numstat"]),
        runGit(workspace.path, ["diff", "--cached", "--numstat"]),
      ]);
    const unstagedFileStats = parseNumstat(unstagedStats);
    const stagedFileStats = parseNumstat(stagedStats);
    const parsedFiles = parsePorcelainStatus(porcelain);
    const untrackedStatPaths = new Set(
      parsedFiles
        .filter((file) => file.status === "untracked")
        .slice(0, MAX_UNTRACKED_GIT_STAT_FILES)
        .map((file) => file.path),
    );
    const files = await mapWithConcurrency(
      parsedFiles,
      MAX_UNTRACKED_GIT_STAT_CONCURRENCY,
      async (file) => {
        const staged = stagedFileStats.get(file.path) ?? emptyStats();
        const unstaged =
          file.status === "untracked" && untrackedStatPaths.has(file.path)
            ? await getUntrackedStats(workspace.path, file.path)
            : (unstagedFileStats.get(file.path) ?? emptyStats());
        return {
          ...file,
          stagedAdditions: staged.additions,
          stagedDeletions: staged.deletions,
          unstagedAdditions: unstaged.additions,
          unstagedDeletions: unstaged.deletions,
          additions: staged.additions + unstaged.additions,
          deletions: staged.deletions + unstaged.deletions,
        };
      },
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

  async action(
    workspace: WorkspaceDefinition,
    operation: GitActionRequestPayload["operation"],
  ): Promise<WorkspaceGitStatus> {
    if (!workspace.isGitRepository) {
      throw new Error("Workspace is not a Git repository.");
    }
    const paths = [...new Set(operation.paths)];
    const pathsToApply: string[] = [];
    for (const path of paths) {
      await assertPathInsideWorkspace(workspace.path, path);
      const change = await getCurrentGitFileChange(workspace.path, path);
      if (!change) {
        throw new Error(`Path is not a current Git change: ${path}`);
      }
      if (
        (operation.type === "stage" && change.unstaged) ||
        (operation.type === "unstage" && change.staged)
      ) {
        pathsToApply.push(path);
      }
    }

    if (pathsToApply.length === 0) {
      return (await this.status(workspace)).status;
    }
    if (operation.type === "stage") {
      await runGit(workspace.path, [
        "--literal-pathspecs",
        "add",
        "--",
        ...pathsToApply,
      ]);
    } else {
      await runGit(workspace.path, [
        "--literal-pathspecs",
        "restore",
        "--staged",
        "--",
        ...pathsToApply,
      ]);
    }
    return (await this.status(workspace)).status;
  }

  async listWorktrees(workspace: WorkspaceDefinition): Promise<GitWorktree[]> {
    if (!workspace.isGitRepository) {
      throw new Error("Workspace is not a Git repository.");
    }
    const output = await runGit(workspace.path, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    const mainWorkspacePath = await realpath(workspace.path);
    return parseWorktreeList(output, mainWorkspacePath);
  }

  async createWorktree(
    workspace: WorkspaceDefinition,
    name: string,
  ): Promise<{ created: GitWorktree; worktrees: GitWorktree[] }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(name)) {
      throw new Error("Worktree name is invalid.");
    }
    const key = `${workspace.path}\0${name}`;
    const pending = this.pendingWorktreeCreates.get(key);
    if (pending) {
      return pending;
    }
    const create = this.createWorktreeOnce(workspace, name);
    this.pendingWorktreeCreates.set(key, create);
    try {
      return await create;
    } finally {
      if (this.pendingWorktreeCreates.get(key) === create) {
        this.pendingWorktreeCreates.delete(key);
      }
    }
  }

  private async createWorktreeOnce(
    workspace: WorkspaceDefinition,
    name: string,
  ): Promise<{ created: GitWorktree; worktrees: GitWorktree[] }> {
    const branch = `omniwork/${name}`;
    const workspaceRoot = await realpath(workspace.path);
    const workspaceKey = createHash("sha256")
      .update(workspaceRoot)
      .digest("hex")
      .slice(0, 16);
    const parent = join(this.managedWorktreeRoot, workspaceKey);
    const target = join(parent, name);
    const existing = (await this.listWorktrees(workspace)).find(
      (worktree) => worktree.branch === branch,
    );
    if (existing) {
      const [existingPath, targetPath] = await Promise.all([
        realpath(existing.path),
        realpath(target).catch(() => resolve(target)),
      ]);
      if (existingPath !== targetPath) {
        throw new Error(`Managed branch already exists at ${existing.path}.`);
      }
      return {
        created: existing,
        worktrees: await this.listWorktrees(workspace),
      };
    }
    if (await lstat(target).catch(() => undefined)) {
      throw new Error("Managed worktree destination already exists.");
    }

    await mkdir(parent, { recursive: true, mode: 0o700 });
    await runGit(workspace.path, [
      "worktree",
      "add",
      "-b",
      branch,
      target,
      "HEAD",
    ]);
    const worktrees = await this.listWorktrees(workspace);
    const created = worktrees.find((worktree) => worktree.branch === branch);
    if (
      !created ||
      (await realpath(created.path)) !== (await realpath(target))
    ) {
      throw new Error("Git created no matching managed worktree.");
    }
    return { created, worktrees };
  }
}

function parseWorktreeList(
  output: string,
  mainWorkspacePath: string,
): GitWorktree[] {
  const result: GitWorktree[] = [];
  let current: Partial<GitWorktree> = {};
  for (const field of output.split("\0")) {
    if (!field) {
      if (current.path && current.head) {
        result.push({
          path: current.path,
          head: current.head,
          branch: current.branch,
          is_main: resolve(current.path) === resolve(mainWorkspacePath),
          locked: current.locked ?? false,
          prunable: current.prunable ?? false,
        });
      }
      current = {};
      continue;
    }
    const separator = field.indexOf(" ");
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? "" : field.slice(separator + 1);
    if (key === "worktree") current.path = value;
    if (key === "HEAD") current.head = value;
    if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    if (key === "locked") current.locked = true;
    if (key === "prunable") current.prunable = true;
  }
  return result;
}

async function getCurrentGitFileChange(
  workspacePath: string,
  relativePath: string,
): Promise<WorkspaceGitStatus["files"][number] | undefined> {
  const target = resolve(workspacePath, relativePath);
  const info = await lstat(target).catch(() => undefined);
  if (info?.isDirectory()) {
    return undefined;
  }
  const status = await runGit(workspacePath, [
    "--literal-pathspecs",
    "status",
    "--porcelain=v1",
    "-z",
    "--",
    relativePath,
  ]);
  return parsePorcelainStatus(status).find(
    (file) => file.path === relativePath || file.oldPath === relativePath,
  );
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 5 * 1024 * 1024,
  });
  return stdout;
}

function parseBranchLine(
  line: string,
): Pick<WorkspaceGitStatus, "branch" | "ahead" | "behind"> {
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

function parsePorcelainStatus(
  output: string,
): WorkspaceGitStatus["files"] {
  const records = output.split("\0");
  const files: WorkspaceGitStatus["files"] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) {
      continue;
    }
    const code = record.slice(0, 2);
    const path = record.slice(3);
    const renamed = code.includes("R") || code.includes("C");
    const oldPath = renamed ? records[index + 1] : undefined;
    if (renamed) {
      index += 1;
    }
    files.push(parseStatusRecord(code, path, oldPath));
  }
  return files;
}

function parseStatusRecord(
  code: string,
  path: string,
  oldPath?: string,
): WorkspaceGitStatus["files"][number] {
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
    const target = resolve(workspacePath, relativePath);
    const stats = await lstat(target);
    if (!shouldCountUntrackedGitLines(relativePath, stats)) {
      return emptyStats();
    }
    const content = await readFile(target);
    if (content.length === 0) {
      return emptyStats();
    }
    if (isLikelyBinary(content)) {
      return emptyStats();
    }
    const additions = countTextLines(content);
    return { additions, deletions: 0 };
  } catch {
    return emptyStats();
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
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
