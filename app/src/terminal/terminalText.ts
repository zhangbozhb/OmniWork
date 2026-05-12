const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;

export function normalizeTerminalFrame(frame: string, maxLines = 240): string {
  const withoutAnsi = frame.replace(ANSI_PATTERN, "");
  const normalized = withoutAnsi.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
}
