import { createHash } from "node:crypto";

import type {
  AgentProbeEvent,
  AgentProbeEventType,
  AgentProbeSeverity,
} from "@omniwork/protocol-ts";

export interface ClaudeHookPayload {
  session_id?: unknown;
  transcript_path?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  omniwork_hook_event?: unknown;
  omniwork_hook_source?: unknown;
  source?: unknown;
  prompt?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
  message?: unknown;
  stop_hook_active?: unknown;
  trigger?: unknown;
  permission_mode?: unknown;
  reason?: unknown;
  agent_id?: unknown;
  agent_type?: unknown;
}

export function normalizeClaudeHookPayload(
  payload: ClaudeHookPayload,
): AgentProbeEvent | null {
  const hookName =
    readString(payload.hook_event_name) ??
    readString(payload.omniwork_hook_event);
  const sessionId = readString(payload.session_id);
  if (!hookName || !sessionId) {
    return null;
  }

  const eventType = eventTypeFromHook(hookName);
  if (!eventType) {
    return null;
  }

  const toolName = readString(payload.tool_name);
  const cwd = readString(payload.cwd);

  return {
    id: hookEventId(payload, hookName, sessionId),
    provider: "claude-code",
    probe_id: "claude-code-hooks",
    session_id: sessionId,
    workspace_path: cwd,
    event_type: eventType,
    severity: severityFromHook(hookName),
    title: titleFromHook(hookName, toolName),
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
    case "SessionEnd":
      return "agent.exited";
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
      return "Claude Code session started";
    case "UserPromptSubmit":
      return "Claude Code prompt submitted";
    case "PreToolUse":
      return toolName
        ? `Claude Code started ${toolName}`
        : "Claude Code started a tool";
    case "PermissionRequest":
      return toolName
        ? `Claude Code needs approval for ${toolName}`
        : "Claude Code needs approval";
    case "PostToolUse":
      return toolName
        ? `Claude Code finished ${toolName}`
        : "Claude Code finished a tool";
    case "Stop":
      return "Claude Code turn completed";
    case "SessionEnd":
      return "Claude Code session ended";
    case "SubagentStart":
      return "Claude Code subagent started";
    case "SubagentStop":
      return "Claude Code subagent completed";
    case "PreCompact":
      return "Claude Code compaction started";
    case "PostCompact":
      return "Claude Code compaction completed";
    default:
      return "Claude Code event";
  }
}

function summaryFromHook(
  hookName: string,
  payload: ClaudeHookPayload,
): string | undefined {
  const prompt = readString(payload.prompt);
  const source = readString(payload.source);
  const trigger = readString(payload.trigger);
  const message = readString(payload.message);
  const reason = readString(payload.reason);
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

function sanitizePayload(payload: ClaudeHookPayload): Record<string, unknown> {
  return {
    hook_event_name: readString(payload.hook_event_name),
    omniwork_hook_event: readString(payload.omniwork_hook_event),
    omniwork_hook_source: readString(payload.omniwork_hook_source),
    cwd: readString(payload.cwd),
    source: readString(payload.source),
    tool_name: readString(payload.tool_name),
    trigger: readString(payload.trigger),
    permission_mode: readString(payload.permission_mode),
    reason: readString(payload.reason),
    agent_id: readString(payload.agent_id),
    agent_type: readString(payload.agent_type),
    transcript_path: readString(payload.transcript_path),
  };
}

function hookEventId(
  payload: ClaudeHookPayload,
  hookName: string,
  sessionId: string,
): string {
  const stable = JSON.stringify({
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
