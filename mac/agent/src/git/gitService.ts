import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type {
  GitDiffPayload,
  GitStatusPayload,
  WorkspaceDefinition,
  WorkspaceGitStatus,
} from "../../../../packages/protocol-ts/src/index.ts";

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

    const [branchInfo, headSha, porcelain] = await Promise.all([
      runGit(workspace.path, ["status", "--short", "--branch"]),
      runGit(workspace.path, ["rev-parse", "--short", "HEAD"]),
      runGit(workspace.path, ["status", "--porcelain"]),
    ]);

    const status: WorkspaceGitStatus = {
      workspacePath: workspace.path,
      isGitRepository: true,
      ...parseBranchLine(branchInfo.split("\n")[0] ?? ""),
      headSha: headSha.trim() || undefined,
      hasChanges: porcelain.trim().length > 0,
      files: porcelain
        .split("\n")
        .filter(Boolean)
        .map(parseStatusLine),
    };

    return {
      workspacePath: workspace.path,
      status,
    };
  }

  async diff(
    workspace: WorkspaceDefinition,
    relativePath?: string,
  ): Promise<GitDiffPayload> {
    if (!workspace.isGitRepository) {
      return {
        workspacePath: workspace.path,
        relativePath,
        diff: "",
      };
    }

    const args = ["diff", "--"];
    if (relativePath) {
      await assertPathInsideWorkspace(workspace.path, relativePath);
      args.push(relativePath);
    }

    return {
      workspacePath: workspace.path,
      relativePath,
      diff: await runGit(workspace.path, args),
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
  const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath;
  return {
    path,
    status: mapGitStatus(code),
  };
}

function mapGitStatus(
  code: string,
): WorkspaceGitStatus["files"][number]["status"] {
  if (code.includes("?")) {
    return "untracked";
  }
  if (code.includes("A")) {
    return "added";
  }
  if (code.includes("D")) {
    return "deleted";
  }
  if (code.includes("R")) {
    return "renamed";
  }
  return "modified";
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
