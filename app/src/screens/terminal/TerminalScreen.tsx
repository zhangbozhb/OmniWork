import type { JSX } from "react";
import { useEffect, useState } from "react";
import {
  Dimensions,
  Keyboard,
  type KeyboardEvent,
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
} from "../../../../packages/protocol-ts/src/index.ts";
import {
  createControlInput,
  createTextInput,
  sanitizeTerminalText,
  type TerminalControlKey,
} from "../../../../packages/terminal-core/src/index.ts";
import { NativeTerminalView } from "../../terminal/NativeTerminalView";

export interface TerminalScreenProps {
  session: CodexSession;
  frame: string;
  connectionStatus?: TerminalConnectionStatus;
  statusLabel?: string;
  onBack(): void;
  onInput(input: TerminalInputPayload): void;
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

const BOTTOM_DOCK_HEIGHT = 128;

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
  onInput,
}: TerminalScreenProps): JSX.Element {
  const [draft, setDraft] = useState("");
  const [keyboardBottomInset, setKeyboardBottomInset] = useState(0);
  const agentStatus = getAgentStatusPresentation(connectionStatus);

  useEffect(() => {
    if (Platform.OS !== "ios") {
      return undefined;
    }

    const changeSubscription = Keyboard.addListener(
      "keyboardWillChangeFrame",
      (event) => {
        setKeyboardBottomInset(getKeyboardBottomInset(event));
      },
    );
    const hideSubscription = Keyboard.addListener("keyboardWillHide", () => {
      setKeyboardBottomInset(0);
    });

    return () => {
      changeSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  function sendDraft(): void {
    const normalizedDraft = sanitizeTerminalText(draft.trimEnd());
    if (!normalizedDraft) {
      return;
    }
    onInput(createTextInput(`${normalizedDraft}\r`));
    setDraft("");
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
      </View>

      <View
        style={[
          styles.terminalArea,
          { marginBottom: BOTTOM_DOCK_HEIGHT + keyboardBottomInset },
        ]}
      >
        <NativeTerminalView frame={frame} />
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
          <Pressable style={styles.keyButton} onPress={Keyboard.dismiss}>
            <Text style={styles.keyButtonText}>Hide</Text>
          </Pressable>
          <Pressable
            disabled={!draft}
            style={[styles.keyButton, !draft && styles.disabled]}
            onPress={() => setDraft("")}
          >
            <Text style={styles.keyButtonText}>Clear</Text>
          </Pressable>
        </ScrollView>

        <View style={styles.composer}>
          <Text style={styles.composerHint}>
            Compose prompt, then send it to Codex TUI
          </Text>
          <View style={styles.inputRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              autoCapitalize="none"
              autoCorrect={false}
              blurOnSubmit={false}
              multiline
              placeholder="Ask Codex to inspect, edit, test, or explain..."
              placeholderTextColor="#66727c"
              returnKeyType="default"
              scrollEnabled
              style={styles.input}
            />
            <Pressable
              disabled={!draft.trim()}
              style={[styles.sendButton, !draft.trim() && styles.disabled]}
              onPress={sendDraft}
            >
              <Text style={styles.sendText}>Send</Text>
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
  disabled: {
    opacity: 0.45,
  },
  sendText: {
    color: "#08110d",
    fontWeight: "800",
  },
});
