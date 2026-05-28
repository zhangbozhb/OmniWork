export interface TerminalTextSegment {
  text: string;
  foregroundColor?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

interface TerminalAnsiState extends Omit<TerminalTextSegment, "text"> {}

const ANSI_PATTERN =
  /\x1B(?:\[([0-?]*)([ -/]*)([@-~])|\][^\x07]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;

export function normalizeTerminalFrame(frame: string, maxLines = 240): string {
  const normalized = frame.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
}

export function parseTerminalFrame(
  frame: string,
  maxLines = 240,
): TerminalTextSegment[] {
  const text = normalizeTerminalFrame(frame, maxLines);
  const segments: TerminalTextSegment[] = [];
  const state: TerminalAnsiState = {};
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  ANSI_PATTERN.lastIndex = 0;
  while ((match = ANSI_PATTERN.exec(text))) {
    appendSegment(segments, text.slice(lastIndex, match.index), state);
    const [, params, intermediates, command] = match;
    if (command === "m" && !intermediates) {
      applySgrParams(state, params);
    }
    lastIndex = ANSI_PATTERN.lastIndex;
  }

  appendSegment(segments, text.slice(lastIndex), state);
  return segments.length > 0 ? segments : [{ text: "" }];
}

function appendSegment(
  segments: TerminalTextSegment[],
  text: string,
  state: TerminalAnsiState,
): void {
  if (!text) {
    return;
  }

  segments.push({
    text,
    ...state,
  });
}

function applySgrParams(state: TerminalAnsiState, rawParams?: string): void {
  const params =
    rawParams && rawParams.length > 0
      ? rawParams.split(";").map((item) => Number(item || 0))
      : [0];

  for (const param of params) {
    if (param === 0) {
      resetState(state);
      continue;
    }
    if (param === 1) {
      state.bold = true;
      state.dim = false;
      continue;
    }
    if (param === 2) {
      state.dim = true;
      continue;
    }
    if (param === 3) {
      state.italic = true;
      continue;
    }
    if (param === 4) {
      state.underline = true;
      continue;
    }
    if (param === 7) {
      state.inverse = true;
      continue;
    }
    if (param === 22) {
      state.bold = undefined;
      state.dim = undefined;
      continue;
    }
    if (param === 23) {
      state.italic = undefined;
      continue;
    }
    if (param === 24) {
      state.underline = undefined;
      continue;
    }
    if (param === 27) {
      state.inverse = undefined;
      continue;
    }
    if (param === 39) {
      state.foregroundColor = undefined;
      continue;
    }
    if (param === 49) {
      state.backgroundColor = undefined;
      continue;
    }

    const foreground = ANSI_FOREGROUND_COLORS[param];
    if (foreground) {
      state.foregroundColor = foreground;
      continue;
    }

    const background = ANSI_BACKGROUND_COLORS[param];
    if (background) {
      state.backgroundColor = background;
    }
  }
}

function resetState(state: TerminalAnsiState): void {
  state.foregroundColor = undefined;
  state.backgroundColor = undefined;
  state.bold = undefined;
  state.dim = undefined;
  state.italic = undefined;
  state.underline = undefined;
  state.inverse = undefined;
}

const ANSI_FOREGROUND_COLORS: Record<number, string> = {
  30: "#2f3740",
  31: "#ff6b6b",
  32: "#30c48d",
  33: "#f6c177",
  34: "#7aa2ff",
  35: "#c792ea",
  36: "#6de6ff",
  37: "#d8dee9",
  90: "#66727c",
  91: "#ff8585",
  92: "#56dca6",
  93: "#ffd08a",
  94: "#9bb8ff",
  95: "#d7a6ff",
  96: "#91f0ff",
  97: "#f5f7f8",
};

const ANSI_BACKGROUND_COLORS: Record<number, string> = {
  40: "#050708",
  41: "#4a161b",
  42: "#12382a",
  43: "#4a3414",
  44: "#17294d",
  45: "#331f49",
  46: "#123d47",
  47: "#d8dee9",
  100: "#1b2228",
  101: "#6b2028",
  102: "#1a563f",
  103: "#6d4d1e",
  104: "#24417a",
  105: "#4b2d6d",
  106: "#1d5f6d",
  107: "#f5f7f8",
};
