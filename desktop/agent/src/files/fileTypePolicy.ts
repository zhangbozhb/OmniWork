import type { Stats } from "node:fs";
import { basename, extname } from "node:path";

import { isSupportedTextFilePath } from "@omniwork/protocol-ts";

export const IGNORED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "Pods",
  "build",
  "coverage",
  "dist",
  ".next",
  ".turbo",
]);

export const IGNORED_FILE_NAMES = new Set([
  ".DS_Store",
  ".DS+Store",
  "Thumbs.db",
  "Desktop.ini",
]);

export const MAX_TEXT_FILE_BYTES = 1024 * 1024;
export const MAX_UNTRACKED_GIT_STAT_FILES = 200;
export const MAX_UNTRACKED_GIT_STAT_BYTES = 256 * 1024;
export const MAX_UNTRACKED_GIT_STAT_CONCURRENCY = 8;

// Git status is a batch overview. These files should be listed, but their
// generated or low-value content should not be read just to compute line stats.
const GIT_UNTRACKED_LIST_ONLY_FILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "gradle.lockfile",
  "package-lock.json",
  "Pipfile.lock",
  "pnpm-lock.yaml",
  "Podfile.lock",
  "poetry.lock",
  "yarn.lock",
]);

const GIT_UNTRACKED_COUNTABLE_EXTENSIONLESS_TEXT_FILE_NAMES = new Set([
  ".env",
  ".gitignore",
  ".npmrc",
  "Dockerfile",
  "Makefile",
  "Procfile",
]);

const GIT_UNTRACKED_LIST_ONLY_PATH_SEGMENTS = new Set([
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "Pods",
]);

const GIT_UNTRACKED_LIST_ONLY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".apk",
  ".bin",
  ".bmp",
  ".class",
  ".db",
  ".dmg",
  ".dll",
  ".doc",
  ".docx",
  ".dylib",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".heic",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".otf",
  ".pdf",
  ".png",
  ".rar",
  ".sqlite",
  ".so",
  ".tar",
  ".tgz",
  ".ttf",
  ".wasm",
  ".webp",
  ".woff",
  ".woff2",
  ".xls",
  ".xlsx",
  ".zip",
]);

export function isIgnoredEntryName(name: string): boolean {
  return IGNORED_FILE_NAMES.has(name);
}

export function isIgnoredDirectory(
  name: string,
  type: "directory" | "file",
): boolean {
  return type === "directory" && IGNORED_DIRECTORIES.has(name);
}

export function shouldCountUntrackedGitLines(
  relativePath: string,
  stats: Stats,
): boolean {
  if (!stats.isFile() || stats.size > MAX_UNTRACKED_GIT_STAT_BYTES) {
    return false;
  }
  if (hasGeneratedOrVendorSegment(relativePath)) {
    return false;
  }
  const name = basename(relativePath);
  if (GIT_UNTRACKED_LIST_ONLY_FILE_NAMES.has(name)) {
    return false;
  }
  const extension = extname(name).toLowerCase();
  if (GIT_UNTRACKED_LIST_ONLY_EXTENSIONS.has(extension)) {
    return false;
  }
  return (
    isSupportedTextFilePath(relativePath) ||
    GIT_UNTRACKED_COUNTABLE_EXTENSIONLESS_TEXT_FILE_NAMES.has(name)
  );
}

export function countTextLines(content: Buffer): number {
  if (content.length === 0) {
    return 0;
  }
  let newlineCount = 0;
  for (const byte of content) {
    if (byte === 10) {
      newlineCount += 1;
    }
  }
  return content[content.length - 1] === 10 ? newlineCount : newlineCount + 1;
}

export function isLikelyBinary(content: Buffer): boolean {
  if (content.length === 0) {
    return false;
  }
  const sample = content.subarray(0, Math.min(content.length, 8000));
  let controlBytes = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return true;
    }
    if (byte < 7 || (byte > 14 && byte < 32)) {
      controlBytes += 1;
    }
  }
  return controlBytes / sample.length > 0.3;
}

function hasGeneratedOrVendorSegment(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .some((segment) => GIT_UNTRACKED_LIST_ONLY_PATH_SEGMENTS.has(segment));
}
