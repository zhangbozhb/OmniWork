import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type {
  CodexSession,
  WorkspaceDefinition,
} from "../../../../packages/protocol-ts/src/index.ts";

const execFileAsync = promisify(execFile);

export class WorkspaceManager {
  private readonly defaultCwd: string;
  private currentWorkspaces: WorkspaceDefinition[] = [];

  constructor(options: {
    defaultCwd: string;
  }) {
    this.defaultCwd = options.defaultCwd;
  }

  async list(sessions: readonly CodexSession[] = []): Promise<WorkspaceDefinition[]> {
    const byPath = new Map<string, WorkspaceDefinition>();

    for (const session of sessions) {
      if (!session.cwd) {
        continue;
      }
      const workspace = await this.discoverFromPath(
        session.cwd,
        session.origin === "external" ? "tmux" : "session",
      );
      byPath.set(workspace.path, mergeWorkspace(byPath.get(workspace.path), workspace));
    }

    if (byPath.size === 0) {
      const defaultWorkspace = await this.discoverFromPath(
        this.defaultCwd,
        "default",
      );
      byPath.set(defaultWorkspace.path, defaultWorkspace);
    }

    this.currentWorkspaces = Array.from(byPath.values()).sort((left, right) =>
      getWorkspaceDisplayName(left).localeCompare(getWorkspaceDisplayName(right)),
    );
    return this.currentWorkspaces;
  }

  async get(workspacePath: string): Promise<WorkspaceDefinition | undefined> {
    const normalizedPath = await safeRealpath(workspacePath);
    return this.currentWorkspaces.find(
      (workspace) => workspace.path === normalizedPath,
    ) ?? this.discoverFromPath(normalizedPath, "recent");
  }

  async resolveSessionWorkspace(
    session: Pick<CodexSession, "cwd" | "workspace_path">,
    workspaces?: readonly WorkspaceDefinition[],
  ): Promise<WorkspaceDefinition | undefined> {
    const candidates = workspaces ?? (await this.list());
    if (session.workspace_path) {
      const exact = candidates.find(
        (workspace) => workspace.path === session.workspace_path,
      );
      if (exact) {
        return exact;
      }
    }
    return this.matchWorkspace(session.cwd, candidates);
  }

  async resolveCreateCwd(payload: {
    cwd?: string;
    workspace_path?: string;
  }): Promise<{
    cwd: string;
    workspace?: WorkspaceDefinition;
  }> {
    if (payload.workspace_path) {
      const workspace = await this.get(payload.workspace_path);
      if (!workspace) {
        throw new Error(`Workspace not found: ${payload.workspace_path}`);
      }
      if (workspace.status !== "available") {
        throw new Error(
          `Workspace is not available: ${getWorkspaceDisplayName(workspace)}`,
        );
      }
      return { cwd: workspace.path, workspace };
    }

    const cwd = payload.cwd ?? this.defaultCwd;
    const workspace = await this.matchWorkspace(cwd, await this.list());
    return { cwd, workspace };
  }

  private async matchWorkspace(
    cwd: string,
    workspaces: readonly WorkspaceDefinition[],
  ): Promise<WorkspaceDefinition | undefined> {
    const cwdPath = await safeRealpath(cwd);
    const matches = workspaces
      .filter((workspace) => workspace.status === "available")
      .filter((workspace) => isPathInside(cwdPath, workspace.path))
      .sort((left, right) => right.path.length - left.path.length);
    return matches[0];
  }

  private async discoverFromPath(
    path: string,
    source: WorkspaceDefinition["source"],
  ): Promise<WorkspaceDefinition> {
    const normalizedPath = resolve(path);
    const available = await isReadableDirectory(normalizedPath);
    const status = available ? "available" : "missing";
    const gitRoot = available ? await findGitRoot(normalizedPath) : undefined;
    const workspacePath = gitRoot ?? normalizedPath;
    const realWorkspacePath = available ? await safeRealpath(workspacePath) : workspacePath;
    return {
      path: realWorkspacePath,
      name: basename(realWorkspacePath),
      isGitRepository: Boolean(gitRoot),
      gitRoot: gitRoot ? await safeRealpath(gitRoot) : undefined,
      status,
      source,
    };
  }
}

async function isReadableDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    await access(path, constants.R_OK);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function findGitRoot(path: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      path,
      "rev-parse",
      "--show-toplevel",
    ]);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function safeRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
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

function basename(path: string): string {
  const normalized = path.replace(/\/+$/g, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? "Workspace";
}

function getWorkspaceDisplayName(workspace: WorkspaceDefinition): string {
  return workspace.name?.trim() || basename(workspace.path);
}

function mergeWorkspace(
  previous: WorkspaceDefinition | undefined,
  next: WorkspaceDefinition,
): WorkspaceDefinition {
  if (!previous) {
    return next;
  }

  const sourceRank: Record<WorkspaceDefinition["source"], number> = {
    tmux: 4,
    session: 3,
    recent: 2,
    default: 1,
  };
  return sourceRank[next.source] > sourceRank[previous.source]
    ? { ...next, name: previous.name ?? next.name }
    : previous;
}
