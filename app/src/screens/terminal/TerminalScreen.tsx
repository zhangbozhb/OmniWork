import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dimensions,
  Keyboard,
  type KeyboardEvent,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import type {
  CodexSession,
  TerminalInputPayload,
  TerminalResizePayload,
} from "../../../../packages/protocol-ts/src/index.ts";
import {
  createControlInput,
  createTextInput,
  sanitizeTerminalText,
  type TerminalControlKey,
} from "../../../../packages/terminal-core/src/index.ts";
import {
  computeTerminalLayout,
  getDefaultTerminalDisplayProfile,
  type TerminalDisplayProfile,
  type TerminalViewport,
} from "../../features/terminal/terminalLayout";
import { NativeTerminalView } from "../../terminal/NativeTerminalView";

export interface TerminalScreenProps {
  session: CodexSession;
  frame: string;
  connectionStatus?: TerminalConnectionStatus;
  statusLabel?: string;
  onBack(): void;
  onKillTmux(): void;
  onInput(input: TerminalInputPayload): void;
  onResize(size: TerminalResizePayload): void;
}

type TerminalConnectionStatus =
  | "idle"
  | "connecting"
  | "authenticating"
  | "authenticated"
  | "failed";

const QUICK_KEYS: Array<{ label: string; key: TerminalControlKey }> = [
  { label: "Esc", key: "escape" },
  { label: "Tab", key: "tab" },
  { label: "Enter", key: "enter" },
  { label: "⌫", key: "backspace" },
  { label: "↑", key: "arrowUp" },
  { label: "↓", key: "arrowDown" },
  { label: "←", key: "arrowLeft" },
  { label: "→", key: "arrowRight" },
  { label: "Ctrl+C", key: "ctrlC" },
  { label: "Ctrl+D", key: "ctrlD" },
  { label: "Ctrl+L", key: "ctrlL" },
];

const BOTTOM_DOCK_HEIGHT = 178;
const PROFILE_OPTIONS: Array<{ key: TerminalDisplayProfile; label: string }> = [
  { key: "readableScroll", label: "Readable" },
  { key: "fitPreview", label: "Fit" },
  { key: "landscapeWide", label: "Wide" },
];

function getKeyboardBottomInset(event: KeyboardEvent): number {
  return Math.max(
    0,
    Dimensions.get("window").height - event.endCoordinates.screenY,
  );
}

export function TerminalScreen({
  session,
  frame,
  connectionStatus = "idle",
  statusLabel,
  onBack,
  onKillTmux,
  onInput,
  onResize,
}: TerminalScreenProps): JSX.Element {
  const [draft, setDraft] = useState("");
  const [keyboardBottomInset, setKeyboardBottomInset] = useState(0);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [terminalViewport, setTerminalViewport] = useState<TerminalViewport>({
    width: Dimensions.get("window").width,
    height: Math.max(260, Dimensions.get("window").height - 260),
  });
  const [profile, setProfile] = useState<TerminalDisplayProfile>(() =>
    getDefaultTerminalDisplayProfile(Dimensions.get("window")),
  );
  const lastResizeKeyRef = useRef("");
  const agentStatus = getAgentStatusPresentation(connectionStatus);
  const runtimeLabel = session.runtime_label;
  const hasDraft = draft.trim().length > 0;
  const canHideKeyboard = keyboardVisible && !hasDraft;
  const terminalLayout = useMemo(
    () => computeTerminalLayout(terminalViewport, profile),
    [profile, terminalViewport],
  );

  useEffect(() => {
    if (Platform.OS !== "ios") {
      return undefined;
    }

    const changeSubscription = Keyboard.addListener(
      "keyboardWillChangeFrame",
      (event) => {
        const inset = getKeyboardBottomInset(event);
        setKeyboardBottomInset(inset);
        setKeyboardVisible(inset > 0);
      },
    );
    const hideSubscription = Keyboard.addListener("keyboardWillHide", () => {
      setKeyboardBottomInset(0);
      setKeyboardVisible(false);
    });

    return () => {
      changeSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  useEffect(() => {
    const subscription = Dimensions.addEventListener("change", ({ window }) => {
      setProfile((currentProfile) => {
        if (currentProfile === "fitPreview") {
          return currentProfile;
        }
        return getDefaultTerminalDisplayProfile(window);
      });
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const size = terminalLayout.terminalSize;
    const resizeKey = `${session.session_id}:${size.cols}x${size.rows}`;
    if (lastResizeKeyRef.current === resizeKey) {
      return undefined;
    }

    const timer = setTimeout(() => {
      lastResizeKeyRef.current = resizeKey;
      onResize(size);
    }, 400);

    return () => clearTimeout(timer);
  }, [onResize, session.session_id, terminalLayout.terminalSize]);

  function sendDraft(): void {
    const normalizedDraft = sanitizeTerminalText(draft.trimEnd());
    if (!normalizedDraft) {
      return;
    }
    onInput(createTextInput(`${normalizedDraft}\r`));
    setDraft("");
  }

  function handlePrimaryComposerAction(): void {
    if (hasDraft) {
      sendDraft();
      return;
    }

    if (canHideKeyboard) {
      Keyboard.dismiss();
    }
  }

  function handleTerminalAreaLayout(event: LayoutChangeEvent): void {
    const { width, height } = event.nativeEvent.layout;
    setTerminalViewport({
      width: Math.max(1, width),
      height: Math.max(1, height),
    });
  }

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <Pressable style={styles.backButton} onPress={onBack}>
          <Text style={styles.backText}>Sessions</Text>
        </Pressable>
        <Pressable
          accessibilityLabel={statusLabel ?? agentStatus.accessibilityLabel}
          style={styles.sessionMetaArea}
          onPress={Keyboard.dismiss}
        >
          <Text numberOfLines={1} style={styles.meta}>
            {formatCompactPath(session.cwd)}
          </Text>
          <Text style={[styles.statusIcon, { color: agentStatus.color }]}>
            {agentStatus.icon}
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Kill tmux session"
          style={styles.killButton}
          onPress={onKillTmux}
        >
          <Text style={styles.killText}>×</Text>
        </Pressable>
      </View>

      <View
        style={[
          styles.terminalArea,
          { marginBottom: BOTTOM_DOCK_HEIGHT + keyboardBottomInset },
        ]}
        onLayout={handleTerminalAreaLayout}
      >
        <NativeTerminalView
          frame={frame}
          layout={terminalLayout}
          terminalSize={terminalLayout.terminalSize}
        />
      </View>

      <View
        style={[
          styles.bottomDock,
          { bottom: keyboardBottomInset > 0 ? keyboardBottomInset : 12 },
        ]}
      >
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
          style={styles.quickKeys}
          contentContainerStyle={styles.quickKeysContent}
        >
          {QUICK_KEYS.map((item) => (
            <Pressable
              key={item.key}
              style={styles.keyButton}
              onPress={() => onInput(createControlInput(item.key))}
            >
              <Text style={styles.keyButtonText}>{item.label}</Text>
            </Pressable>
          ))}
          <Pressable
            disabled={!draft}
            style={[styles.keyButton, !draft && styles.disabled]}
            onPress={() => setDraft("")}
          >
            <Text style={styles.keyButtonText}>Clear</Text>
          </Pressable>
        </ScrollView>

        <View style={styles.profileRow}>
          {PROFILE_OPTIONS.map((item) => {
            const selected = profile === item.key;
            return (
              <Pressable
                key={item.key}
                style={[
                  styles.profileButton,
                  selected && styles.profileSelected,
                ]}
                onPress={() => setProfile(item.key)}
              >
                <Text
                  style={[
                    styles.profileButtonText,
                    selected && styles.profileSelectedText,
                  ]}
                >
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
          <Text style={styles.gridMeta}>
            {terminalLayout.terminalSize.cols}x
            {terminalLayout.terminalSize.rows}
            {" · "}
            {Math.round(terminalLayout.fontSize * 10) / 10}
            {Platform.OS === "ios" ? "pt" : "sp"}
          </Text>
        </View>

        {terminalLayout.fitLimited ? (
          <Text style={styles.fitNotice}>
            Fit would make text too small; horizontal scrolling keeps it
            readable.
          </Text>
        ) : null}

        <View style={styles.composer}>
          <Text style={styles.composerHint}>
            Compose prompt, then send it to {runtimeLabel} TUI
          </Text>
          <View style={styles.inputRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              placeholder={`Ask ${runtimeLabel} to inspect, edit, test, or explain...`}
              placeholderTextColor="#66727c"
              returnKeyType="default"
              scrollEnabled
              submitBehavior="newline"
              style={styles.input}
            />
            <Pressable
              disabled={!hasDraft && !canHideKeyboard}
              style={[
                styles.sendButton,
                canHideKeyboard && styles.sendButtonSecondary,
                !hasDraft && !canHideKeyboard && styles.disabled,
              ]}
              onPress={handlePrimaryComposerAction}
            >
              <Text
                style={[
                  styles.sendText,
                  canHideKeyboard && styles.sendTextSecondary,
                ]}
              >
                {canHideKeyboard ? "Hide" : "Send"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

function formatCompactPath(path: string): string {
  const trimmedPath = path.trim();
  if (!trimmedPath) {
    return "";
  }

  const normalizedPath = trimmedPath.replace(/\/+$/g, "") || "/";
  const parts = normalizedPath.split("/").filter(Boolean);
  if (parts.length <= 2) {
    return normalizedPath;
  }

  const prefix = normalizedPath.startsWith("/") ? `/${parts[0]}` : parts[0];
  return `${prefix}/…/${parts[parts.length - 1]}`;
}

function getAgentStatusPresentation(status: TerminalConnectionStatus): {
  accessibilityLabel: string;
  color: string;
  icon: string;
} {
  switch (status) {
    case "authenticated":
      return {
        accessibilityLabel: "Agent connected",
        color: "#30c48d",
        icon: "●",
      };
    case "connecting":
    case "authenticating":
      return {
        accessibilityLabel: "Agent connecting",
        color: "#f4c95d",
        icon: "◐",
      };
    case "failed":
      return {
        accessibilityLabel: "Agent disconnected",
        color: "#ff8d8d",
        icon: "×",
      };
    case "idle":
    default:
      return { accessibilityLabel: "Agent idle", color: "#66727c", icon: "○" };
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingHorizontal: 12,
    paddingTop: 12,
    gap: 10,
  },
  terminalArea: {
    flex: 1,
  },
  bottomDock: {
    position: "absolute",
    left: 12,
    right: 12,
    gap: 8,
    paddingTop: 8,
    backgroundColor: "#101417",
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  sessionMetaArea: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  backButton: {
    borderColor: "#34424c",
    borderWidth: 1,
    borderRadius: 8,
    minHeight: 38,
    justifyContent: "center",
    paddingHorizontal: 12,
  },
  backText: {
    color: "#d7dde2",
    fontWeight: "700",
  },
  meta: {
    color: "#94a3ad",
    flex: 1,
  },
  statusIcon: {
    fontSize: 18,
    fontWeight: "800",
    minWidth: 24,
    textAlign: "right",
  },
  killButton: {
    width: 38,
    minHeight: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    borderColor: "#5b3030",
    borderWidth: 1,
    backgroundColor: "#2a1517",
  },
  killText: {
    color: "#ff8d8d",
    fontSize: 22,
    fontWeight: "800",
    lineHeight: 24,
  },
  quickKeys: {
    flexGrow: 0,
  },
  quickKeysContent: {
    gap: 8,
    paddingRight: 4,
  },
  keyButton: {
    minWidth: 52,
    minHeight: 36,
    borderRadius: 8,
    borderColor: "#34424c",
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#151c21",
  },
  keyButtonText: {
    color: "#d7dde2",
    fontWeight: "700",
  },
  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  profileButton: {
    minHeight: 30,
    borderRadius: 8,
    borderColor: "#34424c",
    borderWidth: 1,
    justifyContent: "center",
    paddingHorizontal: 10,
    backgroundColor: "#151c21",
  },
  profileSelected: {
    borderColor: "#30c48d",
    backgroundColor: "#1a3028",
  },
  profileButtonText: {
    color: "#94a3ad",
    fontSize: 12,
    fontWeight: "800",
  },
  profileSelectedText: {
    color: "#d7ffe9",
  },
  gridMeta: {
    color: "#66727c",
    flex: 1,
    fontSize: 12,
    textAlign: "right",
  },
  fitNotice: {
    color: "#f4c95d",
    fontSize: 12,
  },
  composer: {
    gap: 6,
  },
  composerHint: {
    color: "#94a3ad",
    fontSize: 12,
  },
  inputRow: {
    flexDirection: "row",
    gap: 8,
    alignItems: "flex-end",
  },
  input: {
    flex: 1,
    minHeight: 48,
    maxHeight: 112,
    borderColor: "#34424c",
    borderWidth: 1,
    borderRadius: 8,
    color: "#f5f7f8",
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 12,
    backgroundColor: "#151c21",
    textAlignVertical: "top",
  },
  sendButton: {
    minHeight: 44,
    borderRadius: 8,
    backgroundColor: "#30c48d",
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonSecondary: {
    backgroundColor: "#1d272d",
    borderColor: "#34424c",
    borderWidth: 1,
  },
  disabled: {
    opacity: 0.45,
  },
  sendText: {
    color: "#08110d",
    fontWeight: "800",
  },
  sendTextSecondary: {
    color: "#d7dde2",
  },
});
