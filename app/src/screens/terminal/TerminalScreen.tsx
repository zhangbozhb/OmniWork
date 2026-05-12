import type { JSX } from "react";
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import type { CodexSession, TerminalInputPayload } from "../../../../packages/protocol-ts/src/index.ts";
import { createControlInput, createTextInput, type TerminalControlKey } from "../../../../packages/terminal-core/src/index.ts";
import { NativeTerminalView } from "../../terminal/NativeTerminalView";

export interface TerminalScreenProps {
  session: CodexSession;
  frame: string;
  status?: string;
  onBack(): void;
  onInput(input: TerminalInputPayload): void;
}

const QUICK_KEYS: Array<{ label: string; key: TerminalControlKey }> = [
  { label: "Esc", key: "escape" },
  { label: "Tab", key: "tab" },
  { label: "↑", key: "arrowUp" },
  { label: "↓", key: "arrowDown" },
  { label: "←", key: "arrowLeft" },
  { label: "→", key: "arrowRight" },
  { label: "Ctrl+C", key: "ctrlC" },
  { label: "Ctrl+D", key: "ctrlD" },
];

export function TerminalScreen({ session, frame, status, onBack, onInput }: TerminalScreenProps): JSX.Element {
  const [draft, setDraft] = useState("");

  function sendDraft(): void {
    if (!draft) {
      return;
    }
    onInput(createTextInput(`${draft}\r`));
    setDraft("");
  }

  return (
    <View style={styles.screen}>
      <View style={styles.toolbar}>
        <Pressable style={styles.backButton} onPress={onBack}>
          <Text style={styles.backText}>Sessions</Text>
        </Pressable>
        <Text style={styles.meta}>{session.cwd}</Text>
        {status ? <Text style={styles.status}>{status}</Text> : null}
      </View>

      <NativeTerminalView frame={frame} />

      <View style={styles.quickKeys}>
        {QUICK_KEYS.map((item) => (
          <Pressable key={item.key} style={styles.keyButton} onPress={() => onInput(createControlInput(item.key))}>
            <Text style={styles.keyButtonText}>{item.label}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.inputRow}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Send prompt to Codex"
          placeholderTextColor="#66727c"
          style={styles.input}
          onSubmitEditing={sendDraft}
        />
        <Pressable style={styles.sendButton} onPress={sendDraft}>
          <Text style={styles.sendText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    padding: 12,
    gap: 10,
  },
  toolbar: {
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
  status: {
    color: "#30c48d",
    fontSize: 12,
    fontWeight: "800",
  },
  quickKeys: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
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
  inputRow: {
    flexDirection: "row",
    gap: 8,
  },
  input: {
    flex: 1,
    minHeight: 44,
    borderColor: "#34424c",
    borderWidth: 1,
    borderRadius: 8,
    color: "#f5f7f8",
    paddingHorizontal: 12,
    backgroundColor: "#151c21",
  },
  sendButton: {
    minHeight: 44,
    borderRadius: 8,
    backgroundColor: "#30c48d",
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  sendText: {
    color: "#08110d",
    fontWeight: "800",
  },
});
