import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";

import type {
  AgentSurfaceEventPayload,
  TerminalSession,
} from "@omni-work/protocol-ts";

import { Button, Card } from "../../ui/components";
import { colors, radii, spacing, typography } from "../../ui/theme";

export function AgentSessionScreen({
  session,
  events,
  onBack,
  onSubmitPrompt,
}: {
  session: TerminalSession;
  events: readonly AgentSurfaceEventPayload[];
  onBack(): void;
  onSubmitPrompt(prompt: string): void;
}): JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const timelineRef = useRef<ScrollView | null>(null);
  const runtimeLabel = session.runtime?.label ?? "app server";
  const conversationEvents = events.filter(isConversationEvent);
  const activityEvents = events.filter((event) => !isConversationEvent(event));
  const latestActivity = [...activityEvents].reverse()[0];
  const canSubmit = draft.trim().length > 0;
  const statusTitle = latestActivity
    ? activityTitle(latestActivity, t)
    : t("agentSession.ready");

  useEffect(() => {
    timelineRef.current?.scrollToEnd({ animated: true });
  }, [conversationEvents.length]);

  function submitPrompt(): void {
    const prompt = draft.trim();
    if (!prompt) {
      return;
    }
    setDraft("");
    Keyboard.dismiss();
    onSubmitPrompt(prompt);
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 12 : 0}
      style={styles.screen}
    >
      <View style={styles.toolbar}>
        <Button icon="arrowLeft" iconOnly style={styles.backButton} onPress={onBack}>
          {t("common.back")}
        </Button>
        <View style={styles.titleArea}>
          <Text numberOfLines={1} style={styles.title}>
            {session.title}
          </Text>
          <Text numberOfLines={1} style={styles.subtitle}>
            {runtimeLabel} · {session.terminal_provider_label}
          </Text>
        </View>
      </View>

      <Card style={styles.statusCard}>
        <Text style={styles.eyebrow}>{t("agentSession.status")}</Text>
        <Text style={styles.statusTitle}>{statusTitle}</Text>
        <Text style={styles.statusText}>
          {latestActivity?.summary ??
            session.runtime?.description ??
            t("agentSession.waitingForEvents")}
        </Text>
      </Card>

      {activityEvents.length > 0 ? (
        <Card style={styles.activityCard}>
          <View style={styles.activityHeader}>
            <Text style={styles.activityTitle}>{t("agentSession.activity")}</Text>
            <Text style={styles.activityCount}>
              {t("agentSession.activityCount", {
                count: activityEvents.length,
              })}
            </Text>
          </View>
          {activityEvents.slice(-4).map((event) => (
            <View key={event.event_id} style={styles.activityRow}>
              <View style={styles.activityDot} />
              <View style={styles.activityTextArea}>
                <Text numberOfLines={1} style={styles.activityEventTitle}>
                  {activityTitle(event, t)}
                </Text>
                {event.summary ? (
                  <Text numberOfLines={2} style={styles.activitySummary}>
                    {event.summary}
                  </Text>
                ) : null}
              </View>
            </View>
          ))}
        </Card>
      ) : null}

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{t("agentSession.conversation")}</Text>
        <Text style={styles.sectionMeta}>{conversationEvents.length}</Text>
      </View>

      <ScrollView
        ref={timelineRef}
        style={styles.timelineScroll}
        contentContainerStyle={styles.timeline}
        keyboardShouldPersistTaps="handled"
      >
        {conversationEvents.length === 0 ? (
          <Card style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>{t("agentSession.emptyTitle")}</Text>
            <Text style={styles.emptyText}>{t("agentSession.emptyText")}</Text>
          </Card>
        ) : (
          conversationEvents.map((event) => {
            const presentation = conversationPresentation(event);
            return (
              <View
                key={event.event_id}
                style={[
                  styles.messageRow,
                  presentation.kind === "user" && styles.userMessageRow,
                ]}
              >
                <View
                  style={[
                    styles.messageBubble,
                    presentation.kind === "user" && styles.userMessageBubble,
                    presentation.kind === "codex" && styles.codexMessageBubble,
                    presentation.kind === "system" && styles.systemMessageBubble,
                  ]}
                >
                  <Text
                    style={[
                      styles.messageActor,
                      presentation.kind === "user" && styles.userMessageActor,
                      presentation.kind === "codex" && styles.codexMessageActor,
                    ]}
                  >
                    {presentation.actor}
                  </Text>
                  <Text style={styles.messageText}>{presentation.text}</Text>
                  <View style={styles.messageFooter}>
                    <Text style={styles.eventTime}>
                      {new Date(event.created_at).toLocaleString()}
                    </Text>
                    {presentation.kind === "user" ? (
                      <Text style={styles.deliveryStatus}>
                        {t("agentSession.delivered")}
                      </Text>
                    ) : null}
                  </View>
                </View>
              </View>
            );
          })
        )}
        {conversationEvents.length === 0 && activityEvents.length > 0 ? (
          <Card style={styles.quietActivityHint}>
            <Text style={styles.quietActivityText}>
              {t("agentSession.activityOnly")}
            </Text>
          </Card>
        ) : null}
      </ScrollView>

      <Card style={styles.composerCard}>
        <Text style={styles.composerTitle}>{t("agentSession.composerTitle")}</Text>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          autoCapitalize="sentences"
          autoCorrect
          multiline
          placeholder={t("agentSession.composerPlaceholder")}
          placeholderTextColor={colors.textDim}
          returnKeyType="default"
          submitBehavior="newline"
          style={styles.composerInput}
        />
        <Button
          disabled={!canSubmit}
          icon="send"
          style={styles.sendButton}
          tone="primary"
          onPress={submitPrompt}
        >
          {t("agentSession.send")}
        </Button>
      </Card>
    </KeyboardAvoidingView>
  );
}

function isConversationEvent(event: AgentSurfaceEventPayload): boolean {
  return (
    event.event_type === "agent.user_prompt_submitted" ||
    isCodexAgentMessage(event) ||
    event.event_type === "agent.failed"
  );
}

function conversationPresentation(event: AgentSurfaceEventPayload): {
  actor: string;
  kind: "user" | "codex" | "system";
  text: string;
} {
  if (event.event_type === "agent.user_prompt_submitted") {
    return {
      actor: "You",
      kind: "user",
      text: event.summary ?? "",
    };
  }
  if (isCodexAgentMessage(event)) {
    return {
      actor: "Codex",
      kind: "codex",
      text: event.summary ?? event.title,
    };
  }
  return {
    actor: "OmniWork Agent",
    kind: "system",
    text: event.summary ?? event.title,
  };
}

function isCodexAgentMessage(event: AgentSurfaceEventPayload): boolean {
  const item = event.payload?.item;
  return (
    event.provider === "codex" &&
    (event.source?.kind === "app-server" || event.source?.kind === "sdk") &&
    Boolean(item) &&
    typeof item === "object" &&
    (item as { type?: unknown }).type === "agent_message"
  );
}

function activityTitle(
  event: AgentSurfaceEventPayload,
  translate: (key: string) => string,
): string {
  const item = event.payload?.item;
  if (item && typeof item === "object") {
    switch ((item as { type?: unknown }).type) {
      case "command_execution":
        return translate("agentSession.activityLabels.command");
      case "file_change":
        return translate("agentSession.activityLabels.files");
      case "mcp_tool_call":
        return translate("agentSession.activityLabels.tool");
      case "todo_list":
        return translate("agentSession.activityLabels.plan");
      case "reasoning":
        return translate("agentSession.activityLabels.thinking");
      case "web_search":
        return translate("agentSession.activityLabels.webSearch");
      default:
        break;
    }
  }
  switch (event.event_type) {
    case "agent.thinking":
      return translate("agentSession.activityLabels.thinking");
    case "agent.tool_call_started":
    case "agent.tool_call_finished":
      return translate("agentSession.activityLabels.tool");
    case "agent.file_changed":
    case "agent.git_diff_changed":
      return translate("agentSession.activityLabels.code");
    case "agent.plan_created":
      return translate("agentSession.activityLabels.plan");
    case "agent.completed":
      return translate("agentSession.activityLabels.completed");
    default:
      return event.title;
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    gap: spacing.md,
    padding: spacing.xl,
    backgroundColor: colors.background,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  backButton: {
    width: 40,
    minHeight: 40,
    paddingHorizontal: 0,
    borderRadius: 20,
  },
  titleArea: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 20,
    fontWeight: "800",
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 2,
  },
  statusCard: {
    gap: spacing.sm,
  },
  eyebrow: {
    color: colors.success,
    ...typography.eyebrow,
  },
  statusTitle: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: "800",
  },
  statusText: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: "800",
  },
  sectionMeta: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "800",
  },
  timeline: {
    gap: spacing.md,
    paddingBottom: spacing.xl,
  },
  timelineScroll: {
    flex: 1,
  },
  emptyCard: {
    gap: spacing.sm,
  },
  emptyTitle: {
    color: colors.textSecondary,
    fontSize: 15,
    fontWeight: "800",
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
  },
  activityCard: {
    gap: spacing.sm,
    borderColor: colors.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.surfaceRaised,
  },
  activityHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  activityTitle: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "800",
  },
  activityCount: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "800",
  },
  activityRow: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "flex-start",
  },
  activityDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 7,
    backgroundColor: colors.success,
  },
  activityTextArea: {
    flex: 1,
    minWidth: 0,
  },
  activityEventTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "800",
  },
  activitySummary: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
  messageRow: {
    flexDirection: "row",
  },
  userMessageRow: {
    justifyContent: "flex-end",
  },
  messageBubble: {
    maxWidth: "88%",
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
  },
  userMessageBubble: {
    backgroundColor: colors.successSoft,
    borderColor: colors.success,
  },
  codexMessageBubble: {
    backgroundColor: colors.surface,
  },
  systemMessageBubble: {
    backgroundColor: colors.dangerSoft,
    borderColor: colors.dangerBorder,
  },
  messageActor: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "800",
  },
  userMessageActor: {
    color: colors.success,
  },
  codexMessageActor: {
    color: colors.textSecondary,
  },
  messageText: {
    color: colors.textPrimary,
    fontSize: 14,
    lineHeight: 20,
  },
  messageFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  eventTime: {
    color: colors.textDim,
    fontSize: 11,
  },
  deliveryStatus: {
    color: colors.success,
    fontSize: 11,
    fontWeight: "800",
  },
  quietActivityHint: {
    backgroundColor: colors.neutralSoft,
    borderWidth: 0,
  },
  quietActivityText: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  composerCard: {
    borderColor: colors.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    gap: spacing.xs,
  },
  composerTitle: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "800",
  },
  composerInput: {
    minHeight: 72,
    borderColor: colors.borderSubtle,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.background,
    textAlignVertical: "top",
  },
  sendButton: {
    alignSelf: "flex-end",
    minHeight: 38,
    minWidth: 96,
  },
  composerText: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
  },
});
