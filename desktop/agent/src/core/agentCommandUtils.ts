export function isCodexTerminalProvider(terminalProvider: {
  kind: string;
  command: string;
}): boolean {
  if (terminalProvider.kind === "codex") {
    return true;
  }
  return firstShellWord(terminalProvider.command) === "codex";
}

export function isClaudeTerminalProvider(terminalProvider: {
  kind: string;
  command: string;
}): boolean {
  if (
    terminalProvider.kind === "claude" ||
    terminalProvider.kind === "claude-code" ||
    terminalProvider.kind === "claudecode"
  ) {
    return true;
  }
  const command = firstShellWord(terminalProvider.command);
  return (
    command === "claude" ||
    command === "claude-code" ||
    command === "claudecode"
  );
}

export function resolveTraeTerminalProvider(terminalProvider: {
  kind: string;
  command: string;
}): "trae" | "trae-cn" | null {
  if (
    terminalProvider.kind === "trae-cn" ||
    terminalProvider.kind === "trae_cn"
  ) {
    return "trae-cn";
  }
  if (
    terminalProvider.kind === "trae" ||
    terminalProvider.kind === "traex" ||
    terminalProvider.kind === "coco"
  ) {
    return "trae";
  }
  const command = firstShellWord(terminalProvider.command);
  if (command === "traecli" || command === "trae-agent" || command === "ta") {
    return "trae";
  }
  if (command === "coco") {
    return "trae";
  }
  return null;
}

function firstShellWord(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+)/.exec(trimmed);
  const word = match?.[1];
  if (!word) {
    return undefined;
  }
  if (
    (word.startsWith('"') && word.endsWith('"')) ||
    (word.startsWith("'") && word.endsWith("'"))
  ) {
    return word.slice(1, -1);
  }
  return word;
}
