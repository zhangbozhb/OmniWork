import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { StyleSheet, View } from "react-native";
import type { WebViewMessageEvent } from "react-native-webview";
import { WebView } from "react-native-webview";

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
  /**
   * Backend/session size state used as an initial fallback by callers.
   * WebView xterm display size is still measured by FitAddon and reported back.
   */
  terminalSize: TerminalSize;
  terminalInputEnabled?: boolean;
  readOnly?: boolean;
  onInput?(input: TerminalInputPayload): void;
  onResize?(size: TerminalResizePayload): void;
}

type BridgeMessage =
  | { type: "ready" }
  | { type: "data"; data: string }
  | { type: "resize"; cols: number; rows: number };

const XTERM_CDN_VERSION = "6.0.0";
const FIT_CDN_VERSION = "0.11.0";
const WEB_LINKS_CDN_VERSION = "0.12.0";
const TERMINAL_SCROLLBACK = 240;
const TERMINAL_VIEW_PADDING = 8;
const TERMINAL_BOTTOM_SAFETY_PX = 4;
const SCROLL_LOCK_MS = 220;

export function NativeTerminalView({
  frame,
  layout,
  terminalInputEnabled = false,
  readOnly = false,
  onInput,
  onResize,
}: NativeTerminalViewProps): JSX.Element {
  const webViewRef = useRef<WebView>(null);
  const readyRef = useRef(false);
  const lastFrameRef = useRef(frame);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const readOnlyRef = useRef(readOnly);

  onInputRef.current = onInput;
  onResizeRef.current = onResize;
  readOnlyRef.current = readOnly;

  const html = useMemo(() => createTerminalHtml(), []);

  const sendBridgeCommand = useCallback((command: unknown) => {
    const script = `window.__omniworkTerminalBridge && window.__omniworkTerminalBridge(${JSON.stringify(
      command,
    )}); true;`;
    webViewRef.current?.injectJavaScript(script);
  }, []);

  const writeFrame = useCallback(
    (nextFrame: string) => {
      lastFrameRef.current = nextFrame;
      if (!readyRef.current) {
        return;
      }
      sendBridgeCommand({ type: "write", frame: nextFrame });
    },
    [sendBridgeCommand],
  );

  useEffect(() => {
    writeFrame(frame);
  }, [frame, writeFrame]);

  useEffect(() => {
    if (!readyRef.current) {
      return;
    }
    sendBridgeCommand({
      type: "setInputEnabled",
      enabled: terminalInputEnabled && !readOnly,
    });
  }, [readOnly, sendBridgeCommand, terminalInputEnabled]);

  useEffect(() => {
    if (!readyRef.current) {
      return;
    }
    sendBridgeCommand({
      type: "setFont",
      fontSize: layout.fontSize,
      lineHeight: layout.lineHeight / layout.fontSize,
    });
  }, [layout.fontSize, layout.lineHeight, sendBridgeCommand]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: BridgeMessage;
      try {
        message = JSON.parse(event.nativeEvent.data) as BridgeMessage;
      } catch {
        return;
      }

      if (message.type === "ready") {
        readyRef.current = true;
        sendBridgeCommand({
          type: "setInputEnabled",
          enabled: terminalInputEnabled && !readOnlyRef.current,
        });
        sendBridgeCommand({
          type: "setFont",
          fontSize: layout.fontSize,
          lineHeight: layout.lineHeight / layout.fontSize,
        });
        sendBridgeCommand({ type: "write", frame: lastFrameRef.current });
        sendBridgeCommand({ type: "fit" });
        return;
      }

      if (message.type === "data") {
        if (readOnlyRef.current) {
          return;
        }
        onInputRef.current?.(createTextInput(message.data));
        return;
      }

      if (message.type === "resize") {
        onResizeRef.current?.({ cols: message.cols, rows: message.rows });
      }
    },
    [
      layout.fontSize,
      layout.lineHeight,
      sendBridgeCommand,
      terminalInputEnabled,
    ],
  );

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={{ html }}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled={false}
        scrollEnabled={false}
        bounces={false}
        textInteractionEnabled
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        onMessage={handleMessage}
        onLayout={() => {
          if (readyRef.current) {
            sendBridgeCommand({ type: "fit" });
          }
        }}
        style={styles.webView}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 260,
    borderColor: "#263037",
    borderWidth: 1,
    borderRadius: 8,
    overflow: "hidden",
    backgroundColor: "#050708",
  },
  webView: {
    flex: 1,
    backgroundColor: "#050708",
  },
});

function createTerminalHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"
  />
  <link rel="stylesheet" href="https://unpkg.com/@xterm/xterm@${XTERM_CDN_VERSION}/css/xterm.css" />
  <style>
    html,
    body,
    #terminal-shell {
      -webkit-touch-callout: default;
      -webkit-user-select: text;
      background: #050708;
      height: 100%;
      margin: 0;
      overflow: hidden;
      padding: 0;
      user-select: text;
      width: 100%;
    }

    #terminal {
      -webkit-touch-callout: default;
      -webkit-user-select: text;
      bottom: ${TERMINAL_VIEW_PADDING + TERMINAL_BOTTOM_SAFETY_PX}px;
      left: ${TERMINAL_VIEW_PADDING}px;
      overflow: hidden;
      position: absolute;
      right: ${TERMINAL_VIEW_PADDING}px;
      top: ${TERMINAL_VIEW_PADDING}px;
      user-select: text;
    }

    .xterm {
      height: 100%;
    }

    .xterm .xterm-cursor-layer {
      display: none !important;
    }

    .xterm .xterm-viewport {
      scrollbar-width: none;
    }

    .xterm .xterm-viewport::-webkit-scrollbar {
      display: none;
      height: 0;
      width: 0;
    }

    .xterm .xterm-scroll-area {
      width: 2px !important;
    }

    .xterm .xterm-scroll-area::after,
    .xterm .xterm-scroll-area::before {
      width: 2px !important;
    }

    .xterm .xterm-scrollable-element .scrollbar.vertical,
    .xterm .xterm-scrollable-element .scrollbar.vertical .slider {
      width: 2px !important;
    }

    .xterm,
    .xterm-rows,
    .xterm-rows span,
    .xterm-screen {
      -webkit-touch-callout: default !important;
      -webkit-user-select: text !important;
      user-select: text !important;
    }
  </style>
</head>
<body>
  <div id="terminal-shell">
    <div id="terminal"></div>
  </div>
  <script src="https://unpkg.com/@xterm/xterm@${XTERM_CDN_VERSION}/lib/xterm.js"></script>
  <script src="https://unpkg.com/@xterm/addon-fit@${FIT_CDN_VERSION}/lib/addon-fit.js"></script>
  <script src="https://unpkg.com/@xterm/addon-web-links@${WEB_LINKS_CDN_VERSION}/lib/addon-web-links.js"></script>
  <script>
    (function () {
      var terminal = new Terminal({
        cols: 80,
        rows: 40,
        fontFamily: 'Menlo, "SF Mono", "Cascadia Code", Consolas, "Roboto Mono", monospace',
        fontSize: 9,
        lineHeight: 1.2,
        cursorBlink: false,
        convertEol: true,
        scrollback: ${TERMINAL_SCROLLBACK},
        theme: {
          background: "#050708",
          foreground: "#d7ffe9",
          cursor: "#d7ffe9",
          cursorAccent: "#050708",
          selectionBackground: "rgba(48, 196, 141, 0.35)"
        }
      });
      var fitAddon = new FitAddon.FitAddon();
      terminal.loadAddon(fitAddon);
      if (window.WebLinksAddon && window.WebLinksAddon.WebLinksAddon) {
        terminal.loadAddon(new WebLinksAddon.WebLinksAddon());
      }
      terminal.open(document.getElementById("terminal"));

      var lastSize = "";
      var pendingFrame = null;
      var userScrolling = false;
      var scrollUnlockTimer = null;
      function post(message) {
        window.ReactNativeWebView.postMessage(JSON.stringify(message));
      }

      function reportSize() {
        var key = terminal.cols + "x" + terminal.rows;
        if (key === lastSize) {
          return;
        }
        lastSize = key;
        post({ type: "resize", cols: terminal.cols, rows: terminal.rows });
      }

      function fit() {
        try {
          var dims = fitAddon.proposeDimensions();
          if (!dims || dims.cols < 2 || dims.rows < 2) {
            return;
          }
          fitAddon.fit();
          reportSize();
        } catch (error) {
          // RN WebView 首次布局期间可能还没有有效尺寸，忽略并等待下一次 fit。
        }
      }

      function setFont(fontSize, lineHeight) {
        var nextFontSize = Number(fontSize) || Number(terminal.options.fontSize) || 9;
        var nextLineHeight = Number(lineHeight) || Number(terminal.options.lineHeight) || 1.2;
        terminal.options.fontSize = nextFontSize;
        terminal.options.lineHeight = nextLineHeight;
        fit();
      }

      var inputEnabled = false;
      function getTextarea() {
        return terminal.textarea || document.querySelector(".xterm-helper-textarea");
      }

      function setInputEnabled(enabled) {
        inputEnabled = !!enabled;
        var textarea = getTextarea();
        if (!textarea) {
          return;
        }
        if (inputEnabled) {
          textarea.removeAttribute("readonly");
          textarea.removeAttribute("inputmode");
          terminal.focus();
          return;
        }
        textarea.setAttribute("readonly", "readonly");
        textarea.setAttribute("inputmode", "none");
        textarea.blur();
      }

      function blurTerminal() {
        var textarea = getTextarea();
        if (textarea) {
          textarea.blur();
        }
        if (document.activeElement && document.activeElement.blur) {
          document.activeElement.blur();
        }
      }

      document.addEventListener("focusin", function (event) {
        if (!inputEnabled && event.target === getTextarea()) {
          blurTerminal();
        }
      });

      function writeFrame(frame) {
        terminal.reset();
        terminal.write(frame || "");
      }

      function flushPendingFrame() {
        if (pendingFrame !== null) {
          var frame = pendingFrame;
          pendingFrame = null;
          writeFrame(frame);
        }
      }

      function lockFrameUpdatesForScroll() {
        userScrolling = true;
        if (scrollUnlockTimer) {
          clearTimeout(scrollUnlockTimer);
        }
        scrollUnlockTimer = setTimeout(function () {
          if (isScrolledAwayFromBottom()) {
            scrollUnlockTimer = null;
            return;
          }
          userScrolling = false;
          scrollUnlockTimer = null;
          flushPendingFrame();
        }, ${SCROLL_LOCK_MS});
      }

      function isScrolledAwayFromBottom() {
        return terminal.buffer.active.viewportY < terminal.buffer.active.baseY;
      }

      function scrollByPixels(deltaY) {
        if (Math.abs(deltaY) < 1) {
          return;
        }
        var lineHeight =
          (Number(terminal.options.fontSize) || 9) *
          (Number(terminal.options.lineHeight) || 1.2);
        var lines = Math.trunc(deltaY / Math.max(1, lineHeight));
        terminal.scrollLines(lines === 0 ? Math.sign(deltaY) : lines);
        lockFrameUpdatesForScroll();
      }

      var terminalElement = document.getElementById("terminal");
      var lastTouchY = null;
      terminalElement.addEventListener("wheel", function (event) {
        event.preventDefault();
        scrollByPixels(event.deltaY);
      }, { passive: false });
      terminalElement.addEventListener("touchstart", function (event) {
        lastTouchY = event.touches[0] ? event.touches[0].clientY : null;
      }, { passive: true });
      terminalElement.addEventListener("touchmove", function (event) {
        var nextY = event.touches[0] ? event.touches[0].clientY : null;
        if (lastTouchY === null || nextY === null) {
          lastTouchY = nextY;
          return;
        }
        event.preventDefault();
        scrollByPixels(lastTouchY - nextY);
        lastTouchY = nextY;
      }, { passive: false });
      terminalElement.addEventListener("touchend", function () {
        lastTouchY = null;
      });
      terminalElement.addEventListener("touchcancel", function () {
        lastTouchY = null;
      });

      terminal.onData(function (data) {
        post({ type: "data", data: data });
      });

      terminal.onResize(function () {
        reportSize();
      });

      window.__omniworkTerminalBridge = function (command) {
        if (!command || !command.type) {
          return;
        }
        if (command.type === "write") {
          if (userScrolling) {
            pendingFrame = command.frame || "";
            return;
          }
          writeFrame(command.frame);
          return;
        }
        if (command.type === "fit") {
          fit();
          return;
        }
        if (command.type === "focus") {
          setInputEnabled(true);
          return;
        }
        if (command.type === "blur") {
          setInputEnabled(false);
          blurTerminal();
          return;
        }
        if (command.type === "setInputEnabled") {
          setInputEnabled(!!command.enabled);
          return;
        }
        if (command.type === "setFont") {
          setFont(command.fontSize, command.lineHeight);
          return;
        }
      };

      window.addEventListener("resize", fit);
      requestAnimationFrame(function () {
        fit();
        setInputEnabled(false);
        post({ type: "ready" });
      });
    })();
  </script>
</body>
</html>`;
}
