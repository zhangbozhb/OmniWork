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
}): "traex" | null {
  if (
    terminalProvider.kind === "traex" ||
    terminalProvider.kind === "coco"
  ) {
    return "traex";
  }
  const command = firstShellWord(terminalProvider.command);
  if (
    command === "traex" ||
    command === "traecli" ||
    command === "trae-agent" ||
    command === "ta"
  ) {
    return "traex";
  }
  if (command === "coco") {
    return "traex";
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
