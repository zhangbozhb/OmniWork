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
  AgentInteractionAnswerPayload,
  AgentInteractionRequestPayload,
  AgentPromptFileReference,
  AgentSurfaceEventPayload,
  TerminalSession,
  WorkspaceFileEntry,
} from "@omni-work/protocol-ts";

import { Button, Card } from "../../ui/components";
import { colors, radii, spacing, typography } from "../../ui/theme";

export function AgentSessionScreen({
  session,
  events,
  interactions,
  contextWorkspacePath,
  contextDirectoryPath,
  contextFileEntries,
  onBack,
  onSubmitPrompt,
  onAnswerInteraction,
  onOpenContextDirectory,
}: {
  session: TerminalSession;
  events: readonly AgentSurfaceEventPayload[];
  interactions: readonly AgentInteractionRequestPayload[];
  contextWorkspacePath?: string;
  contextDirectoryPath: string;
  contextFileEntries: readonly WorkspaceFileEntry[];
  onBack(): void;
  onSubmitPrompt(
    prompt: string,
    contextFiles: AgentPromptFileReference[],
  ): void;
  onAnswerInteraction(
    interaction: AgentInteractionRequestPayload,
    decision: AgentInteractionAnswerPayload["decision"],
    answers?: Record<string, string[]>,
  ): void;
  onOpenContextDirectory(relativePath: string): void;
}): JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [contextPickerVisible, setContextPickerVisible] = useState(false);
  const [attachedContextPaths, setAttachedContextPaths] = useState<string[]>(
    [],
  );
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

  useEffect(() => {
    setAttachedContextPaths([]);
    setContextPickerVisible(false);
  }, [session.session_id]);

  function submitPrompt(): void {
    const prompt = draft.trim();
    if (!prompt) {
      return;
    }
    setDraft("");
    const contextFiles = contextWorkspacePath
      ? attachedContextPaths.map((relativePath) => ({
          kind: "workspace_file" as const,
          workspace_path: contextWorkspacePath,
          relative_path: relativePath,
        }))
      : [];
    setAttachedContextPaths([]);
    setContextPickerVisible(false);
    Keyboard.dismiss();
    onSubmitPrompt(prompt, contextFiles);
  }

  function toggleContextFile(relativePath: string): void {
    setAttachedContextPaths((current) => {
      if (current.includes(relativePath)) {
        return current.filter((path) => path !== relativePath);
      }
      return current.length < 10 ? [...current, relativePath] : current;
    });
  }

  function openParentContextDirectory(): void {
    const parts = contextDirectoryPath.split("/").filter(Boolean);
    parts.pop();
    onOpenContextDirectory(parts.join("/"));
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
            t("agentSession.waitingForEvents", {
              provider: session.terminal_provider_label,
            })}
        </Text>
      </Card>

      {interactions.map((interaction) => (
        <InteractionCard
          key={interaction.interaction_id}
          interaction={interaction}
          onAnswer={onAnswerInteraction}
        />
      ))}

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
            const presentation = conversationPresentation(
              event,
              session.terminal_provider_label,
            );
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
                    presentation.kind === "agent" && styles.codexMessageBubble,
                    presentation.kind === "system" && styles.systemMessageBubble,
                  ]}
                >
                  <Text
                    style={[
                      styles.messageActor,
                      presentation.kind === "user" && styles.userMessageActor,
                      presentation.kind === "agent" && styles.codexMessageActor,
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
        <View style={styles.composerHeader}>
          <Text style={styles.composerTitle}>
            {t("agentSession.composerTitle")}
          </Text>
          {contextWorkspacePath ? (
            <Button
              icon="folder"
              style={styles.contextToggle}
              variant="ghost"
              onPress={() => setContextPickerVisible((visible) => !visible)}
            >
              {t("agentSession.context.add", {
                count: attachedContextPaths.length,
              })}
            </Button>
          ) : null}
        </View>
        {attachedContextPaths.length > 0 ? (
          <ScrollView
            horizontal
            contentContainerStyle={styles.contextChipRow}
            showsHorizontalScrollIndicator={false}
          >
            {attachedContextPaths.map((relativePath) => (
              <Button
                key={relativePath}
                icon="close"
                style={styles.contextChip}
                onPress={() => toggleContextFile(relativePath)}
              >
                {relativePath}
              </Button>
            ))}
          </ScrollView>
        ) : null}
        {contextPickerVisible ? (
          <View style={styles.contextPicker}>
            <View style={styles.contextPickerHeader}>
              <Text numberOfLines={1} style={styles.contextDirectory}>
                {contextDirectoryPath || "/"}
              </Text>
              {contextDirectoryPath ? (
                <Button
                  icon="arrowLeft"
                  style={styles.contextBack}
                  variant="ghost"
                  onPress={openParentContextDirectory}
                >
                  {t("common.back")}
                </Button>
              ) : null}
            </View>
            <ScrollView
              nestedScrollEnabled
              style={styles.contextEntryScroll}
              contentContainerStyle={styles.contextEntryList}
            >
              {contextFileEntries.length === 0 ? (
                <Text style={styles.contextEmpty}>
                  {t("agentSession.context.empty")}
                </Text>
              ) : (
                contextFileEntries.map((entry) => {
                  const selected = attachedContextPaths.includes(
                    entry.relativePath,
                  );
                  return (
                    <Button
                      key={entry.relativePath}
                      disabled={
                        entry.type === "file" &&
                        !selected &&
                        attachedContextPaths.length >= 10
                      }
                      icon={entry.type === "directory" ? "folder" : "file"}
                      style={styles.contextEntry}
                      tone={selected ? "primary" : "secondary"}
                      variant={selected ? "solid" : "ghost"}
                      onPress={() =>
                        entry.type === "directory"
                          ? onOpenContextDirectory(entry.relativePath)
                          : toggleContextFile(entry.relativePath)
                      }
                    >
                      {entry.name}
                    </Button>
                  );
                })
              )}
            </ScrollView>
          </View>
        ) : null}
        <TextInput
          value={draft}
          onChangeText={setDraft}
          autoCapitalize="sentences"
          autoCorrect
          multiline
          placeholder={t("agentSession.composerPlaceholder", {
            provider: session.terminal_provider_label,
          })}
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

function InteractionCard({
  interaction,
  onAnswer,
}: {
  interaction: AgentInteractionRequestPayload;
  onAnswer(
    interaction: AgentInteractionRequestPayload,
    decision: AgentInteractionAnswerPayload["decision"],
    answers?: Record<string, string[]>,
  ): void;
}): JSX.Element {
  const { t } = useTranslation();
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const details = interaction.details;
  const isQuestion = details.type === "user_input";
  const canSubmitAnswers =
    isQuestion &&
    details.questions.every(
      (question) =>
        !question.required || (answers[question.id]?.length ?? 0) > 0,
    );

  function selectOption(
    question: Extract<
      typeof details,
      { type: "user_input" }
    >["questions"][number],
    value: string,
  ): void {
    setAnswers((current) => {
      const selected = current[question.id] ?? [];
      const next = question.multiple
        ? selected.includes(value)
          ? selected.filter((item) => item !== value)
          : [...selected, value]
        : [value];
      return { ...current, [question.id]: next };
    });
  }

  function submit(
    decision: AgentInteractionAnswerPayload["decision"],
    submittedAnswers?: Record<string, string[]>,
  ): void {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    onAnswer(interaction, decision, submittedAnswers);
  }

  return (
    <Card style={styles.interactionCard}>
      <Text style={styles.interactionEyebrow}>
        {isQuestion
          ? t("agentSession.interaction.inputRequired")
          : t("agentSession.interaction.approvalRequired")}
      </Text>
      <Text style={styles.interactionTitle}>{interaction.title}</Text>
      {interaction.summary ? (
        <Text style={styles.interactionSummary}>{interaction.summary}</Text>
      ) : null}
      <InteractionDetails details={details} />
      {isQuestion
        ? details.questions.map((question) => (
            <View key={question.id} style={styles.questionBlock}>
              <Text style={styles.questionPrompt}>
                {question.prompt}
                {question.required ? " *" : ""}
              </Text>
              {question.options ? (
                <View style={styles.optionRow}>
                  {question.options.map((option) => {
                    const selected = (
                      answers[question.id] ?? []
                    ).includes(option.value);
                    return (
                      <Button
                        key={option.value}
                        style={styles.optionButton}
                        tone={selected ? "primary" : "secondary"}
                        variant={selected ? "solid" : "outline"}
                        onPress={() => selectOption(question, option.value)}
                      >
                        {option.label}
                      </Button>
                    );
                  })}
                </View>
              ) : null}
              {question.allow_text || !question.options ? (
                <TextInput
                  value={answers[question.id]?.[0] ?? ""}
                  onChangeText={(value) =>
                    setAnswers((current) => ({
                      ...current,
                      [question.id]: value ? [value] : [],
                    }))
                  }
                  placeholder={t("agentSession.interaction.answerPlaceholder")}
                  placeholderTextColor={colors.textDim}
                  style={styles.answerInput}
                />
              ) : null}
            </View>
          ))
        : null}
      <View style={styles.interactionActions}>
        <Button
          disabled={submitting}
          tone="danger"
          onPress={() => submit("decline")}
        >
          {t("agentSession.interaction.decline")}
        </Button>
        <Button
          disabled={submitting || (isQuestion && !canSubmitAnswers)}
          tone="primary"
          variant="solid"
          onPress={() =>
            submit(
              isQuestion ? "submit_answers" : "allow_once",
              isQuestion ? answers : undefined,
            )
          }
        >
          {isQuestion
            ? t("agentSession.interaction.submitAnswers")
            : t("agentSession.interaction.allowOnce")}
        </Button>
      </View>
    </Card>
  );
}

function InteractionDetails({
  details,
}: {
  details: AgentInteractionRequestPayload["details"];
}): JSX.Element | null {
  switch (details.type) {
    case "command_approval":
      return (
        <View style={styles.interactionCodeBlock}>
          <Text selectable style={styles.interactionCode}>
            {details.command}
          </Text>
          {details.cwd ? (
            <Text selectable style={styles.interactionPath}>
              {details.cwd}
            </Text>
          ) : null}
        </View>
      );
    case "file_change_approval":
      return (
        <View style={styles.interactionCodeBlock}>
          {details.paths.map((path) => (
            <Text key={path} selectable style={styles.interactionPath}>
              {path}
            </Text>
          ))}
        </View>
      );
    case "permissions_approval":
      return (
        <Text style={styles.interactionSummary}>
          {details.permissions.join(", ")}
        </Text>
      );
    case "user_input":
      return null;
  }
}

function isConversationEvent(event: AgentSurfaceEventPayload): boolean {
  return (
    event.event_type === "agent.user_prompt_submitted" ||
    isAgentMessage(event) ||
    event.event_type === "agent.failed"
  );
}

function conversationPresentation(
  event: AgentSurfaceEventPayload,
  providerLabel: string,
): {
  actor: string;
  kind: "user" | "agent" | "system";
  text: string;
} {
  if (event.event_type === "agent.user_prompt_submitted") {
    return {
      actor: "You",
      kind: "user",
      text: event.summary ?? "",
    };
  }
  if (isAgentMessage(event)) {
    return {
      actor: providerLabel,
      kind: "agent",
      text: event.summary ?? event.title,
    };
  }
  return {
    actor: "OmniWork Agent",
    kind: "system",
    text: event.summary ?? event.title,
  };
}

function isAgentMessage(event: AgentSurfaceEventPayload): boolean {
  const item = event.payload?.item;
  return (
    event.payload?.message_role === "assistant" ||
    (Boolean(item) &&
      typeof item === "object" &&
      (item as { type?: unknown }).type === "agent_message")
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
  interactionCard: {
    gap: spacing.sm,
    borderColor: colors.warning,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.warningSoft,
  },
  interactionEyebrow: {
    color: colors.warning,
    ...typography.eyebrow,
  },
  interactionTitle: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: "800",
  },
  interactionSummary: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  interactionCodeBlock: {
    gap: spacing.xs,
    padding: spacing.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.background,
  },
  interactionCode: {
    color: colors.textPrimary,
    fontSize: 13,
    fontFamily: Platform.select({
      ios: "Menlo",
      android: "monospace",
      default: "monospace",
    }),
  },
  interactionPath: {
    color: colors.textMuted,
    fontSize: 12,
  },
  interactionActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.sm,
  },
  questionBlock: {
    gap: spacing.sm,
  },
  questionPrompt: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "700",
  },
  optionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  optionButton: {
    minHeight: 36,
  },
  answerInput: {
    minHeight: 44,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.background,
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
  composerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  composerTitle: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "800",
  },
  contextToggle: {
    minHeight: 34,
  },
  contextChipRow: {
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  contextChip: {
    minHeight: 34,
    maxWidth: 240,
  },
  contextPicker: {
    maxHeight: 190,
    gap: spacing.xs,
    padding: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.sm,
    backgroundColor: colors.background,
  },
  contextPickerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  contextDirectory: {
    flex: 1,
    color: colors.textMuted,
    fontSize: 12,
  },
  contextBack: {
    minHeight: 32,
  },
  contextEntryScroll: {
    maxHeight: 140,
  },
  contextEntryList: {
    gap: spacing.xs,
  },
  contextEntry: {
    minHeight: 34,
    justifyContent: "flex-start",
  },
  contextEmpty: {
    color: colors.textDim,
    fontSize: 12,
    paddingVertical: spacing.sm,
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
