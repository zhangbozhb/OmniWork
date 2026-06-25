import type { JSX } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { AgentAppMessage } from "@omniwork/protocol-ts";

import type { LocalAgentMessageRecord } from "../../features/agent/agentMessageStore";
import { Icon } from "../../ui/icons";
import { colors, radii, spacing, typography } from "../../ui/theme";

export interface AgentMessageInboxScreenProps {
  messages: LocalAgentMessageRecord[];
  onRefresh(): void;
  onOpenMessage(record: LocalAgentMessageRecord): void;
  onMarkRead(messageId: string): void;
  onMarkHandled(messageId: string): void;
}

export function AgentMessageInboxScreen({
  messages,
  onRefresh,
  onOpenMessage,
  onMarkRead,
  onMarkHandled,
}: AgentMessageInboxScreenProps): JSX.Element {
  const { t } = useTranslation();
  const pending = messages.filter((record) => isPending(record));
  const recent = messages.filter((record) => !isPending(record));
  const sections = [
    ...(pending.length
      ? [{ kind: "header" as const, id: "pending", title: t("messages.pending") }]
      : []),
    ...pending.map((record) => ({ kind: "message" as const, record })),
    ...(recent.length
      ? [{ kind: "header" as const, id: "recent", title: t("messages.recent") }]
      : []),
    ...recent.map((record) => ({ kind: "message" as const, record })),
  ];

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>{t("messages.eyebrow")}</Text>
          <Text style={styles.title}>{t("messages.title")}</Text>
        </View>
        <Pressable
          accessibilityLabel={t("common.refresh")}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.backButton,
            pressed && styles.pressed,
          ]}
          onPress={onRefresh}
        >
          <Icon name="refresh" color={colors.textPrimary} size={18} />
        </Pressable>
      </View>

      <FlatList
        contentContainerStyle={styles.list}
        data={sections}
        keyExtractor={(item) =>
          item.kind === "header" ? item.id : item.record.message.id
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Icon name="message" color={colors.textDim} size={28} />
            <Text style={styles.emptyTitle}>{t("messages.emptyTitle")}</Text>
            <Text style={styles.emptyText}>{t("messages.emptyText")}</Text>
          </View>
        }
        renderItem={({ item }) =>
          item.kind === "header" ? (
            <Text style={styles.sectionTitle}>{item.title}</Text>
          ) : (
            <MessageRow
              record={item.record}
              onMarkHandled={onMarkHandled}
              onMarkRead={onMarkRead}
              onOpenMessage={onOpenMessage}
            />
          )
        }
      />
    </View>
  );
}

function MessageRow({
  record,
  onOpenMessage,
  onMarkRead,
  onMarkHandled,
}: {
  record: LocalAgentMessageRecord;
  onOpenMessage(record: LocalAgentMessageRecord): void;
  onMarkRead(messageId: string): void;
  onMarkHandled(messageId: string): void;
}): JSX.Element {
  const { t } = useTranslation();
  const message = record.message;
  const unread = !record.read_at;
  const actionable = Boolean(message.action);
  const handled = Boolean(record.handled_at);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={message.title}
      style={({ pressed }) => [
        styles.messageCard,
        unread && styles.messageCardUnread,
        pressed && styles.pressed,
      ]}
      onPress={() => onOpenMessage(record)}
    >
      <View style={styles.messageHeader}>
        <View style={styles.providerPill}>
          <Text style={styles.providerText}>{providerLabel(message.provider)}</Text>
        </View>
        <Text style={styles.timeText}>{relativeTime(message.created_at)}</Text>
      </View>
      <View style={styles.messageTitleRow}>
        {unread ? <View style={styles.unreadDot} /> : null}
        <Text style={styles.messageTitle}>{message.title}</Text>
      </View>
      {message.summary ? (
        <Text numberOfLines={2} style={styles.messageSummary}>
          {message.summary}
        </Text>
      ) : null}
      <View style={styles.messageFooter}>
        <Text style={[styles.statusText, priorityStyle(message)]}>
          {t(`messages.priority.${message.priority}`)}
        </Text>
        <View style={styles.rowActions}>
          {unread ? (
            <Pressable
              accessibilityRole="button"
              style={styles.inlineAction}
              onPress={() => onMarkRead(message.id)}
            >
              <Text style={styles.inlineActionText}>
                {t("messages.markRead")}
              </Text>
            </Pressable>
          ) : null}
          {actionable && !handled ? (
            <Pressable
              accessibilityRole="button"
              style={styles.inlineAction}
              onPress={() => onMarkHandled(message.id)}
            >
              <Text style={styles.inlineActionText}>
                {t("messages.markHandled")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

function isPending(record: LocalAgentMessageRecord): boolean {
  return !record.read_at || (Boolean(record.message.action) && !record.handled_at);
}

function providerLabel(provider: string): string {
  switch (provider) {
    case "claude-code":
      return "Claude Code";
    case "trae-cn":
      return "Trae CN";
    default:
      return provider
        .split(/[-_]/u)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
  }
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function priorityStyle(message: AgentAppMessage) {
  if (message.priority === "critical" || message.priority === "high") {
    return styles.statusHigh;
  }
  if (message.priority === "normal") {
    return styles.statusNormal;
  }
  return styles.statusLow;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.xxl,
    borderBottomColor: colors.borderSubtle,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: {
    alignItems: "center",
    justifyContent: "center",
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceRaised,
  },
  headerCopy: {
    flex: 1,
    gap: spacing.xs,
  },
  eyebrow: {
    color: colors.textDim,
    ...typography.eyebrow,
  },
  title: {
    color: colors.textPrimary,
    ...typography.title,
  },
  list: {
    padding: spacing.xxl,
    gap: spacing.md,
  },
  sectionTitle: {
    marginTop: spacing.sm,
    color: colors.textMuted,
    ...typography.eyebrow,
  },
  messageCard: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderColor: colors.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
  },
  messageCardUnread: {
    borderColor: colors.success,
    backgroundColor: colors.surfaceRaised,
  },
  messageHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  providerPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: colors.neutralSoft,
  },
  providerText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "800",
  },
  timeText: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: "700",
  },
  messageTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.success,
  },
  messageTitle: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: "800",
  },
  messageSummary: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
  },
  messageFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.md,
  },
  statusText: {
    fontSize: 12,
    fontWeight: "800",
  },
  statusHigh: {
    color: colors.warning,
  },
  statusNormal: {
    color: colors.success,
  },
  statusLow: {
    color: colors.textDim,
  },
  rowActions: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  inlineAction: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: colors.successSoft,
  },
  inlineActionText: {
    color: colors.success,
    fontSize: 12,
    fontWeight: "800",
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    paddingVertical: 72,
    paddingHorizontal: spacing.xxl,
  },
  emptyTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: "800",
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  pressed: {
    opacity: 0.82,
  },
});
