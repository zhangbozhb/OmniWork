import { createHash } from "node:crypto";

import type {
  AgentProbeEvent,
  AgentProbeEventType,
  AgentProbeProvider,
  AgentProbeSeverity,
} from "@omni-work/protocol-ts";

export interface TraeHookPayload {
  session_id?: unknown;
  conversation_id?: unknown;
  cwd?: unknown;
  workspace_path?: unknown;
  hook_event_name?: unknown;
  omniwork_hook_event?: unknown;
  event?: unknown;
  event_name?: unknown;
  omniwork_hook_source?: unknown;
  omniwork_record_id?: unknown;
  source?: unknown;
  prompt?: unknown;
  tool_name?: unknown;
  llm_tool_name?: unknown;
  tool_use_id?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
  error?: unknown;
  title?: unknown;
  message?: unknown;
  notification_type?: unknown;
  reason?: unknown;
  last_assistant_message?: unknown;
  loop_count?: unknown;
  stop_hook_active?: unknown;
}

export function normalizeTraeHookPayload(
  provider: "traex" | "trae" | "trae-cn",
  payload: TraeHookPayload,
): AgentProbeEvent | null {
  const hookName = readHookName(payload);
  const sessionId =
    readString(payload.session_id) ?? readString(payload.conversation_id);
  if (!hookName || !sessionId) {
    return null;
  }

  const eventType = eventTypeFromHook(hookName, payload);
  if (!eventType) {
    return null;
  }

  const toolName =
    readString(payload.tool_name) ?? readString(payload.llm_tool_name);
  const workspacePath =
    readString(payload.workspace_path) ?? readString(payload.cwd);
  const displayName =
    provider === "traex"
      ? "TraeX"
      : provider === "trae-cn"
        ? "Trae CN"
        : "Trae";

  return {
    id: hookEventId(provider, payload, hookName, sessionId),
    provider,
    probe_id: `${provider}-hooks`,
    session_id: sessionId,
    workspace_path: workspacePath,
    event_type: eventType,
    severity: severityFromHook(hookName, payload),
    title: titleFromHook(displayName, hookName, toolName, payload),
    summary: summaryFromHook(hookName, payload),
    payload: sanitizePayload(payload),
    source: {
      kind: "cli-hook",
      raw_event_id:
        readString(payload.reason) ??
        readString(payload.notification_type) ??
        readString(payload.source) ??
        hookName,
    },
    created_at: new Date().toISOString(),
  };
}

export function normalizeTraeProbeProvider(
  provider: AgentProbeProvider,
): "traex" | "trae" | "trae-cn" | null {
  switch (provider) {
    case "traex":
    case "traecli":
    case "coco":
      return "traex";
    case "trae":
      return "trae";
    case "trae-cn":
    case "trae_cn":
    case "traecn":
      return "trae-cn";
    default:
      return null;
  }
}

function readHookName(payload: TraeHookPayload): string | undefined {
  const raw =
    readString(payload.hook_event_name) ??
    readString(payload.omniwork_hook_event) ??
    readString(payload.event_name) ??
    readString(payload.event);
  if (!raw) {
    return undefined;
  }
  return TRAE_HOOK_NAME_ALIASES[raw] ?? raw;
}

const TRAE_HOOK_NAME_ALIASES: Record<string, string> = {
  session_start: "SessionStart",
  user_prompt_submit: "UserPromptSubmit",
  pre_tool_use: "PreToolUse",
  post_tool_use: "PostToolUse",
  notification: "Notification",
  stop: "Stop",
};

function eventTypeFromHook(
  hookName: string,
  payload: TraeHookPayload,
): AgentProbeEventType | null {
  switch (hookName) {
    case "SessionStart":
      return "agent.started";
    case "UserPromptSubmit":
      return "agent.user_prompt_submitted";
    case "PreToolUse":
      return "agent.tool_call_started";
    case "PostToolUse":
      return "agent.tool_call_finished";
    case "Notification":
      return eventTypeFromNotification(payload);
    case "Stop":
      return "agent.completed";
    default:
      return null;
  }
}

function severityFromHook(
  hookName: string,
  payload: TraeHookPayload,
): AgentProbeSeverity {
  if (hookName === "Notification") {
    return eventTypeFromNotification(payload) === "agent.completed"
      ? "notice"
      : "warning";
  }
  if (hookName === "PostToolUse") {
    return "info";
  }
  return "notice";
}

function titleFromHook(
  displayName: string,
  hookName: string,
  toolName: string | undefined,
  payload: TraeHookPayload,
): string {
  switch (hookName) {
    case "SessionStart":
      return `${displayName} session started`;
    case "UserPromptSubmit":
      return `${displayName} prompt submitted`;
    case "PreToolUse":
      return toolName
        ? `${displayName} started ${toolName}`
        : `${displayName} started a tool`;
    case "PostToolUse":
      return toolName
        ? `${displayName} finished ${toolName}`
        : `${displayName} finished a tool`;
    case "Notification":
      return titleFromNotification(displayName, payload);
    case "Stop":
      return `${displayName} turn completed`;
    default:
      return `${displayName} event`;
  }
}

function summaryFromHook(
  hookName: string,
  payload: TraeHookPayload,
): string | undefined {
  const prompt = readString(payload.prompt);
  const source = readString(payload.source);
  const message = readString(payload.message);
  const lastAssistantMessage = readString(payload.last_assistant_message);
  const notificationType = readString(payload.notification_type);
  const toolInput = readToolInputSummary(payload.tool_input);

  if (hookName === "UserPromptSubmit") {
    return truncate(prompt, 240);
  }
  if (hookName === "SessionStart") {
    return source ? `source: ${source}` : undefined;
  }
  if (hookName === "Notification") {
    return truncate(message ?? notificationType, 240);
  }
  if (toolInput) {
    return truncate(toolInput, 240);
  }
  if (hookName === "Stop") {
    return truncate(lastAssistantMessage ?? message, 240);
  }
  return undefined;
}

function readToolInputSummary(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const command = readString(record.command);
  if (command) {
    return command;
  }
  const filePath = readString(record.file_path);
  if (filePath) {
    return filePath;
  }
  return undefined;
}

function sanitizePayload(payload: TraeHookPayload): Record<string, unknown> {
  return {
    hook_event_name: readString(payload.hook_event_name),
    omniwork_hook_event: readString(payload.omniwork_hook_event),
    event: readString(payload.event),
    event_name: readString(payload.event_name),
    omniwork_hook_source: readString(payload.omniwork_hook_source),
    omniwork_record_id: readString(payload.omniwork_record_id),
    cwd: readString(payload.cwd),
    workspace_path: readString(payload.workspace_path),
    source: readString(payload.source),
    tool_name: readString(payload.tool_name),
    llm_tool_name: readString(payload.llm_tool_name),
    tool_use_id: readString(payload.tool_use_id),
    error: readString(payload.error),
    title: readString(payload.title),
    message: readString(payload.message),
    notification_type: readString(payload.notification_type),
    reason: readString(payload.reason),
    last_assistant_message: readString(payload.last_assistant_message),
    loop_count: readNumber(payload.loop_count),
    stop_hook_active: readBoolean(payload.stop_hook_active),
  };
}

function hookEventId(
  provider: string,
  payload: TraeHookPayload,
  hookName: string,
  sessionId: string,
): string {
  const recordId = readString(payload.omniwork_record_id);
  if (recordId) {
    return recordId;
  }

  const stable = JSON.stringify({
    provider,
    hookName,
    sessionId,
    toolUseId: readString(payload.tool_use_id),
    toolName: readString(payload.tool_name) ?? readString(payload.llm_tool_name),
    source: readString(payload.source),
    reason: readString(payload.reason),
    prompt: readString(payload.prompt),
    message: readString(payload.message),
    notificationType: readString(payload.notification_type),
    error: readString(payload.error),
    lastAssistantMessage: readString(payload.last_assistant_message),
    loopCount: readNumber(payload.loop_count),
    stopHookActive: readBoolean(payload.stop_hook_active),
  });
  return createHash("sha256").update(stable).digest("hex").slice(0, 32);
}

function eventTypeFromNotification(
  payload: TraeHookPayload,
): AgentProbeEventType {
  const notificationType = readString(payload.notification_type);
  switch (notificationType) {
    case "permission_prompt":
    case "document_review":
      return "agent.approval_required";
    case "idle_prompt":
      return "agent.completed";
    default:
      return "agent.waiting_user_input";
  }
}

function titleFromNotification(
  displayName: string,
  payload: TraeHookPayload,
): string {
  const notificationType = readString(payload.notification_type);
  switch (notificationType) {
    case "permission_prompt":
      return `${displayName} needs approval`;
    case "document_review":
      return `${displayName} needs document review`;
    case "idle_prompt":
      return `${displayName} completed`;
    default:
      return `${displayName} notification`;
  }
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}
