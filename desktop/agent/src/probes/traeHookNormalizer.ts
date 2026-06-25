import { createHash } from "node:crypto";

import type {
  AgentProbeEvent,
  AgentProbeEventType,
  AgentProbeProvider,
  AgentProbeSeverity,
} from "@omniwork/protocol-ts";

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
  source?: unknown;
  prompt?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
  message?: unknown;
  notification_type?: unknown;
  trigger?: unknown;
  permission_mode?: unknown;
  reason?: unknown;
  agent_id?: unknown;
  agent_type?: unknown;
}

export function normalizeTraeHookPayload(
  provider: "trae" | "trae-cn",
  payload: TraeHookPayload,
): AgentProbeEvent | null {
  const hookName = readHookName(payload);
  const sessionId =
    readString(payload.session_id) ?? readString(payload.conversation_id);
  if (!hookName || !sessionId) {
    return null;
  }

  const eventType = eventTypeFromHook(hookName);
  if (!eventType) {
    return null;
  }

  const toolName = readString(payload.tool_name);
  const workspacePath =
    readString(payload.workspace_path) ?? readString(payload.cwd);
  const displayName = provider === "trae-cn" ? "Trae CN" : "Trae";

  return {
    id: hookEventId(provider, payload, hookName, sessionId),
    provider,
    probe_id: `${provider}-hooks`,
    session_id: sessionId,
    workspace_path: workspacePath,
    event_type: eventType,
    severity: severityFromHook(hookName),
    title: titleFromHook(displayName, hookName, toolName),
    summary: summaryFromHook(hookName, payload),
    payload: sanitizePayload(payload),
    source: {
      kind: "cli-hook",
      raw_event_id:
        readString(payload.reason) ??
        readString(payload.trigger) ??
        readString(payload.source) ??
        hookName,
    },
    created_at: new Date().toISOString(),
  };
}

export function normalizeTraeProbeProvider(
  provider: AgentProbeProvider,
): "trae" | "trae-cn" | null {
  switch (provider) {
    case "trae":
    case "traex":
    case "coco":
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
  post_tool_use_failure: "PostToolUseFailure",
  permission_request: "PermissionRequest",
  permission_denied: "PermissionDenied",
  notification: "Notification",
  stop: "Stop",
  session_end: "SessionEnd",
  pre_compact: "PreCompact",
  post_compact: "PostCompact",
  subagent_start: "SubagentStart",
  subagent_stop: "SubagentStop",
};

function eventTypeFromHook(hookName: string): AgentProbeEventType | null {
  switch (hookName) {
    case "SessionStart":
      return "agent.started";
    case "UserPromptSubmit":
      return "agent.user_prompt_submitted";
    case "PreToolUse":
      return "agent.tool_call_started";
    case "PermissionRequest":
      return "agent.approval_required";
    case "PermissionDenied":
    case "PostToolUseFailure":
      return "agent.failed";
    case "PostToolUse":
      return "agent.tool_call_finished";
    case "Notification":
      return "agent.waiting_user_input";
    case "PreCompact":
      return "agent.compaction_started";
    case "PostCompact":
      return "agent.compaction_finished";
    case "SubagentStart":
      return "agent.subagent_started";
    case "SubagentStop":
      return "agent.subagent_completed";
    case "Stop":
      return "agent.completed";
    case "SessionEnd":
      return "agent.exited";
    default:
      return null;
  }
}

function severityFromHook(hookName: string): AgentProbeSeverity {
  if (hookName === "PermissionRequest" || hookName === "Notification") {
    return "warning";
  }
  if (hookName === "PermissionDenied" || hookName === "PostToolUseFailure") {
    return "critical";
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
    case "PermissionRequest":
      return toolName
        ? `${displayName} needs approval for ${toolName}`
        : `${displayName} needs approval`;
    case "PermissionDenied":
      return toolName
        ? `${displayName} permission denied for ${toolName}`
        : `${displayName} permission denied`;
    case "PostToolUse":
      return toolName
        ? `${displayName} finished ${toolName}`
        : `${displayName} finished a tool`;
    case "PostToolUseFailure":
      return toolName
        ? `${displayName} failed ${toolName}`
        : `${displayName} tool failed`;
    case "Notification":
      return `${displayName} notification`;
    case "Stop":
      return `${displayName} turn completed`;
    case "SessionEnd":
      return `${displayName} session ended`;
    case "SubagentStart":
      return `${displayName} subagent started`;
    case "SubagentStop":
      return `${displayName} subagent completed`;
    case "PreCompact":
      return `${displayName} compaction started`;
    case "PostCompact":
      return `${displayName} compaction completed`;
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
  const trigger = readString(payload.trigger);
  const message = readString(payload.message);
  const reason = readString(payload.reason);
  const notificationType = readString(payload.notification_type);
  const toolInput = readToolInputSummary(payload.tool_input);

  if (hookName === "UserPromptSubmit") {
    return truncate(prompt, 240);
  }
  if (hookName === "SessionStart") {
    return source ? `source: ${source}` : undefined;
  }
  if (hookName === "SessionEnd") {
    return reason ? `reason: ${reason}` : undefined;
  }
  if (hookName === "Notification") {
    return truncate(message ?? notificationType, 240);
  }
  if (hookName === "PermissionDenied" || hookName === "PostToolUseFailure") {
    return truncate(reason ?? message ?? toolInput, 240);
  }
  if (hookName === "PreCompact" || hookName === "PostCompact") {
    return trigger ? `trigger: ${trigger}` : undefined;
  }
  if (toolInput) {
    return truncate(toolInput, 240);
  }
  if (hookName === "Stop") {
    return truncate(message, 240);
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
    cwd: readString(payload.cwd),
    workspace_path: readString(payload.workspace_path),
    source: readString(payload.source),
    tool_name: readString(payload.tool_name),
    notification_type: readString(payload.notification_type),
    trigger: readString(payload.trigger),
    permission_mode: readString(payload.permission_mode),
    reason: readString(payload.reason),
    agent_id: readString(payload.agent_id),
    agent_type: readString(payload.agent_type),
  };
}

function hookEventId(
  provider: string,
  payload: TraeHookPayload,
  hookName: string,
  sessionId: string,
): string {
  const stable = JSON.stringify({
    provider,
    hookName,
    sessionId,
    toolName: readString(payload.tool_name),
    source: readString(payload.source),
    trigger: readString(payload.trigger),
    reason: readString(payload.reason),
  });
  return createHash("sha256").update(stable).digest("hex").slice(0, 32);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}
