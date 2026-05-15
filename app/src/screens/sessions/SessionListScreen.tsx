import { type JSX, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
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
  RuntimeKind,
} from "../../../../packages/protocol-ts/src/index.ts";
import { getSessionCapabilities } from "../../features/sessions/sessionCapabilities";
import { Badge, Button, Card } from "../../ui/components";
import { colors, radii, spacing, typography } from "../../ui/theme";

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
  onRecoverSession(session: CodexSession): void;
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
  onRecoverSession,
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
        <Button style={styles.toolbarButton} onPress={onBack}>
          Devices
        </Button>
        <View style={styles.toolbarTitleArea}>
          <Text style={styles.toolbarTitle}>Sessions</Text>
          <Text style={styles.toolbarMeta}>
            {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
          </Text>
        </View>
        <Button style={styles.toolbarButton} onPress={onRefreshSessions}>
          Refresh
        </Button>
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
                  <Button
                    disabled={creating}
                    style={styles.sectionCreateButton}
                    tone="primary"
                    onPress={() =>
                      openCreateModal(group.kind as CreatableRuntimeKind)
                    }
                  >
                    {creating && createRuntimeKind === group.kind
                      ? "Starting..."
                      : "New"}
                  </Button>
                ) : null}
              </View>

              {groupSessions.length === 0 ? (
                <Text style={styles.empty}>No {group.label} sessions yet.</Text>
              ) : (
                <View style={styles.sessionStack}>
                  {groupSessions.map((session) => {
                    const closing = closingSessionIds.includes(
                      session.session_id,
                    );
                    const killing = killingSessionIds.includes(
                      session.session_id,
                    );
                    const external = session.origin === "external";
                    const registered = session.registered !== false;
                    const capabilities = getSessionCapabilities(session, {
                      closing,
                      killing,
                    });
                    const statusColors = getStatusColors(
                      capabilities.statusTone,
                    );
                    return (
                      <Card key={session.session_id} style={styles.sessionCard}>
                        <Pressable
                          disabled={!capabilities.canOpen}
                          style={[
                            styles.sessionMain,
                            !capabilities.canOpen && styles.disabled,
                          ]}
                          onPress={() => onOpenSession(session)}
                        >
                          <View style={styles.sessionTitleRow}>
                            <Text numberOfLines={1} style={styles.sessionTitle}>
                              {session.title}
                            </Text>
                            <Text
                              style={[
                                styles.openHint,
                                !capabilities.canOpen && styles.openHintMuted,
                              ]}
                            >
                              {capabilities.primaryActionLabel}
                            </Text>
                          </View>
                          <View style={styles.badgeRow}>
                            <Badge
                              backgroundColor={colors.successSoft}
                              color="#d7ffe9"
                              style={styles.compactBadge}
                            >
                              {getRuntimeLabel(getRuntimeGroupKind(session))}
                            </Badge>
                            {external ? (
                              <Badge
                                backgroundColor={colors.warningSoft}
                                color={colors.warning}
                                style={styles.compactBadge}
                              >
                                {registered ? "Attached tmux" : "Existing tmux"}
                              </Badge>
                            ) : null}
                            <Badge
                              backgroundColor={statusColors.backgroundColor}
                              color={statusColors.color}
                              style={styles.compactBadge}
                            >
                              {capabilities.statusLabel}
                            </Badge>
                          </View>
                          <Text
                            ellipsizeMode="middle"
                            numberOfLines={1}
                            style={styles.sessionMetaText}
                          >
                            {session.cwd}
                          </Text>
                          <View style={styles.sessionDetails}>
                            <Text
                              style={[
                                styles.sessionStatus,
                                { color: statusColors.color },
                              ]}
                            >
                              {capabilities.statusLabel}
                            </Text>
                            <Text style={styles.sessionTime}>
                              Active{" "}
                              {formatRelativeTime(session.last_active_at)}
                            </Text>
                          </View>
                          <Text style={styles.sessionCreated}>
                            Created {formatAbsoluteTime(session.created_at)}
                          </Text>
                          {capabilities.unavailableReason ? (
                            <Text style={styles.unavailableReason}>
                              {capabilities.unavailableReason}
                            </Text>
                          ) : null}
                        </Pressable>
                        {capabilities.canRecover &&
                        capabilities.recoveryActionLabel ? (
                          <View style={styles.recoveryActionRow}>
                            <Button
                              accessibilityLabel={`${capabilities.recoveryActionLabel} session`}
                              style={styles.recoveryButton}
                              tone="primary"
                              onPress={() => onRecoverSession(session)}
                            >
                              {capabilities.recoveryActionLabel}
                            </Button>
                            <Text style={styles.recoveryHint}>
                              {getRecoveryHint(session)}
                            </Text>
                          </View>
                        ) : null}
                        <View style={styles.sessionActions}>
                          {registered ? (
                            <Button
                              disabled={!capabilities.canClose}
                              style={styles.closeButton}
                              tone="danger"
                              onPress={() => onCloseSession(session)}
                            >
                              {closing
                                ? "Closing..."
                                : external
                                  ? "Forget tmux"
                                  : getCloseActionLabel(session)}
                            </Button>
                          ) : (
                            <View style={styles.closeButton}>
                              <Text style={styles.attachHint}>
                                Tap card to attach
                              </Text>
                            </View>
                          )}
                          <Button
                            disabled={!capabilities.canKill}
                            accessibilityLabel="Kill tmux session"
                            style={styles.killSessionButton}
                            tone="danger"
                            onPress={() => onKillTmuxSession(session)}
                          >
                            {killing ? "Killing..." : "Kill tmux"}
                          </Button>
                        </View>
                      </Card>
                    );
                  })}
                </View>
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
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.modalAvoidingView}
        >
          <View
            style={styles.modalBackdrop}
            onStartShouldSetResponderCapture={() => {
              Keyboard.dismiss();
              return false;
            }}
          >
            <Card style={styles.modalCard}>
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
                <Button
                  style={styles.modalSecondaryButton}
                  onPress={() => setCreateModalVisible(false)}
                >
                  Cancel
                </Button>
                <Button
                  disabled={!createCwd.trim() || creating}
                  style={styles.modalPrimaryButton}
                  tone="primary"
                  onPress={confirmCreateSession}
                >
                  {creating ? "Starting..." : "Create"}
                </Button>
              </View>
            </Card>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    padding: spacing.xxl,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  toolbarTitleArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  toolbarButton: {
    minHeight: 38,
    minWidth: 86,
  },
  toolbarTitle: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: "800",
  },
  toolbarMeta: {
    color: colors.textMuted,
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
    color: colors.successText,
    ...typography.action,
  },
  secondaryText: {
    color: colors.textSecondary,
    fontWeight: "700",
  },
  disabled: {
    opacity: 0.55,
  },
  list: {
    gap: spacing.xxl,
  },
  runtimeSection: {
    gap: spacing.md,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.lg,
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: "800",
  },
  sectionMeta: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  sectionCreateButton: {
    minHeight: 38,
    minWidth: 72,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.success,
  },
  sessionStack: {
    gap: spacing.md,
  },
  empty: {
    color: colors.textMuted,
    borderColor: colors.borderSubtle,
    borderWidth: 1,
    borderRadius: radii.sm,
    padding: 14,
  },
  sessionCard: {
    overflow: "hidden",
  },
  sessionMain: {
    padding: 14,
  },
  sessionActions: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md,
    borderTopColor: colors.borderSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  recoveryActionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
  },
  recoveryButton: {
    minHeight: 36,
    minWidth: 92,
    borderRadius: radii.sm,
    backgroundColor: colors.success,
  },
  recoveryHint: {
    color: colors.textMuted,
    flex: 1,
    fontSize: 12,
    lineHeight: 17,
  },
  closeButton: {
    flex: 1,
    minHeight: 38,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  killSessionButton: {
    flex: 1,
    minHeight: 38,
    borderColor: colors.dangerBorder,
    borderWidth: 1,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.dangerSurface,
  },
  sessionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  sessionTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: "700",
    flex: 1,
  },
  openHint: {
    color: colors.success,
    fontSize: 12,
    fontWeight: "800",
  },
  openHintMuted: {
    color: colors.textDim,
  },
  badgeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  compactBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  runtimeBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: "hidden",
    color: "#d7ffe9",
    fontSize: 11,
    fontWeight: "800",
    backgroundColor: colors.successSoft,
  },
  originBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    overflow: "hidden",
    color: colors.warning,
    fontSize: 11,
    fontWeight: "800",
    backgroundColor: colors.warningSoft,
  },
  sessionMetaText: {
    color: colors.textMuted,
    marginTop: spacing.xs,
    width: "100%",
  },
  sessionStatus: {
    color: colors.success,
    fontWeight: "700",
    textTransform: "capitalize",
  },
  sessionDetails: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  sessionTime: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
  },
  sessionCreated: {
    color: colors.textDim,
    fontSize: 12,
    marginTop: 6,
  },
  unavailableReason: {
    color: colors.warning,
    fontSize: 12,
    lineHeight: 17,
    marginTop: spacing.sm,
  },
  closeText: {
    color: colors.danger,
    fontWeight: "800",
  },
  killSessionText: {
    color: colors.danger,
    fontWeight: "800",
  },
  attachHint: {
    color: colors.success,
    fontWeight: "800",
  },
  modalAvoidingView: {
    flex: 1,
  },
  modalBackdrop: {
    flex: 1,
    justifyContent: "center",
    padding: 22,
    backgroundColor: "rgba(0, 0, 0, 0.58)",
  },
  modalCard: {
    padding: spacing.xl,
    gap: spacing.md,
  },
  modalTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: "800",
  },
  modalDescription: {
    color: colors.textMuted,
    fontSize: 13,
  },
  cwdInput: {
    minHeight: 48,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    color: colors.textPrimary,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.background,
  },
  modalActions: {
    flexDirection: "row",
    gap: spacing.md,
    marginTop: spacing.xs,
  },
  modalSecondaryButton: {
    flex: 1,
    minHeight: 44,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  modalPrimaryButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: radii.sm,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.success,
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

function getCloseActionLabel(session: CodexSession): string {
  if (
    session.status === "error" ||
    session.status === "exited" ||
    session.status === "archived"
  ) {
    return "Remove";
  }

  return "Close Session";
}

function getRecoveryHint(session: CodexSession): string {
  switch (session.status) {
    case "error":
      return "Starts the saved command in a fresh tmux session.";
    case "recovering":
      return "Checks whether the tmux target is back online.";
    case "exited":
      return "Restarts the saved command and keeps the session history.";
    default:
      return "Attempts to make this session interactive again.";
  }
}

function getStatusColors(tone: "success" | "warning" | "danger" | "neutral"): {
  backgroundColor: string;
  color: string;
} {
  switch (tone) {
    case "success":
      return {
        backgroundColor: colors.successSoft,
        color: "#d7ffe9",
      };
    case "warning":
      return {
        backgroundColor: colors.warningSoft,
        color: colors.warning,
      };
    case "danger":
      return {
        backgroundColor: colors.dangerSoft,
        color: colors.danger,
      };
    case "neutral":
    default:
      return {
        backgroundColor: colors.neutralSoft,
        color: colors.textMuted,
      };
  }
}
