export const SUPPORTED_TEXT_FILE_EXTENSIONS = [
  "c",
  "cc",
  "cfg",
  "cjs",
  "conf",
  "cpp",
  "css",
  "csv",
  "cxx",
  "env",
  "go",
  "h",
  "hh",
  "hpp",
  "htm",
  "html",
  "hxx",
  "ini",
  "java",
  "js",
  "json",
  "jsonl",
  "jsx",
  "kt",
  "kts",
  "less",
  "log",
  "markdown",
  "md",
  "mjs",
  "php",
  "properties",
  "py",
  "pyw",
  "rb",
  "rs",
  "ruby",
  "sass",
  "scss",
  "sh",
  "sql",
  "svelte",
  "svg",
  "swift",
  "toml",
  "ts",
  "tsx",
  "tsv",
  "txt",
  "vue",
  "webmanifest",
  "xml",
  "yaml",
  "yml",
] as const;

const SUPPORTED_TEXT_FILE_EXTENSION_SET = new Set<string>(
  SUPPORTED_TEXT_FILE_EXTENSIONS,
);

export function getFileExtension(path: string): string | undefined {
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const extensionIndex = name.lastIndexOf(".");
  if (extensionIndex < 0 || extensionIndex === name.length - 1) {
    return undefined;
  }
  return name.slice(extensionIndex + 1).toLowerCase();
}

export function isSupportedTextFilePath(path: string): boolean {
  const extension = getFileExtension(path);
  return Boolean(extension && SUPPORTED_TEXT_FILE_EXTENSION_SET.has(extension));
}
