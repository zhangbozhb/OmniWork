import {
  type JSX,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Animated,
  FlatList,
  PanResponder,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import type { AgentAppMessage } from "@omniwork/protocol-ts";

import type { LocalAgentMessageRecord } from "../../features/agent/agentMessageStore";
import { Icon } from "../../ui/icons";
import { colors, radii, spacing, typography } from "../../ui/theme";

export interface AgentMessageInboxScreenProps {
  messages: LocalAgentMessageRecord[];
  refreshing: boolean;
  refreshRevealToken: number;
  editing: boolean;
  selectedMessageIds: Set<string>;
  onRefresh(): Promise<void> | void;
  onOpenMessage(record: LocalAgentMessageRecord): void;
  onMarkRead(messageId: string): void;
  onMarkHandled(messageId: string): void;
  onChangeEditing(editing: boolean): void;
  onToggleSelected(messageId: string): void;
  onSelectAll(): void;
  onClearSelection(): void;
  onDeleteMessage(messageId: string): void;
  onDeleteSelected(): void;
}

type AgentMessageListItem =
  | {
      kind: "header";
      id: string;
      title: string;
    }
  | {
      kind: "message";
      record: LocalAgentMessageRecord;
    };

export function AgentMessageInboxScreen({
  messages,
  refreshing,
  refreshRevealToken,
  editing,
  selectedMessageIds,
  onRefresh,
  onOpenMessage,
  onMarkRead,
  onMarkHandled,
  onChangeEditing,
  onToggleSelected,
  onSelectAll,
  onClearSelection,
  onDeleteMessage,
  onDeleteSelected,
}: AgentMessageInboxScreenProps): JSX.Element {
  const { t } = useTranslation();
  const [swipeGestureActive, setSwipeGestureActive] = useState(false);
  const listRef = useRef<FlatList<AgentMessageListItem>>(null);
  const allSelected =
    messages.length > 0 && selectedMessageIds.size === messages.length;
  const pending = messages.filter((record) => isPending(record));
  const recent = messages.filter((record) => !isPending(record));
  const sections: AgentMessageListItem[] = [
    ...(pending.length
      ? [
          {
            kind: "header" as const,
            id: "pending",
            title: t("messages.pending"),
          },
        ]
      : []),
    ...pending.map((record) => ({ kind: "message" as const, record })),
    ...(recent.length
      ? [{ kind: "header" as const, id: "recent", title: t("messages.recent") }]
      : []),
    ...recent.map((record) => ({ kind: "message" as const, record })),
  ];

  function revealRefreshControl(): void {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }

  useEffect(() => {
    if (refreshRevealToken > 0 && !editing) {
      revealRefreshControl();
    }
  }, [editing, refreshRevealToken]);

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>{t("messages.eyebrow")}</Text>
          <Text style={styles.title}>{t("messages.title")}</Text>
        </View>
        <Pressable
          accessibilityLabel={editing ? t("messages.done") : t("messages.edit")}
          accessibilityRole="button"
          disabled={!messages.length}
          style={({ pressed }) => [
            styles.textAction,
            !messages.length && styles.disabled,
            pressed && styles.pressed,
          ]}
          onPress={() => onChangeEditing(!editing)}
        >
          <Text style={styles.textActionLabel}>
            {editing ? t("messages.done") : t("messages.edit")}
          </Text>
        </Pressable>
      </View>
      {editing ? (
        <View style={styles.selectionBar}>
          <Text style={styles.selectionText}>
            {t("messages.selectedCount", { count: selectedMessageIds.size })}
          </Text>
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.selectAllAction,
              pressed && styles.pressed,
            ]}
            onPress={allSelected ? onClearSelection : onSelectAll}
          >
            <Text style={styles.selectAllText}>
              {allSelected
                ? t("messages.clearSelection")
                : t("messages.selectAll")}
            </Text>
          </Pressable>
        </View>
      ) : null}

      <FlatList
        ref={listRef}
        contentContainerStyle={[styles.list, editing && styles.listEditing]}
        data={sections}
        scrollEnabled={!swipeGestureActive}
        refreshControl={
          <RefreshControl
            enabled={!editing && !swipeGestureActive}
            refreshing={refreshing}
            tintColor={colors.success}
            onRefresh={() => {
              void onRefresh();
            }}
          />
        }
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
              editing={editing}
              record={item.record}
              selected={selectedMessageIds.has(item.record.message.id)}
              onDeleteMessage={onDeleteMessage}
              onMarkHandled={onMarkHandled}
              onMarkRead={onMarkRead}
              onOpenMessage={onOpenMessage}
              onSwipeGestureActiveChange={setSwipeGestureActive}
              onToggleSelected={onToggleSelected}
            />
          )
        }
      />
      {editing ? (
        <View style={styles.bulkActionBar}>
          <Text style={styles.selectionText}>
            {t("messages.selectedCount", { count: selectedMessageIds.size })}
          </Text>
          <Pressable
            accessibilityLabel={t("messages.delete")}
            accessibilityRole="button"
            disabled={!selectedMessageIds.size}
            style={({ pressed }) => [
              styles.bulkDeleteButton,
              !selectedMessageIds.size && styles.disabled,
              pressed && styles.pressed,
            ]}
            onPress={onDeleteSelected}
          >
            <Icon name="trash" color={colors.danger} size={16} />
            <Text style={styles.bulkDeleteText}>{t("messages.delete")}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function MessageRow({
  editing,
  record,
  selected,
  onOpenMessage,
  onMarkRead,
  onMarkHandled,
  onToggleSelected,
  onDeleteMessage,
  onSwipeGestureActiveChange,
}: {
  editing: boolean;
  record: LocalAgentMessageRecord;
  selected: boolean;
  onOpenMessage(record: LocalAgentMessageRecord): void;
  onMarkRead(messageId: string): void;
  onMarkHandled(messageId: string): void;
  onToggleSelected(messageId: string): void;
  onDeleteMessage(messageId: string): void;
  onSwipeGestureActiveChange(active: boolean): void;
}): JSX.Element {
  const message = record.message;
  const unread = !record.read_at;
  const actionable = Boolean(message.action);
  const handled = Boolean(record.handled_at);

  if (editing) {
    return (
      <Pressable
        accessibilityLabel={message.title}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: selected }}
        style={({ pressed }) => [styles.editingRow, pressed && styles.pressed]}
        onPress={() => onToggleSelected(message.id)}
      >
        <View
          style={[styles.selectionCircle, selected && styles.selectedCircle]}
        >
          {selected ? (
            <Icon name="check" color={colors.background} size={14} />
          ) : null}
        </View>
        <View
          style={[
            styles.messageCard,
            styles.editingMessageCard,
            unread && styles.messageCardUnread,
          ]}
        >
          <MessageCardContent
            actionable={actionable}
            handled={handled}
            message={message}
            openEnabled={false}
            record={record}
            showActions={false}
            unread={unread}
            onMarkHandled={onMarkHandled}
            onMarkRead={onMarkRead}
            onOpenMessage={onOpenMessage}
          />
        </View>
      </Pressable>
    );
  }

  return (
    <SwipeableMessageRow
      onDelete={() => onDeleteMessage(message.id)}
      onSwipeGestureActiveChange={onSwipeGestureActiveChange}
    >
      <View style={[styles.messageCard, unread && styles.messageCardUnread]}>
        <MessageCardContent
          actionable={actionable}
          handled={handled}
          message={message}
          openEnabled
          record={record}
          showActions
          unread={unread}
          onMarkHandled={onMarkHandled}
          onMarkRead={onMarkRead}
          onOpenMessage={onOpenMessage}
        />
      </View>
    </SwipeableMessageRow>
  );
}

function MessageCardContent({
  actionable,
  handled,
  message,
  openEnabled,
  record,
  showActions,
  unread,
  onOpenMessage,
  onMarkRead,
  onMarkHandled,
}: {
  actionable: boolean;
  handled: boolean;
  message: AgentAppMessage;
  openEnabled: boolean;
  record: LocalAgentMessageRecord;
  showActions: boolean;
  unread: boolean;
  onOpenMessage(record: LocalAgentMessageRecord): void;
  onMarkRead(messageId: string): void;
  onMarkHandled(messageId: string): void;
}): JSX.Element {
  const { t } = useTranslation();
  const workspaceLabel = message.workspace_path
    ? workspaceLabelFromPath(message.workspace_path)
    : undefined;
  const body = (
    <>
      <View style={styles.messageHeader}>
        <View style={styles.messageMeta}>
          <View style={styles.providerPill}>
            <Text style={styles.providerText}>
              {providerLabel(message.provider)}
            </Text>
          </View>
          {workspaceLabel ? (
            <View style={styles.workspacePill}>
              <Text numberOfLines={1} style={styles.workspaceText}>
                {workspaceLabel}
              </Text>
            </View>
          ) : null}
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
    </>
  );

  return (
    <>
      {openEnabled ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={message.title}
          style={({ pressed }) => [
            styles.messageOpenArea,
            pressed && styles.pressed,
          ]}
          onPress={() => onOpenMessage(record)}
        >
          {body}
        </Pressable>
      ) : (
        <View style={styles.messageOpenArea}>{body}</View>
      )}
      <View style={styles.messageFooter}>
        <Text style={[styles.statusText, priorityStyle(message)]}>
          {t(`messages.priority.${message.priority}`)}
        </Text>
        {showActions ? (
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
        ) : null}
      </View>
    </>
  );
}

const SWIPE_ACTION_WIDTH = 88;
const SWIPE_START_THRESHOLD = 10;
const SWIPE_OPEN_DISTANCE = 24;
const SWIPE_VELOCITY_THRESHOLD = 0.24;

function SwipeableMessageRow({
  children,
  onDelete,
  onSwipeGestureActiveChange,
}: {
  children: ReactNode;
  onDelete(): void;
  onSwipeGestureActiveChange(active: boolean): void;
}): JSX.Element {
  const { t } = useTranslation();
  const translateX = useRef(new Animated.Value(0)).current;
  const openRef = useRef(false);
  const gestureActiveRef = useRef(false);

  function setGestureActive(active: boolean): void {
    if (gestureActiveRef.current === active) {
      return;
    }
    gestureActiveRef.current = active;
    onSwipeGestureActiveChange(active);
  }

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          shouldStartHorizontalSwipe(gesture.dx, gesture.dy),
        onMoveShouldSetPanResponder: (_event, gesture) =>
          shouldStartHorizontalSwipe(gesture.dx, gesture.dy),
        onPanResponderGrant: () => {
          translateX.stopAnimation();
        },
        onPanResponderMove: (_event, gesture) => {
          setGestureActive(true);
          const base = openRef.current ? -SWIPE_ACTION_WIDTH : 0;
          const next = Math.min(
            0,
            Math.max(-SWIPE_ACTION_WIDTH, base + gesture.dx),
          );
          translateX.setValue(next);
        },
        onPanResponderRelease: (_event, gesture) => {
          const shouldOpen = resolveSwipeOpen(
            openRef.current,
            gesture.dx,
            gesture.vx,
          );
          openRef.current = shouldOpen;
          animateSwipe(translateX, shouldOpen ? -SWIPE_ACTION_WIDTH : 0);
          setGestureActive(false);
        },
        onPanResponderTerminationRequest: () => !gestureActiveRef.current,
        onShouldBlockNativeResponder: () => gestureActiveRef.current,
        onPanResponderReject: () => {
          setGestureActive(false);
        },
        onPanResponderTerminate: () => {
          animateSwipe(translateX, openRef.current ? -SWIPE_ACTION_WIDTH : 0);
          setGestureActive(false);
        },
      }),
    [onSwipeGestureActiveChange, translateX],
  );

  return (
    <View style={styles.swipeContainer}>
      <View style={styles.swipeAction}>
        <Pressable
          accessibilityLabel={t("messages.delete")}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.swipeDeleteButton,
            pressed && styles.pressed,
          ]}
          onPress={onDelete}
        >
          <Icon name="trash" color={colors.background} size={18} />
          <Text style={styles.swipeDeleteText}>{t("messages.delete")}</Text>
        </Pressable>
      </View>
      <Animated.View
        style={[
          styles.swipeContent,
          {
            transform: [{ translateX }],
          },
        ]}
        {...panResponder.panHandlers}
      >
        {children}
      </Animated.View>
    </View>
  );
}

function shouldStartHorizontalSwipe(dx: number, dy: number): boolean {
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  return absDx >= SWIPE_START_THRESHOLD && absDx > absDy * 1.2;
}

function resolveSwipeOpen(
  currentlyOpen: boolean,
  dx: number,
  vx: number,
): boolean {
  if (vx <= -SWIPE_VELOCITY_THRESHOLD) {
    return true;
  }
  if (vx >= SWIPE_VELOCITY_THRESHOLD) {
    return false;
  }
  if (currentlyOpen) {
    return dx < SWIPE_OPEN_DISTANCE;
  }
  return dx <= -SWIPE_OPEN_DISTANCE;
}

function animateSwipe(value: Animated.Value, toValue: number): void {
  Animated.spring(value, {
    toValue,
    damping: 18,
    stiffness: 240,
    mass: 0.9,
    useNativeDriver: true,
  }).start();
}

function isPending(record: LocalAgentMessageRecord): boolean {
  return (
    !record.read_at || (Boolean(record.message.action) && !record.handled_at)
  );
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

function workspaceLabelFromPath(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
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
  textAction: {
    minWidth: 52,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    height: 40,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceRaised,
  },
  textActionLabel: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: "800",
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
  listEditing: {
    paddingBottom: 96,
  },
  selectionBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.md,
    borderBottomColor: colors.borderSubtle,
    borderBottomWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.surface,
  },
  selectionText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: "700",
  },
  selectAllAction: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: colors.neutralSoft,
  },
  selectAllText: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: "800",
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
  editingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  editingMessageCard: {
    flex: 1,
  },
  selectionCircle: {
    alignItems: "center",
    justifyContent: "center",
    width: 24,
    height: 24,
    borderRadius: 12,
    borderColor: colors.border,
    borderWidth: 2,
  },
  selectedCircle: {
    borderColor: colors.success,
    backgroundColor: colors.success,
  },
  messageCardUnread: {
    borderColor: colors.success,
    backgroundColor: colors.surfaceRaised,
  },
  messageOpenArea: {
    gap: spacing.sm,
  },
  messageHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  messageMeta: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
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
  workspacePill: {
    flexShrink: 1,
    maxWidth: 160,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceRaised,
  },
  workspaceText: {
    color: colors.textMuted,
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
  swipeContainer: {
    overflow: "hidden",
    borderRadius: radii.lg,
  },
  swipeAction: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "flex-end",
    justifyContent: "center",
    backgroundColor: colors.dangerSurface,
  },
  swipeDeleteButton: {
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    width: SWIPE_ACTION_WIDTH,
    height: "100%",
    backgroundColor: colors.danger,
  },
  swipeDeleteText: {
    color: colors.background,
    fontSize: 12,
    fontWeight: "900",
  },
  swipeContent: {
    borderRadius: radii.lg,
  },
  bulkActionBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.lg,
    borderTopColor: colors.borderSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.surfaceRaised,
  },
  bulkDeleteButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    borderColor: colors.dangerBorder,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.dangerSoft,
  },
  bulkDeleteText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: "900",
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
  disabled: {
    opacity: 0.45,
  },
});
