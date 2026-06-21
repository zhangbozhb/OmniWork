import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import type {
  FilesListPayload,
  FilesReadPayload,
  FilesWritePayload,
  FilesWriteRequestPayload,
  WorkspaceDefinition,
  WorkspaceFileEntry,
} from "@omniwork/protocol-ts";
import { isSupportedTextFilePath } from "@omniwork/protocol-ts";

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
      modifiedAt: info.mtime.toISOString(),
      contentHash: hashText(buffer),
    };
  }

  async write(
    workspace: WorkspaceDefinition,
    payload: FilesWriteRequestPayload,
  ): Promise<FilesWritePayload> {
    const relativePath = normalizeRelativePath(payload.relativePath);
    if (!isSupportedTextFilePath(relativePath)) {
      return {
        workspacePath: workspace.path,
        relativePath,
        status: "unsupported",
        encoding: "utf8",
        size: 0,
        message: "This file type is not editable.",
      };
    }
    if (Buffer.byteLength(payload.content, "utf8") > MAX_TEXT_FILE_BYTES) {
      return {
        workspacePath: workspace.path,
        relativePath,
        status: "unsupported",
        encoding: "too_large",
        size: Buffer.byteLength(payload.content, "utf8"),
        message: "Edited content is too large to save.",
      };
    }

    const filePath = await resolveWorkspaceWritePath(workspace, relativePath);
    const current = await this.read(workspace, relativePath);
    if (current.encoding !== "utf8") {
      return {
        workspacePath: workspace.path,
        relativePath,
        status: "unsupported",
        encoding: current.encoding,
        size: current.size,
        modifiedAt: current.modifiedAt,
        contentHash: current.contentHash,
        message: "Only UTF-8 text files can be edited.",
      };
    }
    if (!current.contentHash) {
      return {
        workspacePath: workspace.path,
        relativePath,
        status: "unsupported",
        encoding: current.encoding,
        size: current.size,
        modifiedAt: current.modifiedAt,
        message: "Current file hash is unavailable. Reload the file before saving.",
      };
    }
    if (payload.baseHash !== current.contentHash) {
      return {
        workspacePath: workspace.path,
        relativePath,
        status: "conflict",
        content: current.content,
        encoding: "utf8",
        size: current.size,
        modifiedAt: current.modifiedAt,
        contentHash: current.contentHash,
        baseHash: payload.baseHash,
        message: "The file changed after it was opened.",
      };
    }

    await writeFile(filePath, payload.content, "utf8");
    const info = await stat(filePath);
    const savedBuffer = Buffer.from(payload.content, "utf8");
    return {
      workspacePath: workspace.path,
      relativePath,
      status: "saved",
      content: payload.content,
      encoding: "utf8",
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      contentHash: hashText(savedBuffer),
      baseHash: payload.baseHash,
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

async function resolveWorkspaceWritePath(
  workspace: WorkspaceDefinition,
  relativePath: string,
): Promise<string> {
  if (workspace.status !== "available") {
    throw new Error(`Workspace is not available: ${workspace.name ?? workspace.path}`);
  }
  const root = await realpath(workspace.path);
  const target = resolve(root, relativePath || ".");
  if (!isPathInside(target, root)) {
    throw new Error("Path escapes workspace root.");
  }
  const parent = await realpath(dirname(target));
  if (!isPathInside(parent, root)) {
    throw new Error("Path escapes workspace root.");
  }
  return target;
}

function hashText(input: Buffer): string {
  return createHash("sha256").update(input).digest("hex");
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
