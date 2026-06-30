import { type JSX, useMemo, useRef } from "react";
import {
  Animated,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useTranslation } from "react-i18next";

import type { LocalAgentMessageRecord } from "../../features/agent/agentMessageStore";
import { Button, Card } from "../../ui/components";
import { colors, radii, spacing, typography } from "../../ui/theme";

export type MessageDetailReason =
  | "missing_session_id"
  | "session_not_found"
  | "session_unavailable";

export interface AgentMessageDetailScreenProps {
  record: LocalAgentMessageRecord;
  reason?: MessageDetailReason;
  canOpenSession: boolean;
  onBack(): void;
  onOpenSession(): void;
  onMarkHandled(messageId: string): void;
}

export function AgentMessageDetailScreen({
  record,
  reason,
  canOpenSession,
  onBack,
  onOpenSession,
  onMarkHandled,
}: AgentMessageDetailScreenProps): JSX.Element {
  const { t } = useTranslation();
  const { width } = useWindowDimensions();
  const translateX = useRef(new Animated.Value(0)).current;
  const message = record.message;
  const action = message.action;
  const actionable = Boolean(action);
  const handled = Boolean(record.handled_at);
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          shouldStartEdgeBackGesture(gesture.x0, gesture.dx, gesture.dy),
        onMoveShouldSetPanResponder: (_event, gesture) =>
          shouldStartEdgeBackGesture(gesture.x0, gesture.dx, gesture.dy),
        onPanResponderGrant: () => {
          translateX.stopAnimation();
        },
        onPanResponderMove: (_event, gesture) => {
          translateX.setValue(Math.max(0, Math.min(width, gesture.dx)));
        },
        onPanResponderRelease: (_event, gesture) => {
          if (shouldCompleteEdgeBackGesture(gesture.dx, gesture.vx)) {
            Animated.timing(translateX, {
              toValue: width,
              duration: 180,
              useNativeDriver: true,
            }).start(onBack);
            return;
          }
          animateBackGesture(translateX, 0);
        },
        onPanResponderTerminate: () => {
          animateBackGesture(translateX, 0);
        },
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,
      }),
    [onBack, translateX, width],
  );

  return (
    <View style={styles.screen} {...panResponder.panHandlers}>
      <Animated.View
        style={[
          styles.page,
          {
            transform: [{ translateX }],
          },
        ]}
      >
        <View style={styles.header}>
          <Button
            accessibilityLabel={t("common.back")}
            icon="arrowLeft"
            iconOnly
            style={styles.backButton}
            onPress={onBack}
          >
            {t("common.back")}
          </Button>
          <View style={styles.headerText}>
            <Text style={styles.eyebrow}>{t("messages.eyebrow")}</Text>
            <Text style={styles.title}>{t("messages.detailTitle")}</Text>
          </View>
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <Card elevated style={styles.card}>
            <View style={styles.metaRow}>
              <Pill>{providerLabel(message.provider)}</Pill>
              <Pill tone={priorityTone(message.priority)}>
                {t(`messages.priority.${message.priority}`)}
              </Pill>
            </View>
            <Text style={styles.messageTitle}>{message.title}</Text>
            {message.summary ? (
              <Text style={styles.summary}>{message.summary}</Text>
            ) : (
              <Text style={styles.emptyText}>{t("messages.noSummary")}</Text>
            )}
          </Card>

          {reason ? (
            <Card style={styles.warningCard}>
              <Text style={styles.warningTitle}>
                {t("messages.targetUnavailable")}
              </Text>
              <Text style={styles.warningText}>
                {t(`messages.reason.${reason}`)}
              </Text>
            </Card>
          ) : null}

          <Card style={styles.card}>
            <DetailField
              label={t("messages.fields.createdAt")}
              value={formatDateTime(message.created_at)}
            />
            <DetailField
              label={t("messages.fields.receivedAt")}
              value={formatDateTime(record.received_at)}
            />
            <DetailField
              label={t("messages.fields.workspace")}
              value={message.workspace_path ?? message.workspace_id}
            />
            <DetailField
              label={t("messages.fields.session")}
              value={action?.session_id ?? message.session_id}
            />
            <DetailField
              label={t("messages.fields.surface")}
              value={action?.surface_id ?? message.surface_id}
            />
            <DetailField
              label={t("messages.fields.action")}
              value={action?.type}
            />
            <DetailField
              label={t("messages.fields.status")}
              value={handled ? t("messages.handled") : t("messages.unhandled")}
            />
          </Card>
        </ScrollView>

        <View style={styles.footer}>
          <Button
            disabled={!canOpenSession}
            icon="terminal"
            style={styles.footerButton}
            tone="primary"
            onPress={onOpenSession}
          >
            {t("messages.openSession")}
          </Button>
          {actionable && !handled ? (
            <Button
              icon="check"
              style={styles.footerButton}
              onPress={() => onMarkHandled(message.id)}
            >
              {t("messages.markHandled")}
            </Button>
          ) : null}
        </View>
      </Animated.View>
    </View>
  );
}

function DetailField({
  label,
  value,
}: {
  label: string;
  value?: string;
}): JSX.Element {
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text selectable style={styles.fieldValue}>
        {value || "-"}
      </Text>
    </View>
  );
}

function Pill({
  children,
  tone,
}: {
  children: string;
  tone?: "success" | "warning" | "danger" | "neutral";
}): JSX.Element {
  return (
    <View style={[styles.pill, tone === "warning" && styles.warningPill]}>
      <Text style={[styles.pillText, tone === "warning" && styles.warningPillText]}>
        {children}
      </Text>
    </View>
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

function priorityTone(priority: string): "warning" | "neutral" {
  return priority === "critical" || priority === "high"
    ? "warning"
    : "neutral";
}

function formatDateTime(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Date(timestamp).toLocaleString();
}

const EDGE_BACK_WIDTH = 28;
const EDGE_BACK_START_THRESHOLD = 10;
const EDGE_BACK_COMPLETE_DISTANCE = 72;
const EDGE_BACK_VELOCITY = 0.35;

function shouldStartEdgeBackGesture(
  startX: number,
  dx: number,
  dy: number,
): boolean {
  const absDx = Math.abs(dx);
  return (
    startX <= EDGE_BACK_WIDTH &&
    dx > EDGE_BACK_START_THRESHOLD &&
    absDx > Math.abs(dy) * 1.25
  );
}

function shouldCompleteEdgeBackGesture(dx: number, vx: number): boolean {
  return dx >= EDGE_BACK_COMPLETE_DISTANCE || vx >= EDGE_BACK_VELOCITY;
}

function animateBackGesture(value: Animated.Value, toValue: number): void {
  Animated.spring(value, {
    toValue,
    damping: 18,
    stiffness: 240,
    mass: 0.9,
    useNativeDriver: true,
  }).start();
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "transparent",
  },
  page: {
    flex: 1,
    backgroundColor: colors.background,
    shadowColor: "#000000",
    shadowOffset: { width: -8, height: 0 },
    shadowOpacity: 0.24,
    shadowRadius: 18,
    elevation: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.xxl,
  },
  backButton: {
    minHeight: 36,
    width: 36,
    paddingHorizontal: 0,
    borderRadius: radii.pill,
  },
  headerText: {
    flex: 1,
  },
  eyebrow: {
    color: colors.textDim,
    ...typography.eyebrow,
  },
  title: {
    color: colors.textPrimary,
    ...typography.title,
    marginTop: spacing.xs,
  },
  content: {
    gap: spacing.lg,
    padding: spacing.xxl,
    paddingTop: 0,
    paddingBottom: 112,
  },
  card: {
    gap: spacing.lg,
    padding: spacing.lg,
  },
  warningCard: {
    gap: spacing.sm,
    padding: spacing.lg,
    borderColor: colors.warning,
    backgroundColor: colors.warningSoft,
  },
  warningTitle: {
    color: colors.warning,
    fontSize: 14,
    fontWeight: "900",
  },
  warningText: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  pill: {
    alignSelf: "flex-start",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    backgroundColor: colors.neutralSoft,
  },
  pillText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: "800",
  },
  warningPill: {
    backgroundColor: colors.warningSoft,
  },
  warningPillText: {
    color: colors.warning,
  },
  messageTitle: {
    color: colors.textPrimary,
    fontSize: 20,
    fontWeight: "900",
    lineHeight: 26,
  },
  summary: {
    color: colors.textSecondary,
    fontSize: 15,
    lineHeight: 22,
  },
  emptyText: {
    color: colors.textDim,
    fontSize: 14,
    lineHeight: 20,
  },
  fieldRow: {
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    borderBottomColor: colors.borderSubtle,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  fieldLabel: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: "800",
  },
  fieldValue: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.xxl,
    borderTopColor: colors.borderSubtle,
    borderTopWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.surfaceRaised,
  },
  footerButton: {
    flex: 1,
  },
});
