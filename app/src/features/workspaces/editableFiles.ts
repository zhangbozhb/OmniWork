import type { FilesReadPayload } from "@omniwork/protocol-ts";
import { isSupportedTextFilePath } from "@omniwork/protocol-ts";

export const MAX_EDITABLE_TEXT_FILE_BYTES = 1024 * 1024;

export function canEditFileContent(
  path: string | undefined,
  file: FilesReadPayload | undefined,
): boolean {
  return Boolean(
    path &&
      file?.encoding === "utf8" &&
      file.size <= MAX_EDITABLE_TEXT_FILE_BYTES &&
      isSupportedTextFilePath(path),
  );
}

export function getEditableFileBlockReason(
  path: string | undefined,
  file: FilesReadPayload | undefined,
): "missing" | "unsupported_type" | "binary" | "too_large" | undefined {
  if (!path || !file) {
    return "missing";
  }
  if (!isSupportedTextFilePath(path)) {
    return "unsupported_type";
  }
  if (file.encoding === "binary") {
    return "binary";
  }
  if (file.encoding === "too_large" || file.size > MAX_EDITABLE_TEXT_FILE_BYTES) {
    return "too_large";
  }
  return undefined;
}
