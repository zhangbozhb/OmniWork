import { createHash } from "node:crypto";

import type {
  AgentProbeEvent,
  AgentProbeEventType,
  AgentProbeSeverity,
} from "@omniwork/protocol-ts";

export interface CodexHookPayload {
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  omniwork_hook_event?: unknown;
  omniwork_hook_source?: unknown;
  model?: unknown;
  turn_id?: unknown;
  source?: unknown;
  prompt?: unknown;
  tool_name?: unknown;
  tool_use_id?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
  last_assistant_message?: unknown;
  stop_hook_active?: unknown;
  agent_id?: unknown;
  agent_type?: unknown;
  agent_transcript_path?: unknown;
  trigger?: unknown;
  permission_mode?: unknown;
}

export function normalizeCodexHookPayload(
  payload: CodexHookPayload,
): AgentProbeEvent | null {
  const hookName =
    readString(payload.hook_event_name) ??
    readString(payload.omniwork_hook_event);
  const sessionId = readString(payload.session_id);
  if (!hookName || !sessionId) {
    return null;
  }

  const now = new Date().toISOString();
  const turnId = readString(payload.turn_id);
  const eventType = eventTypeFromHook(hookName);
  if (!eventType) {
    return null;
  }

  const toolName = readString(payload.tool_name);
  const cwd = readString(payload.cwd);
  const summary = summaryFromHook(hookName, payload);

  return {
    id: hookEventId(payload, hookName, sessionId, turnId),
    provider: "codex",
    probe_id: "codex-hooks",
    session_id: sessionId,
    workspace_path: cwd,
    event_type: eventType,
    severity: severityFromHook(hookName),
    title: titleFromHook(hookName, toolName),
    summary,
    payload: sanitizePayload(payload),
    source: {
      kind: "cli-hook",
      raw_event_id: readString(payload.tool_use_id) ?? turnId ?? hookName,
    },
    created_at: now,
  };
}

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
    case "PostToolUse":
      return "agent.tool_call_finished";
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
    default:
      return null;
  }
}

function severityFromHook(hookName: string): AgentProbeSeverity {
  if (hookName === "PermissionRequest") {
    return "warning";
  }
  if (hookName === "PostToolUse") {
    return "info";
  }
  return "notice";
}

function titleFromHook(hookName: string, toolName: string | undefined): string {
  switch (hookName) {
    case "SessionStart":
      return "Codex session started";
    case "UserPromptSubmit":
      return "Codex prompt submitted";
    case "PreToolUse":
      return toolName ? `Codex started ${toolName}` : "Codex started a tool";
    case "PermissionRequest":
      return toolName
        ? `Codex needs approval for ${toolName}`
        : "Codex needs approval";
    case "PostToolUse":
      return toolName ? `Codex finished ${toolName}` : "Codex finished a tool";
    case "Stop":
      return "Codex turn completed";
    case "SubagentStart":
      return "Codex subagent started";
    case "SubagentStop":
      return "Codex subagent completed";
    case "PreCompact":
      return "Codex compaction started";
    case "PostCompact":
      return "Codex compaction completed";
    default:
      return "Codex event";
  }
}

function summaryFromHook(
  hookName: string,
  payload: CodexHookPayload,
): string | undefined {
  const prompt = readString(payload.prompt);
  const source = readString(payload.source);
  const trigger = readString(payload.trigger);
  const assistantMessage = readString(payload.last_assistant_message);
  const toolInput = readToolInputSummary(payload.tool_input);

  if (hookName === "UserPromptSubmit") {
    return truncate(prompt, 240);
  }
  if (hookName === "SessionStart") {
    return source ? `source: ${source}` : undefined;
  }
  if (hookName === "PreCompact" || hookName === "PostCompact") {
    return trigger ? `trigger: ${trigger}` : undefined;
  }
  if (toolInput) {
    return truncate(toolInput, 240);
  }
  if (hookName === "Stop") {
    return truncate(assistantMessage, 240);
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
  return undefined;
}

function sanitizePayload(payload: CodexHookPayload): Record<string, unknown> {
  return {
    hook_event_name: readString(payload.hook_event_name),
    omniwork_hook_event: readString(payload.omniwork_hook_event),
    omniwork_hook_source: readString(payload.omniwork_hook_source),
    cwd: readString(payload.cwd),
    model: readString(payload.model),
    turn_id: readString(payload.turn_id),
    source: readString(payload.source),
    tool_name: readString(payload.tool_name),
    tool_use_id: readString(payload.tool_use_id),
    trigger: readString(payload.trigger),
    permission_mode: readString(payload.permission_mode),
    agent_id: readString(payload.agent_id),
    agent_type: readString(payload.agent_type),
    transcript_path: readString(payload.transcript_path),
    agent_transcript_path: readString(payload.agent_transcript_path),
  };
}

function hookEventId(
  payload: CodexHookPayload,
  hookName: string,
  sessionId: string,
  turnId: string | undefined,
): string {
  const stable = JSON.stringify({
    hookName,
    sessionId,
    turnId,
    toolUseId: readString(payload.tool_use_id),
    source: readString(payload.source),
    trigger: readString(payload.trigger),
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

function truncate(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length > maxLength
    ? `${value.slice(0, maxLength - 3)}...`
    : value;
}
