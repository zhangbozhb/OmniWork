import { Dimensions, PixelRatio, Platform } from "react-native";
import type { TerminalSize } from "../../../../packages/protocol-ts/src/index.ts";

export type TerminalDisplayProfile =
  | "readableScroll"
  | "fitPreview"
  | "landscapeWide";

export interface TerminalViewport {
  width: number;
  height: number;
}

export interface TerminalLayout {
  profile: TerminalDisplayProfile;
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

export function getDefaultTerminalDisplayProfile(
  viewport: TerminalViewport,
): TerminalDisplayProfile {
  return viewport.width > viewport.height ? "landscapeWide" : "readableScroll";
}

export function computeTerminalLayout(
  viewport: TerminalViewport,
  profile: TerminalDisplayProfile,
): TerminalLayout {
  const platformMetrics = getPlatformTerminalMetrics();
  const availableWidth = Math.max(1, viewport.width - TERMINAL_HORIZONTAL_PADDING);
  const availableHeight = Math.max(1, viewport.height - TERMINAL_VERTICAL_PADDING);
  const baseFontSize = getProfileFontSize(profile, platformMetrics);
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
      profile,
      visibleCols,
    });
  }

  if (profile === "fitPreview") {
    const targetCols = Math.max(PORTRAIT_MIN_TUI_COLS, visibleCols);
    const fitFontSize = availableWidth / (targetCols * platformMetrics.charWidthRatio);
    const fontSize = Math.max(platformMetrics.minReadableFontSize, fitFontSize);
    const fitLimited = fitFontSize < platformMetrics.minReadableFontSize;
    const cellWidth = fontSize * platformMetrics.charWidthRatio;
    const lineHeight = fontSize * platformMetrics.lineHeightRatio;
    return {
      profile,
      terminalSize: {
        cols: targetCols,
        rows: clampInteger(Math.floor(availableHeight / lineHeight), 20, 40),
      },
      visibleCols: Math.max(1, Math.floor(availableWidth / cellWidth)),
      visibleRows: Math.max(1, Math.floor(availableHeight / lineHeight)),
      fontSize,
      lineHeight,
      cellWidth,
      horizontalScroll: fitLimited,
      fitLimited,
    };
  }

  if (profile === "landscapeWide") {
    const terminalCols = clampInteger(
      Math.max(LANDSCAPE_MIN_TUI_COLS, visibleCols),
      LANDSCAPE_MIN_TUI_COLS,
      LANDSCAPE_MAX_TUI_COLS,
    );
    return {
      profile,
      terminalSize: {
        cols: terminalCols,
        rows: clampInteger(visibleRows, 24, 40),
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

  const terminalCols = Math.max(PORTRAIT_MIN_TUI_COLS, visibleCols);
  return {
    profile,
    terminalSize: {
      cols: terminalCols,
      rows: clampInteger(visibleRows, 20, 40),
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

export function computeInitialTerminalSize(): TerminalSize {
  const window = Dimensions.get("window");
  const viewport = {
    width: window.width,
    height: Math.max(260, window.height - 260),
  };
  const profile = getDefaultTerminalDisplayProfile(viewport);
  return computeTerminalLayout(viewport, profile).terminalSize;
}

function getProfileFontSize(
  profile: TerminalDisplayProfile,
  metrics: ReturnType<typeof getPlatformTerminalMetrics>,
): number {
  if (profile === "fitPreview") {
    return metrics.balancedFontSize;
  }
  if (profile === "landscapeWide") {
    return metrics.balancedFontSize;
  }
  return metrics.readableFontSize;
}

function getPlatformTerminalMetrics(): {
  readableFontSize: number;
  balancedFontSize: number;
  minReadableFontSize: number;
  charWidthRatio: number;
  lineHeightRatio: number;
} {
  const fontScale = PixelRatio.getFontScale();
  if (Platform.OS === "web") {
    return {
      readableFontSize: 14,
      balancedFontSize: 13,
      minReadableFontSize: 7,
      charWidthRatio: 0.6,
      lineHeightRatio: 1.2,
    };
  }
  if (Platform.OS === "ios") {
    return {
      readableFontSize: 14,
      balancedFontSize: 13,
      minReadableFontSize: 11.5,
      charWidthRatio: 0.61,
      lineHeightRatio: 1.34,
    };
  }

  const densityDpi = PixelRatio.get() * 160;
  const densityAdjustedMinimum =
    densityDpi < 240 ? 12.5 : densityDpi >= 480 ? 11.5 : 12;
  const minReadableFontSize =
    fontScale > 1.15
      ? densityAdjustedMinimum * fontScale
      : densityAdjustedMinimum;
  return {
    readableFontSize: Math.max(14, 13 * fontScale),
    balancedFontSize: Math.max(13, 12 * fontScale),
    minReadableFontSize,
    charWidthRatio: 0.6,
    lineHeightRatio: 1.38,
  };
}

function computeWebTerminalLayout({
  availableWidth,
  availableHeight,
  baseFontSize,
  metrics,
  profile,
  visibleCols,
}: {
  availableWidth: number;
  availableHeight: number;
  baseFontSize: number;
  metrics: ReturnType<typeof getPlatformTerminalMetrics>;
  profile: TerminalDisplayProfile;
  visibleCols: number;
}): TerminalLayout {
  const terminalCols =
    profile === "landscapeWide"
      ? clampInteger(
          Math.max(LANDSCAPE_MIN_TUI_COLS, visibleCols),
          LANDSCAPE_MIN_TUI_COLS,
          LANDSCAPE_MAX_TUI_COLS,
        )
      : Math.max(PORTRAIT_MIN_TUI_COLS, visibleCols);
  const fitFontSize =
    availableWidth / (terminalCols * metrics.charWidthRatio);
  const fontSize = Math.max(
    metrics.minReadableFontSize,
    Math.min(baseFontSize, fitFontSize),
  );
  const fitLimited = fitFontSize < metrics.minReadableFontSize;
  const cellWidth = fontSize * metrics.charWidthRatio;
  const lineHeight = fontSize * metrics.lineHeightRatio;
  const visibleRows = Math.max(1, Math.floor(availableHeight / lineHeight));

  return {
    profile,
    terminalSize: {
      cols: terminalCols,
      rows: clampInteger(visibleRows, 20, WEB_MAX_TUI_ROWS),
    },
    visibleCols: Math.max(1, Math.floor(availableWidth / cellWidth)),
    visibleRows,
    fontSize,
    lineHeight,
    cellWidth,
    horizontalScroll:
      fitLimited || terminalCols * cellWidth > availableWidth + 1,
    fitLimited,
  };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
