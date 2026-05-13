import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { CodexSession } from "../../../../packages/protocol-ts/src/index.ts";

export interface SessionListScreenProps {
  sessions: CodexSession[];
  creating: boolean;
  closingSessionIds?: string[];
  onBack(): void;
  onCreateSession(): void;
  onOpenSession(session: CodexSession): void;
  onCloseSession(session: CodexSession): void;
}

export function SessionListScreen({
  sessions,
  creating,
  closingSessionIds = [],
  onBack,
  onCreateSession,
  onOpenSession,
  onCloseSession,
}: SessionListScreenProps): JSX.Element {
  return (
    <View style={styles.screen}>
      <View style={styles.actions}>
        <Pressable style={styles.secondaryButton} onPress={onBack}>
          <Text style={styles.secondaryText}>Devices</Text>
        </Pressable>
        <Pressable
          disabled={creating}
          style={[styles.primaryButton, creating && styles.disabled]}
          onPress={onCreateSession}
        >
          <Text style={styles.primaryText}>
            {creating ? "Starting..." : "New Codex"}
          </Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.list}>
        {sessions.length === 0 ? (
          <Text style={styles.empty}>No sessions yet.</Text>
        ) : (
          sessions.map((session) => {
            const closing = closingSessionIds.includes(session.session_id);
            return (
              <View key={session.session_id} style={styles.sessionCard}>
                <Pressable
                  style={styles.sessionMain}
                  onPress={() => onOpenSession(session)}
                >
                  <Text style={styles.sessionTitle}>{session.title}</Text>
                  <Text numberOfLines={1} style={styles.sessionMeta}>
                    {formatCompactPath(session.cwd)}
                  </Text>
                  <View style={styles.sessionDetails}>
                    <Text style={styles.sessionStatus}>{session.status}</Text>
                    <Text style={styles.sessionTime}>
                      Active {formatRelativeTime(session.last_active_at)}
                    </Text>
                  </View>
                  <Text style={styles.sessionCreated}>
                    Created {formatAbsoluteTime(session.created_at)}
                  </Text>
                </Pressable>
                <Pressable
                  disabled={closing}
                  style={[styles.closeButton, closing && styles.disabled]}
                  onPress={() => onCloseSession(session)}
                >
                  <Text style={styles.closeText}>
                    {closing ? "Closing..." : "Close Session"}
                  </Text>
                </Pressable>
              </View>
            );
          })
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
    backgroundColor: "#151c21",
    overflow: "hidden",
  },
  sessionMain: {
    padding: 14,
  },
  closeButton: {
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center",
    borderTopColor: "#263037",
    borderTopWidth: StyleSheet.hairlineWidth,
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
    fontWeight: "700",
    textTransform: "capitalize",
  },
  sessionDetails: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginTop: 8,
  },
  sessionTime: {
    color: "#d7dde2",
    fontSize: 12,
    fontWeight: "700",
  },
  sessionCreated: {
    color: "#66727c",
    fontSize: 12,
    marginTop: 6,
  },
  closeText: {
    color: "#ff8d8d",
    fontWeight: "800",
  },
});

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

function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "unknown";
  }

  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSeconds < 60) {
    return "just now";
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function formatAbsoluteTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}
