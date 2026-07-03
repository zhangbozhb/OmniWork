import { createHash } from "node:crypto";

import { Codex } from "@openai/codex-sdk";
import type {
  Thread,
  ThreadEvent,
  ThreadItem,
} from "@openai/codex-sdk";
import type {
  AgentProbeEventType,
  AgentSurfaceEventPayload,
  TerminalSession,
} from "@omniwork/protocol-ts";

import type { Logger } from "../../telemetry/logger.ts";

interface CodexSdkSurfaceAdapterOptions {
  logger: Logger;
  getSession(sessionId: string): Promise<TerminalSession | undefined>;
  onSurfaceEvent(event: AgentSurfaceEventPayload): void;
}

export interface CodexSdkPromptInput {
  sessionId: string;
  surfaceId: string;
  prompt: string;
}

interface CodexSdkThreadBinding {
  thread: Thread | null;
  threadId: string | null;
  queue: Promise<void>;
  turnCounter: number;
}

export class CodexSdkSurfaceAdapter {
  private readonly logger: Logger;
  private readonly getSession: (
    sessionId: string,
  ) => Promise<TerminalSession | undefined>;
  private readonly onSurfaceEvent: (event: AgentSurfaceEventPayload) => void;
  private codex: Codex | null = null;
  private readonly bindings = new Map<string, CodexSdkThreadBinding>();

  constructor(options: CodexSdkSurfaceAdapterOptions) {
    this.logger = options.logger;
    this.getSession = options.getSession;
    this.onSurfaceEvent = options.onSurfaceEvent;
  }

  submitPrompt(input: CodexSdkPromptInput): void {
    const binding = this.getOrCreateBinding(input.sessionId);
    const queued = binding.queue
      .catch(() => undefined)
      .then(() => this.runPrompt(input, binding));
    binding.queue = queued.catch((error) => {
      this.logger.warn("codex sdk prompt failed", {
        session_id: input.sessionId,
        surface_id: input.surfaceId,
        error: String(error),
      });
      this.emitFailure(input, error);
    });
  }

  private getOrCreateBinding(sessionId: string): CodexSdkThreadBinding {
    const existing = this.bindings.get(sessionId);
    if (existing) {
      return existing;
    }
    const binding: CodexSdkThreadBinding = {
      thread: null,
      threadId: null,
      queue: Promise.resolve(),
      turnCounter: 0,
    };
    this.bindings.set(sessionId, binding);
    return binding;
  }

  private async runPrompt(
    input: CodexSdkPromptInput,
    binding: CodexSdkThreadBinding,
  ): Promise<void> {
    const session = await this.getSession(input.sessionId);
    if (!session) {
      throw new Error("Session was not found");
    }
    if (session.runtime?.kind !== "app_server") {
      throw new Error("Session is not an app_server runtime session");
    }
    if (session.terminal_provider_kind !== "codex") {
      throw new Error("Session is not backed by the Codex provider");
    }

    if (!binding.threadId) {
      binding.thread = this.getCodex().startThread({
        workingDirectory: session.cwd,
        skipGitRepoCheck: session.git_repository === false,
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
      });
    }
    if (!binding.thread) {
      throw new Error("Codex SDK thread is not initialized");
    }

    binding.turnCounter += 1;
    const turnKey = `${input.sessionId}:${binding.turnCounter}`;
    const { events } = await binding.thread.runStreamed(input.prompt);
    for await (const event of events) {
      if (event.type === "thread.started") {
        binding.threadId = event.thread_id;
      }
      const surfaceEvent = toSurfaceEvent({
        event,
        input,
        turnKey,
        threadId: binding.threadId,
      });
      if (surfaceEvent) {
        this.onSurfaceEvent(surfaceEvent);
      }
    }
    binding.threadId = binding.thread.id ?? binding.threadId;
  }

  private getCodex(): Codex {
    if (!this.codex) {
      this.codex = new Codex();
    }
    return this.codex;
  }

  private emitFailure(input: CodexSdkPromptInput, error: unknown): void {
    this.onSurfaceEvent({
      session_id: input.sessionId,
      surface_id: input.surfaceId,
      provider: "codex",
      event_id: stableEventId(input.sessionId, "sdk-error", String(error)),
      event_type: "agent.failed",
      title: "Codex failed",
      summary: error instanceof Error ? error.message : String(error),
      payload: {
        error: String(error),
      },
      source: {
        kind: "sdk",
      },
      created_at: new Date().toISOString(),
    });
  }
}

function toSurfaceEvent(input: {
  event: ThreadEvent;
  input: CodexSdkPromptInput;
  turnKey: string;
  threadId: string | null;
}): AgentSurfaceEventPayload | null {
  const { event } = input;
  if (event.type === "thread.started") {
    return baseEvent(input, {
      rawEventId: event.thread_id,
      eventType: "agent.started",
      title: "Codex thread started",
      summary: event.thread_id,
      payload: { thread_id: event.thread_id },
    });
  }
  if (event.type === "turn.started") {
    return baseEvent(input, {
      rawEventId: `${input.turnKey}:turn.started`,
      eventType: "agent.thinking",
      title: "Codex turn started",
    });
  }
  if (event.type === "turn.completed") {
    return baseEvent(input, {
      rawEventId: `${input.turnKey}:turn.completed`,
      eventType: "agent.completed",
      title: "Codex turn completed",
      summary: summarizeUsage(event.usage),
      payload: { usage: event.usage },
    });
  }
  if (event.type === "turn.failed") {
    return baseEvent(input, {
      rawEventId: `${input.turnKey}:turn.failed`,
      eventType: "agent.failed",
      title: "Codex turn failed",
      summary: event.error.message,
      payload: { error: event.error },
    });
  }
  if (event.type === "error") {
    return baseEvent(input, {
      rawEventId: `${input.turnKey}:error:${event.message}`,
      eventType: "agent.failed",
      title: "Codex failed",
      summary: event.message,
      payload: { error: event.message },
    });
  }

  const phase = event.type.split(".").at(-1) ?? event.type;
  return itemEvent(input, event.item, phase);
}

function itemEvent(
  input: {
    event: ThreadEvent;
    input: CodexSdkPromptInput;
    turnKey: string;
    threadId: string | null;
  },
  item: ThreadItem,
  phase: string,
): AgentSurfaceEventPayload {
  const completed = phase === "completed";
  const failed = "status" in item && item.status === "failed";
  const rawEventId = `${input.turnKey}:item:${item.id}`;
  switch (item.type) {
    case "agent_message":
      return baseEvent(input, {
        rawEventId,
        eventType: completed ? "agent.completed" : "agent.thinking",
        title: "Codex replied",
        summary: truncate(item.text, 2000),
        payload: { item, phase },
      });
    case "reasoning":
      return baseEvent(input, {
        rawEventId,
        eventType: "agent.thinking",
        title: "Codex is reasoning",
        summary: truncate(item.text, 600),
        payload: { item, phase },
      });
    case "command_execution":
      return baseEvent(input, {
        rawEventId,
        eventType: failed
          ? "agent.failed"
          : completed
            ? "agent.tool_call_finished"
            : "agent.tool_call_started",
        title: completed ? "Codex command finished" : "Codex command started",
        summary: item.command,
        payload: { item, phase },
      });
    case "file_change":
      return baseEvent(input, {
        rawEventId,
        eventType: failed ? "agent.failed" : "agent.file_changed",
        title: "Codex changed files",
        summary: item.changes.map((change) => change.path).join(", "),
        payload: { item, phase },
      });
    case "mcp_tool_call":
      return baseEvent(input, {
        rawEventId,
        eventType: failed
          ? "agent.failed"
          : completed
            ? "agent.tool_call_finished"
            : "agent.tool_call_started",
        title: `Codex used ${item.tool}`,
        summary: item.server,
        payload: { item, phase },
      });
    case "web_search":
      return baseEvent(input, {
        rawEventId,
        eventType: completed
          ? "agent.tool_call_finished"
          : "agent.tool_call_started",
        title: "Codex searched the web",
        summary: item.query,
        payload: { item, phase },
      });
    case "todo_list":
      return baseEvent(input, {
        rawEventId,
        eventType: "agent.plan_created",
        title: "Codex updated the plan",
        summary: summarizeTodoList(item),
        payload: { item, phase },
      });
    case "error":
      return baseEvent(input, {
        rawEventId,
        eventType: "agent.failed",
        title: "Codex reported an error",
        summary: item.message,
        payload: { item, phase },
      });
  }
}

function baseEvent(
  input: {
    input: CodexSdkPromptInput;
    turnKey: string;
    threadId: string | null;
  },
  event: {
    rawEventId: string;
    eventType: AgentProbeEventType;
    title: string;
    summary?: string;
    payload?: Record<string, unknown>;
  },
): AgentSurfaceEventPayload {
  return {
    session_id: input.input.sessionId,
    surface_id: input.input.surfaceId,
    provider: "codex",
    event_id: stableEventId(input.input.sessionId, event.rawEventId),
    event_type: event.eventType,
    title: event.title,
    summary: event.summary,
    payload: {
      ...(event.payload ?? {}),
      provider_thread_id: input.threadId,
    },
    source: {
      kind: "sdk",
      raw_event_id: event.rawEventId,
    },
    created_at: new Date().toISOString(),
  };
}

function stableEventId(...parts: string[]): string {
  return `codex_sdk_${createHash("sha256")
    .update(parts.join(":"))
    .digest("hex")
    .slice(0, 24)}`;
}

function summarizeUsage(usage: {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}): string {
  return `Input ${usage.input_tokens}, output ${usage.output_tokens}, reasoning ${usage.reasoning_output_tokens}`;
}

function summarizeTodoList(item: Extract<ThreadItem, { type: "todo_list" }>) {
  return item.items
    .slice(0, 3)
    .map((todo) => `${todo.completed ? "[x]" : "[ ]"} ${todo.text}`)
    .join("\n");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 3)}...`;
}
