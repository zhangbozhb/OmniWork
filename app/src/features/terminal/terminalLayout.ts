import { Dimensions, PixelRatio, Platform } from "react-native";
import type { TerminalSize } from "@omniwork/protocol-ts";

export type TerminalTextSize = "small" | "normal" | "big";

export const TERMINAL_TEXT_SIZE_OPTIONS: ReadonlyArray<{
  key: TerminalTextSize;
  label: string;
}> = [
  { key: "small", label: "Small" },
  { key: "normal", label: "Normal" },
  { key: "big", label: "Big" },
];

export interface TerminalViewport {
  width: number;
  height: number;
}

export interface TerminalLayout {
  textSize: TerminalTextSize;
  terminalSize: TerminalSize;
  visibleCols: number;
  visibleRows: number;
  fontSize: number;
  lineHeight: number;
  cellWidth: number;
  horizontalScroll: boolean;
  fitLimited: boolean;
}

const TERMINAL_HORIZONTAL_PADDING = 24;
const TERMINAL_VERTICAL_PADDING = 24;
const PORTRAIT_MIN_TUI_COLS = 80;
const LANDSCAPE_MIN_TUI_COLS = 100;
const LANDSCAPE_MAX_TUI_COLS = 120;
const WEB_MAX_TUI_ROWS = 120;

export function getDefaultTerminalTextSize(
  viewport: TerminalViewport,
): TerminalTextSize {
  return viewport.width > viewport.height ? "small" : "normal";
}

export function computeTerminalLayout(
  viewport: TerminalViewport,
  textSize: TerminalTextSize,
): TerminalLayout {
  const platformMetrics = getPlatformTerminalMetrics();
  const availableWidth = Math.max(1, viewport.width - TERMINAL_HORIZONTAL_PADDING);
  const availableHeight = Math.max(1, viewport.height - TERMINAL_VERTICAL_PADDING);
  const baseFontSize = getTextSizeFontSize(textSize, platformMetrics);
  const baseCellWidth = baseFontSize * platformMetrics.charWidthRatio;
  const baseLineHeight = baseFontSize * platformMetrics.lineHeightRatio;
  const visibleCols = Math.max(1, Math.floor(availableWidth / baseCellWidth));
  const visibleRows = Math.max(1, Math.floor(availableHeight / baseLineHeight));

  if (Platform.OS === "web") {
    return computeWebTerminalLayout({
      availableWidth,
      availableHeight,
      baseFontSize,
      metrics: platformMetrics,
      textSize,
      visibleCols,
    });
  }

  const minimumCols =
    viewport.width > viewport.height ? LANDSCAPE_MIN_TUI_COLS : PORTRAIT_MIN_TUI_COLS;
  const maximumCols =
    viewport.width > viewport.height ? LANDSCAPE_MAX_TUI_COLS : Number.MAX_SAFE_INTEGER;
  const terminalCols = clampInteger(
    Math.max(minimumCols, visibleCols),
    minimumCols,
    maximumCols,
  );
  return {
    textSize,
    terminalSize: {
      cols: terminalCols,
      rows: clampInteger(visibleRows, 1, 40),
    },
    visibleCols,
    visibleRows,
    fontSize: baseFontSize,
    lineHeight: baseLineHeight,
    cellWidth: baseCellWidth,
    horizontalScroll: terminalCols > visibleCols,
    fitLimited: false,
  };
}

export function computeInitialTerminalSize(
  preferredTextSize?: TerminalTextSize,
): TerminalSize {
  const window = Dimensions.get("window");
  const viewport = {
    width: window.width,
    height: Math.max(260, window.height - 260),
  };
  const textSize = preferredTextSize ?? getDefaultTerminalTextSize(viewport);
  return computeTerminalLayout(viewport, textSize).terminalSize;
}

export function isTerminalTextSize(
  value: string | null,
): value is TerminalTextSize {
  return value === "small" || value === "normal" || value === "big";
}

function getTextSizeFontSize(
  textSize: TerminalTextSize,
  metrics: ReturnType<typeof getPlatformTerminalMetrics>,
): number {
  if (textSize === "small") {
    return metrics.smallFontSize;
  }
  if (textSize === "big") {
    return metrics.bigFontSize;
  }
  return metrics.normalFontSize;
}

function getPlatformTerminalMetrics(): {
  smallFontSize: number;
  normalFontSize: number;
  bigFontSize: number;
  charWidthRatio: number;
  lineHeightRatio: number;
} {
  const fontScale = PixelRatio.getFontScale();
  if (Platform.OS === "web") {
    return {
      smallFontSize: 11,
      normalFontSize: 13,
      bigFontSize: 15,
      charWidthRatio: 0.6,
      lineHeightRatio: 1.2,
    };
  }
  if (Platform.OS === "ios") {
    return {
      smallFontSize: 12,
      normalFontSize: 14,
      bigFontSize: 16,
      charWidthRatio: 0.61,
      lineHeightRatio: 1.34,
    };
  }

  return {
    smallFontSize: Math.max(12, 11 * fontScale),
    normalFontSize: Math.max(14, 13 * fontScale),
    bigFontSize: Math.max(16, 15 * fontScale),
    charWidthRatio: 0.6,
    lineHeightRatio: 1.38,
  };
}

function computeWebTerminalLayout({
  availableWidth,
  availableHeight,
  baseFontSize,
  metrics,
  textSize,
  visibleCols,
}: {
  availableWidth: number;
  availableHeight: number;
  baseFontSize: number;
  metrics: ReturnType<typeof getPlatformTerminalMetrics>;
  textSize: TerminalTextSize;
  visibleCols: number;
}): TerminalLayout {
  const landscape = availableWidth > availableHeight;
  const minimumCols = landscape ? LANDSCAPE_MIN_TUI_COLS : PORTRAIT_MIN_TUI_COLS;
  const maximumCols = landscape ? LANDSCAPE_MAX_TUI_COLS : Number.MAX_SAFE_INTEGER;
  const terminalCols = clampInteger(
    Math.max(minimumCols, visibleCols),
    minimumCols,
    maximumCols,
  );
  const cellWidth = baseFontSize * metrics.charWidthRatio;
  const lineHeight = baseFontSize * metrics.lineHeightRatio;
  const visibleRows = Math.max(1, Math.floor(availableHeight / lineHeight));

  return {
    textSize,
    terminalSize: {
      cols: terminalCols,
      rows: clampInteger(visibleRows, 1, WEB_MAX_TUI_ROWS),
    },
    visibleCols,
    visibleRows,
    fontSize: baseFontSize,
    lineHeight,
    cellWidth,
    horizontalScroll: terminalCols * cellWidth > availableWidth + 1,
    fitLimited: false,
  };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
