import { type JSX, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import type {
  CodexSession,
  RuntimeKind,
} from "../../../../packages/protocol-ts/src/index.ts";

type CreatableRuntimeKind = Extract<RuntimeKind, "claude" | "codex">;

export interface SessionListScreenProps {
  sessions: CodexSession[];
  creating: boolean;
  closingSessionIds?: string[];
  killingSessionIds?: string[];
  defaultCwd: string;
  onBack(): void;
  onRefreshSessions(): void;
  onCreateSession(input: {
    cwd: string;
    runtimeKind: CreatableRuntimeKind;
  }): void;
  onOpenSession(session: CodexSession): void;
  onCloseSession(session: CodexSession): void;
  onKillTmuxSession(session: CodexSession): void;
}

const RUNTIME_GROUPS: Array<{
  kind: RuntimeKind;
  label: string;
  creatable: boolean;
}> = [
  { kind: "claude", label: "Claude", creatable: true },
  { kind: "codex", label: "Codex", creatable: true },
  { kind: "other", label: "Other", creatable: false },
];

export function SessionListScreen({
  sessions,
  creating,
  closingSessionIds = [],
  killingSessionIds = [],
  defaultCwd,
  onBack,
  onRefreshSessions,
  onCreateSession,
  onOpenSession,
  onCloseSession,
  onKillTmuxSession,
}: SessionListScreenProps): JSX.Element {
  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [createCwd, setCreateCwd] = useState(defaultCwd);
  const [createRuntimeKind, setCreateRuntimeKind] =
    useState<CreatableRuntimeKind>("claude");

  function openCreateModal(runtimeKind: CreatableRuntimeKind): void {
    setCreateRuntimeKind(runtimeKind);
    setCreateCwd(defaultCwd);
    setCreateModalVisible(true);
  }

  function confirmCreateSession(): void {
    const cwd = createCwd.trim();
    if (!cwd) {
      return;
    }
    setCreateModalVisible(false);
    onCreateSession({ cwd, runtimeKind: createRuntimeKind });
  }

  const visibleGroups = RUNTIME_GROUPS.filter((group) => {
    if (group.creatable) {
      return true;
    }

    return sessions.some(
      (session) => getRuntimeGroupKind(session) === group.kind,
    );
  });

  return (
    <View style={styles.screen}>
      <View style={styles.actions}>
        <Pressable style={styles.secondaryButton} onPress={onBack}>
          <Text style={styles.secondaryText}>Devices</Text>
        </Pressable>
        <View style={styles.toolbarTitleArea}>
          <Text style={styles.toolbarTitle}>Sessions</Text>
          <Text style={styles.toolbarMeta}>
            {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
          </Text>
        </View>
        <Pressable style={styles.secondaryButton} onPress={onRefreshSessions}>
          <Text style={styles.secondaryText}>Refresh</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.list}>
        {visibleGroups.map((group) => {
          const groupSessions = sessions.filter(
            (session) => getRuntimeGroupKind(session) === group.kind,
          );
          return (
            <View key={group.kind} style={styles.runtimeSection}>
              <View style={styles.sectionHeader}>
                <View>
                  <Text style={styles.sectionTitle}>{group.label}</Text>
                  <Text style={styles.sectionMeta}>
                    {groupSessions.length}{" "}
                    {groupSessions.length === 1 ? "session" : "sessions"}
                  </Text>
                </View>
                {group.creatable ? (
                  <Pressable
                    disabled={creating}
                    style={[
                      styles.sectionCreateButton,
                      creating && styles.disabled,
                    ]}
                    onPress={() =>
                      openCreateModal(group.kind as CreatableRuntimeKind)
                    }
                  >
                    <Text style={styles.primaryText}>
                      {creating && createRuntimeKind === group.kind
                        ? "Starting..."
                        : "New"}
                    </Text>
                  </Pressable>
                ) : null}
              </View>

              {groupSessions.length === 0 ? (
                <Text style={styles.empty}>No {group.label} sessions yet.</Text>
              ) : (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.sessionRow}
                >
                  {groupSessions.map((session) => {
                    const closing = closingSessionIds.includes(
                      session.session_id,
                    );
                    const killing = killingSessionIds.includes(
                      session.session_id,
                    );
                    const external = session.origin === "external";
                    const registered = session.registered !== false;
                    return (
                      <View key={session.session_id} style={styles.sessionCard}>
                        <Pressable
                          disabled={killing || closing}
                          accessibilityLabel="Kill tmux session"
                          style={[
                            styles.cardKillButton,
                            (killing || closing) && styles.disabled,
                          ]}
                          onPress={() => onKillTmuxSession(session)}
                        >
                          <Text style={styles.cardKillText}>
                            {killing ? "…" : "×"}
                          </Text>
                        </Pressable>
                        <Pressable
                          style={styles.sessionMain}
                          onPress={() => onOpenSession(session)}
                        >
                          <Text numberOfLines={1} style={styles.sessionTitle}>
                            {session.title}
                          </Text>
                          {external ? (
                            <Text style={styles.originBadge}>
                              {registered ? "Attached tmux" : "Existing tmux"}
                            </Text>
                          ) : null}
                          <Text
                            ellipsizeMode="middle"
                            numberOfLines={1}
                            style={styles.sessionMetaText}
                          >
                            {session.cwd}
                          </Text>
                          <View style={styles.sessionDetails}>
                            <Text style={styles.sessionStatus}>
                              {external && !registered
                                ? "attachable"
                                : session.status}
                            </Text>
                            <Text style={styles.sessionTime}>
                              Active{" "}
                              {formatRelativeTime(session.last_active_at)}
                            </Text>
                          </View>
                          <Text style={styles.sessionCreated}>
                            Created {formatAbsoluteTime(session.created_at)}
                          </Text>
                        </Pressable>
                        {registered ? (
                          <Pressable
                            disabled={closing || killing}
                            style={[
                              styles.closeButton,
                              (closing || killing) && styles.disabled,
                            ]}
                            onPress={() => onCloseSession(session)}
                          >
                            <Text style={styles.closeText}>
                              {closing
                                ? "Closing..."
                                : external
                                  ? "Forget tmux"
                                  : "Close Session"}
                            </Text>
                          </Pressable>
                        ) : (
                          <View style={styles.closeButton}>
                            <Text style={styles.attachHint}>Tap to attach</Text>
                          </View>
                        )}
                      </View>
                    );
                  })}
                </ScrollView>
              )}
            </View>
          );
        })}
      </ScrollView>

      <Modal
        transparent
        animationType="fade"
        visible={createModalVisible}
        onRequestClose={() => setCreateModalVisible(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              New {getRuntimeLabel(createRuntimeKind)} Session
            </Text>
            <Text style={styles.modalDescription}>
              Confirm or edit the working directory before creating.
            </Text>
            <TextInput
              value={createCwd}
              onChangeText={setCreateCwd}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Working directory"
              placeholderTextColor="#66727c"
              style={styles.cwdInput}
            />
            <View style={styles.modalActions}>
              <Pressable
                style={styles.modalSecondaryButton}
                onPress={() => setCreateModalVisible(false)}
              >
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>
              <Pressable
                disabled={!createCwd.trim() || creating}
                style={[
                  styles.modalPrimaryButton,
                  (!createCwd.trim() || creating) && styles.disabled,
                ]}
                onPress={confirmCreateSession}
              >
                <Text style={styles.primaryText}>
                  {creating ? "Starting..." : "Create"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
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
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 12,
  },
  toolbarTitleArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  toolbarTitle: {
    color: "#f5f7f8",
    fontSize: 17,
    fontWeight: "800",
  },
  toolbarMeta: {
    color: "#94a3ad",
    fontSize: 12,
    marginTop: 2,
  },
  secondaryButton: {
    minHeight: 38,
    minWidth: 86,
    paddingHorizontal: 12,
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
    gap: 18,
  },
  runtimeSection: {
    gap: 10,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  sectionTitle: {
    color: "#f5f7f8",
    fontSize: 18,
    fontWeight: "800",
  },
  sectionMeta: {
    color: "#94a3ad",
    fontSize: 12,
    marginTop: 2,
  },
  sectionCreateButton: {
    minHeight: 38,
    minWidth: 72,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#30c48d",
  },
  sessionRow: {
    gap: 10,
    paddingRight: 2,
  },
  empty: {
    color: "#94a3ad",
    borderColor: "#263037",
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
  },
  sessionCard: {
    borderColor: "#34424c",
    borderWidth: 1,
    borderRadius: 8,
    backgroundColor: "#151c21",
    overflow: "hidden",
    position: "relative",
    width: 260,
  },
  cardKillButton: {
    position: "absolute",
    right: 8,
    top: 8,
    zIndex: 2,
    width: 30,
    minHeight: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    borderColor: "#5b3030",
    borderWidth: 1,
    backgroundColor: "#2a1517",
  },
  cardKillText: {
    color: "#ff8d8d",
    fontSize: 20,
    fontWeight: "800",
    lineHeight: 22,
  },
  sessionMain: {
    padding: 14,
    paddingRight: 46,
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
  originBadge: {
    alignSelf: "flex-start",
    marginTop: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: "hidden",
    color: "#f4c95d",
    fontSize: 11,
    fontWeight: "800",
    backgroundColor: "rgba(244, 201, 93, 0.16)",
  },
  sessionMetaText: {
    color: "#94a3ad",
    marginTop: 4,
    width: "100%",
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
  attachHint: {
    color: "#30c48d",
    fontWeight: "800",
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: "center",
    padding: 22,
    backgroundColor: "rgba(0, 0, 0, 0.58)",
  },
  modalCard: {
    borderColor: "#34424c",
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    gap: 10,
    backgroundColor: "#151c21",
  },
  modalTitle: {
    color: "#f5f7f8",
    fontSize: 18,
    fontWeight: "800",
  },
  modalDescription: {
    color: "#94a3ad",
    fontSize: 13,
  },
  cwdInput: {
    minHeight: 48,
    borderColor: "#34424c",
    borderWidth: 1,
    borderRadius: 8,
    color: "#f5f7f8",
    paddingHorizontal: 12,
    backgroundColor: "#101417",
  },
  modalActions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  modalSecondaryButton: {
    flex: 1,
    minHeight: 44,
    borderColor: "#34424c",
    borderWidth: 1,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  modalPrimaryButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#30c48d",
  },
});

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

function getRuntimeLabel(runtimeKind: RuntimeKind): string {
  return (
    RUNTIME_GROUPS.find((group) => group.kind === runtimeKind)?.label ??
    runtimeKind
  );
}

function getRuntimeGroupKind(session: CodexSession): RuntimeKind {
  return session.runtime_kind === "claude" || session.runtime_kind === "codex"
    ? session.runtime_kind
    : "other";
}
