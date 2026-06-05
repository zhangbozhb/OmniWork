import type { TerminalInputPayload, TerminalSize } from "@omniwork/protocol-ts";

export const DEFAULT_TERMINAL_SIZE: TerminalSize = {
  cols: 100,
  rows: 32,
};

export const TERMINAL_CONTROL_KEYS = {
  escape: "\u001b",
  tab: "\t",
  enter: "\r",
  backspace: "\u007f",
  ctrlC: "\u0003",
  ctrlD: "\u0004",
  ctrlL: "\u000c",
  arrowUp: "\u001b[A",
  arrowDown: "\u001b[B",
  arrowRight: "\u001b[C",
  arrowLeft: "\u001b[D",
} as const;

export type TerminalControlKey = keyof typeof TERMINAL_CONTROL_KEYS;

export function createTextInput(data: string): TerminalInputPayload {
  return {
    kind: "text",
    data,
  };
}

export function createPasteInput(data: string): TerminalInputPayload {
  return {
    kind: "paste",
    data,
  };
}

export function createControlInput(key: TerminalControlKey): TerminalInputPayload {
  return {
    kind: "key",
    data: TERMINAL_CONTROL_KEYS[key],
  };
}

export function sanitizeTerminalText(value: string): string {
  return value.replace(/\r?\n/g, "\r");
}

export function clampTerminalSize(size: Partial<TerminalSize>): TerminalSize {
  return {
    cols: clampInteger(size.cols, 40, 200, DEFAULT_TERMINAL_SIZE.cols),
    rows: clampInteger(size.rows, 10, 80, DEFAULT_TERMINAL_SIZE.rows),
  };
}

function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  const integer = Math.trunc(value as number);
  return Math.max(min, Math.min(max, integer));
}
