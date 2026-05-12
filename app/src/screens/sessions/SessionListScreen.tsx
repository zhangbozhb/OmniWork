import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { CodexSession } from "../../../../packages/protocol-ts/src/index.ts";

export interface SessionListScreenProps {
  sessions: CodexSession[];
  creating: boolean;
  onBack(): void;
  onCreateSession(): void;
  onOpenSession(session: CodexSession): void;
}

export function SessionListScreen({
  sessions,
  creating,
  onBack,
  onCreateSession,
  onOpenSession,
}: SessionListScreenProps): JSX.Element {
  return (
    <View style={styles.screen}>
      <View style={styles.actions}>
        <Pressable style={styles.secondaryButton} onPress={onBack}>
          <Text style={styles.secondaryText}>Devices</Text>
        </Pressable>
        <Pressable disabled={creating} style={[styles.primaryButton, creating && styles.disabled]} onPress={onCreateSession}>
          <Text style={styles.primaryText}>{creating ? "Starting..." : "New Codex"}</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.list}>
        {sessions.length === 0 ? (
          <Text style={styles.empty}>No sessions yet.</Text>
        ) : (
          sessions.map((session) => (
            <Pressable key={session.session_id} style={styles.sessionCard} onPress={() => onOpenSession(session)}>
              <Text style={styles.sessionTitle}>{session.title}</Text>
              <Text style={styles.sessionMeta}>{session.cwd}</Text>
              <Text style={styles.sessionStatus}>{session.status}</Text>
            </Pressable>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    padding: 18,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 12,
  },
  primaryButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#30c48d",
  },
  secondaryButton: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    borderColor: "#34424c",
    borderWidth: 1,
  },
  primaryText: {
    color: "#08110d",
    fontWeight: "800",
  },
  secondaryText: {
    color: "#d7dde2",
    fontWeight: "700",
  },
  disabled: {
    opacity: 0.55,
  },
  list: {
    gap: 10,
  },
  empty: {
    color: "#94a3ad",
    textAlign: "center",
    marginTop: 40,
  },
  sessionCard: {
    borderColor: "#34424c",
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    backgroundColor: "#151c21",
  },
  sessionTitle: {
    color: "#f5f7f8",
    fontSize: 16,
    fontWeight: "700",
  },
  sessionMeta: {
    color: "#94a3ad",
    marginTop: 4,
  },
  sessionStatus: {
    color: "#30c48d",
    marginTop: 8,
    fontWeight: "700",
  },
});
