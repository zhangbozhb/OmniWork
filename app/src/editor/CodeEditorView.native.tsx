import {
  forwardRef,
  type JSX,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { StyleSheet, View } from "react-native";
import type { WebViewMessageEvent } from "react-native-webview";
import { WebView } from "react-native-webview";

import { CODE_MIRROR_EDITOR_JS } from "./codeMirrorWebViewAssets";
import type {
  CodeEditorChange,
  CodeEditorViewHandle,
  CodeEditorViewProps,
} from "./codeEditorTypes";

export type { CodeEditorViewHandle, CodeEditorViewProps } from "./codeEditorTypes";

type BridgeMessage =
  | { type: "ready" }
  | ({ type: "change" } & CodeEditorChange)
  | { type: "content"; requestId: string; value: string };

export const CodeEditorView = forwardRef<CodeEditorViewHandle, CodeEditorViewProps>(
  function CodeEditorView({ editable, path, value, onChange }, ref): JSX.Element {
    const webViewRef = useRef<WebView>(null);
    const readyRef = useRef(false);
    const onChangeRef = useRef(onChange);
    const currentPathRef = useRef(path);
    const currentEditableRef = useRef(editable);
    const lastAppliedValueRef = useRef(value);
    const pendingContentRequestsRef = useRef(
      new Map<string, (value: string | undefined) => void>(),
    );

    onChangeRef.current = onChange;
    currentPathRef.current = path;
    currentEditableRef.current = editable;

    const html = useMemo(() => createCodeMirrorHtml(), []);

    const sendBridgeCommand = useCallback((command: unknown) => {
      const script = `window.__omniworkCodeEditorBridge && window.__omniworkCodeEditorBridge(${JSON.stringify(
        command,
      )}); true;`;
      webViewRef.current?.injectJavaScript(script);
    }, []);

    const setDocument = useCallback(
      (nextValue: string, nextPath: string, nextEditable: boolean) => {
        lastAppliedValueRef.current = nextValue;
        if (!readyRef.current) {
          return;
        }
        sendBridgeCommand({
          type: "setDocument",
          value: nextValue,
          path: nextPath,
          editable: nextEditable,
        });
      },
      [sendBridgeCommand],
    );

    useImperativeHandle(ref, () => ({
      focus() {
        sendBridgeCommand({ type: "focus" });
      },
      goToChange(direction: "next" | "previous") {
        sendBridgeCommand({ type: "goToChange", direction });
      },
      indentLess() {
        sendBridgeCommand({ type: "indentLess" });
      },
      indentMore() {
        sendBridgeCommand({ type: "indentMore" });
      },
      insertText(text: string) {
        sendBridgeCommand({ type: "insertText", text });
      },
      openSearch() {
        sendBridgeCommand({ type: "openSearch" });
      },
      requestContent() {
        const requestId = `content_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        return new Promise<string | undefined>((resolve) => {
          const timeout = setTimeout(() => {
            pendingContentRequestsRef.current.delete(requestId);
            resolve(undefined);
          }, 1200);
          pendingContentRequestsRef.current.set(requestId, (nextValue) => {
            clearTimeout(timeout);
            resolve(nextValue);
          });
          sendBridgeCommand({ type: "requestContent", requestId });
        });
      },
      redo() {
        sendBridgeCommand({ type: "redo" });
      },
      undo() {
        sendBridgeCommand({ type: "undo" });
      },
    }));

    useEffect(() => {
      if (value === lastAppliedValueRef.current) {
        return;
      }
      setDocument(value, path, editable);
    }, [editable, path, setDocument, value]);

    useEffect(() => {
      if (!readyRef.current) {
        return;
      }
      sendBridgeCommand({ type: "setEditable", editable });
    }, [editable, sendBridgeCommand]);

    useEffect(() => {
      if (!readyRef.current) {
        return;
      }
      sendBridgeCommand({ type: "setLanguage", path });
    }, [path, sendBridgeCommand]);

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
          setDocument(
            lastAppliedValueRef.current,
            currentPathRef.current,
            currentEditableRef.current,
          );
          return;
        }

        if (message.type === "change") {
          onChangeRef.current({
            changedLines: message.changedLines,
            dirty: message.dirty,
          });
          return;
        }

        if (message.type === "content") {
          lastAppliedValueRef.current = message.value;
          const resolve = pendingContentRequestsRef.current.get(message.requestId);
          if (resolve) {
            pendingContentRequestsRef.current.delete(message.requestId);
            resolve(message.value);
          }
        }
      },
      [setDocument],
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
          style={styles.webView}
        />
      </View>
    );
  },
);

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 260,
    overflow: "hidden",
  },
  webView: {
    flex: 1,
    backgroundColor: "#151c21",
  },
});

function createCodeMirrorHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"
  />
  <style>
    html,
    body,
    #editor {
      background: #151c21;
      height: 100%;
      margin: 0;
      overflow: hidden;
      padding: 0;
      width: 100%;
    }
  </style>
</head>
<body>
  <div id="editor"></div>
  <script>${inlineScript(CODE_MIRROR_EDITOR_JS)}</script>
</body>
</html>`;
}

function inlineScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}
