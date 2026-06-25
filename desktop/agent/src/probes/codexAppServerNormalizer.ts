import { createHash } from "node:crypto";

import type {
  AgentProbeEvent,
  AgentProbeEventType,
  AgentProbeSeverity,
} from "@omniwork/protocol-ts";

export interface CodexAppServerEventPayload {
  type?: unknown;
  event?: unknown;
  name?: unknown;
  id?: unknown;
  thread_id?: unknown;
  turn_id?: unknown;
  item_id?: unknown;
  approval_id?: unknown;
  session_id?: unknown;
  workspace_path?: unknown;
  cwd?: unknown;
  title?: unknown;
  summary?: unknown;
  message?: unknown;
  error?: unknown;
  tool_name?: unknown;
  files?: unknown;
  diff?: unknown;
}

export function normalizeCodexAppServerEvent(
  payload: CodexAppServerEventPayload,
): AgentProbeEvent | null {
  const rawEventType =
    readString(payload.type) ??
    readString(payload.event) ??
    readString(payload.name);
  if (!rawEventType) {
    return null;
  }

  const eventType = toAgentEventType(rawEventType);
  if (!eventType) {
    return null;
  }

  const threadId =
    readString(payload.thread_id) ?? readString(payload.session_id);
  if (!threadId) {
    return null;
  }

  const turnId = readString(payload.turn_id);
  const rawEventId =
    readString(payload.id) ??
    readString(payload.item_id) ??
    readString(payload.approval_id) ??
    turnId ??
    rawEventType;
  const workspacePath =
    readString(payload.workspace_path) ?? readString(payload.cwd);

  return {
    id: appServerEventId(payload, rawEventType, threadId, rawEventId),
    provider: "codex",
    probe_id: "codex-app-server",
    session_id: threadId,
    workspace_path: workspacePath,
    event_type: eventType,
    severity: severityFromEventType(eventType),
    title: titleFromEvent(rawEventType, payload),
    summary: summaryFromEvent(payload),
    payload: sanitizePayload(payload),
    source: {
      kind: "app-server",
      raw_event_id: rawEventId,
    },
    created_at: new Date().toISOString(),
  };
}

function toAgentEventType(rawEventType: string): AgentProbeEventType | null {
  switch (rawEventType) {
    case "thread.started":
    case "session.started":
      return "agent.started";
    case "thread.updated":
    case "turn.started":
    case "turn.running":
      return "agent.thinking";
    case "plan.updated":
    case "plan.created":
      return "agent.plan_created";
    case "tool.started":
    case "item.tool.started":
      return "agent.tool_call_started";
    case "tool.finished":
    case "item.tool.finished":
      return "agent.tool_call_finished";
    case "approval.requested":
    case "turn.waiting_for_approval":
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return "agent.approval_required";
    case "turn.waiting_for_input":
    case "turn.waiting_user_input":
      return "agent.waiting_user_input";
    case "file.changed":
      return "agent.file_changed";
    case "diff.updated":
    case "git.diff.updated":
      return "agent.git_diff_changed";
    case "turn.completed":
    case "thread.completed":
      return "agent.completed";
    case "turn.failed":
    case "thread.failed":
    case "error":
      return "agent.failed";
    case "thread.exited":
    case "session.exited":
      return "agent.exited";
    default:
      return null;
  }
}

function severityFromEventType(
  eventType: AgentProbeEventType,
): AgentProbeSeverity {
  switch (eventType) {
    case "agent.approval_required":
    case "agent.waiting_user_input":
      return "warning";
    case "agent.failed":
      return "critical";
    case "agent.thinking":
    case "agent.tool_call_started":
    case "agent.tool_call_finished":
      return "info";
    default:
      return "notice";
  }
}

function titleFromEvent(
  rawEventType: string,
  payload: CodexAppServerEventPayload,
): string {
  const title = readString(payload.title);
  if (title) {
    return title;
  }

  const toolName = readString(payload.tool_name);
  switch (rawEventType) {
    case "approval.requested":
    case "turn.waiting_for_approval":
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return toolName
        ? `Codex needs approval for ${toolName}`
        : "Codex needs approval";
    case "diff.updated":
    case "git.diff.updated":
      return "Codex updated the diff";
    case "turn.completed":
    case "thread.completed":
      return "Codex turn completed";
    case "turn.failed":
    case "thread.failed":
    case "error":
      return "Codex failed";
    default:
      return "Codex event";
  }
}

function summaryFromEvent(
  payload: CodexAppServerEventPayload,
): string | undefined {
  return truncate(
    readString(payload.summary) ??
      readString(payload.message) ??
      readString(payload.error) ??
      summarizeFiles(payload.files) ??
      summarizeDiff(payload.diff),
    240,
  );
}

function summarizeFiles(files: unknown): string | undefined {
  if (!Array.isArray(files) || files.length === 0) {
    return undefined;
  }
  const paths = files
    .map((file) => {
      if (typeof file === "string") {
        return file;
      }
      if (file && typeof file === "object") {
        return readString((file as Record<string, unknown>).path);
      }
      return undefined;
    })
    .filter((path): path is string => Boolean(path));
  if (paths.length === 0) {
    return undefined;
  }
  return paths.slice(0, 3).join(", ");
}

function summarizeDiff(diff: unknown): string | undefined {
  if (typeof diff !== "string") {
    return undefined;
  }
  return diff.split("\n").find((line) => line.trim().length > 0);
}

function sanitizePayload(
  payload: CodexAppServerEventPayload,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined),
  );
}

function appServerEventId(
  payload: CodexAppServerEventPayload,
  rawEventType: string,
  threadId: string,
  rawEventId: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        rawEventType,
        threadId,
        rawEventId,
        turnId: readString(payload.turn_id),
      }),
    )
    .digest("hex")
    .slice(0, 24);
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
  if (!value || value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}...`;
}
