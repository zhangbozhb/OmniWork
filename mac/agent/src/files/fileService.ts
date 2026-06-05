import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type {
  FilesListPayload,
  FilesReadPayload,
  WorkspaceDefinition,
  WorkspaceFileEntry,
} from "@omniwork/protocol-ts";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "Pods",
  "build",
  "dist",
  ".next",
  ".turbo",
]);
const MAX_TEXT_FILE_BYTES = 1024 * 1024;

export class FileService {
  async list(
    workspace: WorkspaceDefinition,
    relativePath = "",
  ): Promise<FilesListPayload> {
    const directory = await resolveWorkspacePath(workspace, relativePath);
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => !isIgnoredEntry(entry.name, entry.isDirectory()))
        .map(async (entry): Promise<WorkspaceFileEntry> => {
          const absolutePath = join(directory, entry.name);
          const info = await stat(absolutePath);
          const entryRelativePath = normalizeRelativePath(
            join(relativePath, entry.name),
          );
          return {
            name: entry.name,
            path: absolutePath,
            relativePath: entryRelativePath,
            type: entry.isDirectory() ? "directory" : "file",
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
          };
        }),
    );

    return {
      workspacePath: workspace.path,
      relativePath: normalizeRelativePath(relativePath),
      entries: files.sort(compareFileEntries),
    };
  }

  async read(
    workspace: WorkspaceDefinition,
    relativePath: string,
  ): Promise<FilesReadPayload> {
    const filePath = await resolveWorkspacePath(workspace, relativePath);
    const info = await stat(filePath);
    if (!info.isFile()) {
      throw new Error("Only regular files can be read.");
    }
    if (info.size > MAX_TEXT_FILE_BYTES) {
      return {
        workspacePath: workspace.path,
        relativePath: normalizeRelativePath(relativePath),
        encoding: "too_large",
        size: info.size,
      };
    }

    const buffer = await readFile(filePath);
    if (buffer.includes(0)) {
      return {
        workspacePath: workspace.path,
        relativePath: normalizeRelativePath(relativePath),
        encoding: "binary",
        size: info.size,
      };
    }

    return {
      workspacePath: workspace.path,
      relativePath: normalizeRelativePath(relativePath),
      content: buffer.toString("utf8"),
      encoding: "utf8",
      size: info.size,
    };
  }
}

async function resolveWorkspacePath(
  workspace: WorkspaceDefinition,
  relativePath: string,
): Promise<string> {
  if (workspace.status !== "available") {
    throw new Error(`Workspace is not available: ${workspace.name ?? workspace.path}`);
  }
  const root = await realpath(workspace.path);
  const target = resolve(root, relativePath || ".");
  const resolvedTarget = await realpath(target);
  if (!isPathInside(resolvedTarget, root)) {
    throw new Error("Path escapes workspace root.");
  }
  return resolvedTarget;
}

function isPathInside(path: string, parent: string): boolean {
  const normalizedPath = path.replace(/\/+$/g, "");
  const normalizedParent = parent.replace(/\/+$/g, "");
  return (
    normalizedPath === normalizedParent ||
    normalizedPath.startsWith(`${normalizedParent}/`)
  );
}

function isIgnoredEntry(name: string, directory: boolean): boolean {
  return directory && IGNORED_DIRECTORIES.has(name);
}

function normalizeRelativePath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/g, "");
}

function compareFileEntries(
  left: WorkspaceFileEntry,
  right: WorkspaceFileEntry,
): number {
  if (left.type !== right.type) {
    return left.type === "directory" ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}
