import type { JSX } from "react";
import { useEffect, useMemo, useRef } from "react";

import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import type {
  TerminalInputPayload,
  TerminalResizePayload,
  TerminalSize,
} from "../../../packages/protocol-ts/src/index.ts";
import { createTextInput } from "../../../packages/terminal-core/src/index.ts";
import type { TerminalLayout } from "../features/terminal/terminalLayout";

export interface NativeTerminalViewProps {
  frame: string;
  layout: TerminalLayout;
  terminalSize: TerminalSize;
  terminalInputEnabled?: boolean;
  readOnly?: boolean;
  onInput?(input: TerminalInputPayload): void;
  onResize?(size: TerminalResizePayload): void;
}

const TERMINAL_THEME = {
  background: "#050708",
  foreground: "#d7ffe9",
  cursor: "#d7ffe9",
  cursorAccent: "#050708",
  selectionBackground: "rgba(48, 196, 141, 0.35)",
};

const FONT_FAMILY =
  'Menlo, "SF Mono", "Cascadia Code", Consolas, "Roboto Mono", monospace';
const LINE_HEIGHT_RATIO = 1.2;
// 字号是 PC 上的可读默认值；移动端通过调小 xterm fontSize 适配，不使用 CSS transform。
const DEFAULT_FONT_SIZE = 14;
const MOBILE_FONT_SIZE = 9;
const TERMINAL_SCROLLBACK = 240;
const RESIZE_DEBOUNCE_MS = 120;
const SCROLL_LOCK_MS = 220;

export function NativeTerminalView({
  frame,
  layout: _layout,
  terminalSize,
  readOnly = false,
  onInput,
  onResize,
}: NativeTerminalViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const xtermHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const isPointerDownRef = useRef(false);
  const isUserScrollingRef = useRef(false);
  const pendingFrameRef = useRef<string | null>(null);
  const scrollUnlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const readOnlyRef = useRef(readOnly);
  const lastReportedSizeRef = useRef("");

  onInputRef.current = onInput;
  onResizeRef.current = onResize;
  readOnlyRef.current = readOnly;
  const selectableText = useMemo(() => toSelectableText(frame), [frame]);

  // 设计要点（解决跨端对齐）：
  // - mac agent 的 frame 来源是 tmux capturePane，按 tmux 当前 cols（80）绑定，
  //   tmux resize-window 不能可靠缩列；前端单方面 fit 后会与 frame 列宽不一致，
  //   导致每行被 xterm 折行错位。
  // - 因此 Web 端用 FitAddon 按真实容器计算可见 cols/rows，xterm 的
  //   scrollback 保存 capture-pane 历史，避免把过大的 rows 强塞进手机容器后裁剪。
  // - FitAddon 必须挂到无 padding 的真实 viewport 上；如果挂到带 padding 的
  //   外层容器，clientHeight 会包含 padding，手机上会多算行数导致底部裁剪。
  // - 不能使用 CSS transform: scale；xterm 的鼠标选区坐标不感知 transform，
  //   会导致 Web 端无法正常拖拽选中文本。
  useEffect(() => {
    const container = containerRef.current;
    const host = xtermHostRef.current;
    if (!container || !host) {
      return undefined;
    }

    const terminal = new Terminal({
      cols: terminalSize.cols,
      rows: terminalSize.rows,
      fontFamily: FONT_FAMILY,
      fontSize: pickFontSize(),
      lineHeight: LINE_HEIGHT_RATIO,
      cursorBlink: false,
      // tmux capture-pane 输出的是快照文本，换行符是 "\n"。React Native <Text>
      // 会把 "\n" 当成回到行首并换行，但 xterm 默认只 LF 不 CR，直接 write
      // 会导致每一行从上一行结束列继续写，画面呈阶梯状错位。开启 convertEol
      // 后 xterm 会按快照文本语义把 "\n" 视为 "\r\n"。
      convertEol: true,
      // capture-pane 会携带历史；交给 xterm scrollback 保存，避免裁剪掉用户输入历史。
      scrollback: TERMINAL_SCROLLBACK,
      allowProposedApi: true,
      theme: TERMINAL_THEME,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new ClipboardAddon());
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(host);
    terminal.attachCustomKeyEventHandler((event) => {
      // 让浏览器原生处理 Cmd+R / Cmd+T / Cmd+W 等系统快捷键；保留 Cmd+C / Cmd+V 给 xterm。
      if (event.metaKey && event.key !== "v" && event.key !== "c") {
        return false;
      }
      return true;
    });

    terminal.onData((data) => {
      if (readOnlyRef.current) {
        return;
      }
      onInputRef.current?.(createTextInput(data));
    });

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    terminal.options.scrollback = Math.max(
      TERMINAL_SCROLLBACK,
      terminalSize.rows,
    );
    container.style.setProperty(
      "--terminal-font-size",
      `${terminal.options.fontSize}px`,
    );
    container.style.setProperty(
      "--terminal-line-height",
      `${Number(terminal.options.fontSize) * LINE_HEIGHT_RATIO}px`,
    );

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button === 0) {
        isPointerDownRef.current = true;
      }
    };
    const handlePointerUp = () => {
      isPointerDownRef.current = false;
      const pendingFrame = pendingFrameRef.current;
      if (pendingFrame !== null) {
        pendingFrameRef.current = null;
        terminal.reset();
        terminal.write(pendingFrame);
      }
    };
    host.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("pointerup", handlePointerUp);

    const lockFrameUpdatesForScroll = () => {
      isUserScrollingRef.current = true;
      if (scrollUnlockTimerRef.current) {
        clearTimeout(scrollUnlockTimerRef.current);
      }
      scrollUnlockTimerRef.current = setTimeout(() => {
        if (isScrolledAwayFromBottom(terminal)) {
          scrollUnlockTimerRef.current = null;
          return;
        }
        isUserScrollingRef.current = false;
        scrollUnlockTimerRef.current = null;
        const pendingFrame = pendingFrameRef.current;
        if (pendingFrame !== null) {
          pendingFrameRef.current = null;
          terminal.reset();
          terminal.write(pendingFrame);
        }
      }, SCROLL_LOCK_MS);
    };

    const scrollByPixels = (deltaY: number) => {
      if (Math.abs(deltaY) < 1) {
        return;
      }
      const lineHeight =
        (Number(terminal.options.fontSize) || DEFAULT_FONT_SIZE) *
        LINE_HEIGHT_RATIO;
      const lines = Math.trunc(deltaY / Math.max(1, lineHeight));
      terminal.scrollLines(lines === 0 ? Math.sign(deltaY) : lines);
      lockFrameUpdatesForScroll();
    };

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      scrollByPixels(event.deltaY);
    };

    let lastTouchY: number | null = null;
    const handleTouchStart = (event: TouchEvent) => {
      lastTouchY = event.touches[0]?.clientY ?? null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? null;
      if (lastTouchY === null || nextY === null) {
        lastTouchY = nextY;
        return;
      }
      event.preventDefault();
      scrollByPixels(lastTouchY - nextY);
      lastTouchY = nextY;
    };
    const handleTouchEnd = () => {
      lastTouchY = null;
    };
    host.addEventListener("wheel", handleWheel, { passive: false });
    host.addEventListener("touchstart", handleTouchStart, { passive: true });
    host.addEventListener("touchmove", handleTouchMove, { passive: false });
    host.addEventListener("touchend", handleTouchEnd);
    host.addEventListener("touchcancel", handleTouchEnd);

    const reportSize = () => {
      const t = terminalRef.current;
      if (!t) {
        return;
      }
      const key = `${t.cols}x${t.rows}`;
      if (key === lastReportedSizeRef.current) {
        return;
      }
      lastReportedSizeRef.current = key;
      onResizeRef.current?.({ cols: t.cols, rows: t.rows });
    };

    const fitTerminalToContainer = () => {
      const addon = fitAddonRef.current;
      if (!addon) {
        return;
      }
      const dims = addon.proposeDimensions();
      if (!dims || dims.cols < 2 || dims.rows < 2) {
        return;
      }
      try {
        addon.fit();
        reportSize();
      } catch {
        // 容器尚未完成布局时忽略，下一次 ResizeObserver 会重新 fit。
      }
    };

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeTimer) {
        clearTimeout(resizeTimer);
      }
      resizeTimer = setTimeout(fitTerminalToContainer, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(host);
    // 等首帧渲染完成后再算一次，避免拿到 0 尺寸。
    requestAnimationFrame(() => fitTerminalToContainer());

    return () => {
      host.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerup", handlePointerUp);
      host.removeEventListener("wheel", handleWheel);
      host.removeEventListener("touchstart", handleTouchStart);
      host.removeEventListener("touchmove", handleTouchMove);
      host.removeEventListener("touchend", handleTouchEnd);
      host.removeEventListener("touchcancel", handleTouchEnd);
      if (scrollUnlockTimerRef.current) {
        clearTimeout(scrollUnlockTimerRef.current);
        scrollUnlockTimerRef.current = null;
      }
      if (resizeTimer) {
        clearTimeout(resizeTimer);
      }
      observer.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      lastReportedSizeRef.current = "";
    };
    // 仅在挂载/卸载时初始化与销毁。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 接收新 frame：mac agent 下发的是整屏快照，先 reset 再 write 覆盖，避免历史残留。
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    if (isPointerDownRef.current || isUserScrollingRef.current) {
      pendingFrameRef.current = frame;
      return;
    }
    terminal.reset();
    terminal.write(frame);
  }, [frame]);

  // cols/rows 变化（用户切 Display profile）时同步给 xterm，并重新拟合字号。
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    terminal.options.scrollback = Math.max(
      TERMINAL_SCROLLBACK,
      terminalSize.rows,
    );
    requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit();
      } catch {
        // 同上。
      }
    });
  }, [terminalSize.cols, terminalSize.rows]);

  return (
    <>
      <style>{SNAPSHOT_TERMINAL_CSS}</style>
      <div
        className="omniwork-xterm-snapshot"
        ref={containerRef}
        style={containerStyle}
      >
        <div ref={xtermHostRef} style={xtermHostStyle} />
        <pre aria-hidden className="omniwork-xterm-touch-select-layer">
          {selectableText}
        </pre>
      </div>
    </>
  );
}

const SNAPSHOT_TERMINAL_CSS = `
.omniwork-xterm-snapshot .xterm-cursor-layer {
  display: none !important;
}

.omniwork-xterm-snapshot .xterm-viewport {
  scrollbar-width: none;
}

.omniwork-xterm-snapshot .xterm-viewport::-webkit-scrollbar {
  display: none;
  height: 0;
  width: 0;
}

.omniwork-xterm-snapshot .xterm-scroll-area {
  width: 2px !important;
}

.omniwork-xterm-snapshot .xterm-scroll-area::after,
.omniwork-xterm-snapshot .xterm-scroll-area::before {
  width: 2px !important;
}

.omniwork-xterm-snapshot .xterm-scrollable-element .scrollbar.vertical,
.omniwork-xterm-snapshot .xterm-scrollable-element .scrollbar.vertical .slider {
  width: 2px !important;
}

.omniwork-xterm-snapshot .omniwork-xterm-touch-select-layer {
  color: transparent;
  caret-color: transparent;
  display: none;
  font-family: ${FONT_FAMILY};
  font-size: var(--terminal-font-size, ${DEFAULT_FONT_SIZE}px);
  line-height: var(--terminal-line-height, ${DEFAULT_FONT_SIZE * LINE_HEIGHT_RATIO}px);
  left: 8px;
  margin: 0;
  pointer-events: none;
  position: absolute;
  right: 8px;
  top: 8px;
  user-select: text;
  -webkit-user-select: text;
  -webkit-touch-callout: default;
  white-space: pre;
  z-index: 2;
}

.omniwork-xterm-snapshot .omniwork-xterm-touch-select-layer::selection {
  background: rgba(48, 196, 141, 0.35);
}

@media (pointer: coarse) {
  .omniwork-xterm-snapshot .omniwork-xterm-touch-select-layer {
    display: block;
    pointer-events: none;
  }
}
`;

const ANSI_PATTERN =
  /\x1B(?:\[([0-?]*)([ -/]*)([@-~])|\][^\x07]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;

function toSelectableText(frame: string): string {
  return frame
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(ANSI_PATTERN, "");
}

function pickFontSize(): number {
  if (typeof window === "undefined") {
    return DEFAULT_FONT_SIZE;
  }
  return window.innerWidth < 600 ? MOBILE_FONT_SIZE : DEFAULT_FONT_SIZE;
}

function isScrolledAwayFromBottom(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active;
  return buffer.viewportY < buffer.baseY;
}

const containerStyle: React.CSSProperties = {
  boxSizing: "border-box",
  flex: 1,
  minHeight: 260,
  borderColor: "#263037",
  borderStyle: "solid",
  borderWidth: 1,
  borderRadius: 8,
  // 历史交给 xterm scrollback；容器本身不纵向滚动，避免外层页面滚动干扰。
  overflowX: "auto",
  overflowY: "hidden",
  position: "relative",
  backgroundColor: "#050708",
  width: "100%",
  height: "100%",
};

const xtermHostStyle: React.CSSProperties = {
  bottom: 8,
  left: 8,
  overflow: "hidden",
  position: "absolute",
  right: 8,
  top: 8,
};
