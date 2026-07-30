import { createHash, randomUUID } from "node:crypto";

import type {
  AgentProbeEventType,
  AgentSurfaceEventPayload,
  TerminalSession,
} from "@omni-work/protocol-ts";

import type { Logger } from "../telemetry/logger.ts";
import {
  isRecord,
  JsonLineProcess,
  type JsonObject,
} from "./jsonLineProcess.ts";

interface AgentSurfaceRunnerOptions {
  logger: Logger;
  getSession(sessionId: string): Promise<TerminalSession | undefined>;
  onSurfaceEvent(event: AgentSurfaceEventPayload): void;
}

export interface AgentSurfacePromptInput {
  sessionId: string;
  surfaceId: string;
  prompt: string;
}

interface ProtocolSession {
  submitPrompt(prompt: string): Promise<void>;
  close(): void;
}

interface SessionBinding {
  session: ProtocolSession;
  queue: Promise<void>;
}

export class AgentSurfaceRunner {
  private readonly options: AgentSurfaceRunnerOptions;
  private readonly bindings = new Map<string, SessionBinding>();
  private readonly pendingBindings = new Map<string, Promise<SessionBinding>>();
  private readonly sessionEpochs = new Map<string, number>();
  private readonly closedSessionIds = new Set<string>();

  constructor(options: AgentSurfaceRunnerOptions) {
    this.options = options;
  }

  submitPrompt(input: AgentSurfacePromptInput): void {
    void this.getOrCreateBinding(input)
      .then((binding) => {
        const queued = binding.queue
          .catch(() => undefined)
          .then(() => binding.session.submitPrompt(input.prompt));
        binding.queue = queued.catch((error) => {
          this.bindings.delete(input.sessionId);
          binding.session.close();
          this.options.logger.warn("agent surface prompt failed", {
            session_id: input.sessionId,
            surface_id: input.surfaceId,
            error: String(error),
          });
          this.emitFailure(input, error);
        });
      })
      .catch((error) => {
        this.options.logger.warn("agent surface session failed", {
          session_id: input.sessionId,
          surface_id: input.surfaceId,
          error: String(error),
        });
        this.emitFailure(input, error);
      });
  }

  close(): void {
    for (const sessionId of this.pendingBindings.keys()) {
      this.sessionEpochs.set(sessionId, this.sessionEpoch(sessionId) + 1);
    }
    for (const binding of this.bindings.values()) {
      binding.session.close();
    }
    this.bindings.clear();
    this.pendingBindings.clear();
  }

  closeSession(sessionId: string): void {
    this.closedSessionIds.add(sessionId);
    this.sessionEpochs.set(sessionId, this.sessionEpoch(sessionId) + 1);
    const binding = this.bindings.get(sessionId);
    binding?.session.close();
    this.bindings.delete(sessionId);
    this.pendingBindings.delete(sessionId);
  }

  private async getOrCreateBinding(
    input: AgentSurfacePromptInput,
  ): Promise<SessionBinding> {
    if (this.closedSessionIds.has(input.sessionId)) {
      throw new Error("Session is closed");
    }
    const existing = this.bindings.get(input.sessionId);
    if (existing) {
      return existing;
    }
    const pending = this.pendingBindings.get(input.sessionId);
    if (pending) {
      return pending;
    }

    const epoch = this.sessionEpoch(input.sessionId);
    const creating = this.createBinding(input).then((binding) => {
      if (epoch !== this.sessionEpoch(input.sessionId)) {
        binding.session.close();
        this.bindings.delete(input.sessionId);
        throw new Error("Session was closed while its AgentSurface was starting");
      }
      return binding;
    });
    this.pendingBindings.set(input.sessionId, creating);
    try {
      return await creating;
    } finally {
      this.pendingBindings.delete(input.sessionId);
    }
  }

  private sessionEpoch(sessionId: string): number {
    return this.sessionEpochs.get(sessionId) ?? 0;
  }

  private async createBinding(
    input: AgentSurfacePromptInput,
  ): Promise<SessionBinding> {
    const session = await this.options.getSession(input.sessionId);
    if (!session) {
      throw new Error("Session was not found");
    }
    if (session.runtime?.kind !== "app_server") {
      throw new Error("Session is not an app_server runtime session");
    }

    const common = {
      session,
      surfaceId: input.surfaceId,
      logger: this.options.logger,
      onSurfaceEvent: this.options.onSurfaceEvent,
    };
    const protocolSession = isClaudeProvider(session.terminal_provider_kind)
      ? new ClaudeStreamJsonSession(common)
      : isAppServerProvider(session.terminal_provider_kind)
        ? new AppServerSession(common)
        : null;
    if (!protocolSession) {
      throw new Error(
        `Structured AgentSurface is not supported for ${session.terminal_provider_kind}`,
      );
    }

    const binding = {
      session: protocolSession,
      queue: Promise.resolve(),
    };
    this.bindings.set(input.sessionId, binding);
    return binding;
  }

  private emitFailure(input: AgentSurfacePromptInput, error: unknown): void {
    this.options.onSurfaceEvent({
      session_id: input.sessionId,
      surface_id: input.surfaceId,
      provider: "omniwork",
      event_id: stableEventId(input.sessionId, "runner-error", String(error)),
      event_type: "agent.failed",
      title: "Agent failed",
      summary: error instanceof Error ? error.message : String(error),
      payload: { error: String(error) },
      source: { kind: "process" },
      created_at: new Date().toISOString(),
    });
  }
}

interface ProtocolSessionOptions {
  session: TerminalSession;
  surfaceId: string;
  logger: Logger;
  onSurfaceEvent(event: AgentSurfaceEventPayload): void;
}

class AppServerSession implements ProtocolSession {
  private readonly options: ProtocolSessionOptions;
  private readonly provider: string;
  private readonly process: JsonLineProcess;
  private readonly textByItemId = new Map<string, string>();
  private initializePromise: Promise<void> | null = null;
  private threadId: string | null = null;
  private turnWaiter:
    | {
        resolve(): void;
        reject(error: Error): void;
      }
    | undefined;
  private closing = false;

  constructor(options: ProtocolSessionOptions) {
    this.options = options;
    this.provider = normalizeProvider(options.session.terminal_provider_kind);
    this.process = new JsonLineProcess({
      command: firstShellWord(options.session.command),
      args: ["app-server", "--listen", "stdio://"],
      cwd: options.session.cwd,
      logger: options.logger,
      logLabel: `${this.provider} app-server`,
      onMessage: (message) => this.handleMessage(message),
      onExit: (error) => this.handleExit(error),
    });
  }

  async submitPrompt(prompt: string): Promise<void> {
    await this.ensureThread();
    if (!this.threadId) {
      throw new Error(`${this.provider} app-server thread was not created`);
    }

    const completion = new Promise<void>((resolve, reject) => {
      this.turnWaiter = { resolve, reject };
    });
    try {
      await this.process.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: prompt }],
      });
      await completion;
    } catch (error) {
      this.turnWaiter = undefined;
      throw error;
    }
  }

  close(): void {
    this.closing = true;
    this.process.close();
  }

  private async ensureThread(): Promise<void> {
    if (this.threadId) {
      return;
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize();
    }
    await this.initializePromise;
  }

  private async initialize(): Promise<void> {
    await this.process.request("initialize", {
      clientInfo: {
        name: "omniwork",
        title: "OmniWork",
        version: "0.1.1",
      },
      capabilities: {},
    });
    this.process.notify("initialized", {});
    const result = await this.process.request("thread/start", {
      cwd: this.options.session.cwd,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      serviceName: "omniwork",
    });
    const thread = isRecord(result.thread) ? result.thread : null;
    if (!thread || typeof thread.id !== "string") {
      throw new Error(`${this.provider} app-server returned no thread id`);
    }
    this.threadId = thread.id;
  }

  private handleMessage(message: JsonObject): void {
    if (
      (typeof message.id === "number" || typeof message.id === "string") &&
      typeof message.method === "string"
    ) {
      this.handleServerRequest(message);
      return;
    }
    if (typeof message.method !== "string" || !isRecord(message.params)) {
      return;
    }

    const event = normalizeAppServerNotification({
      provider: this.provider,
      sessionId: this.options.session.session_id,
      surfaceId: this.options.surfaceId,
      method: message.method,
      params: message.params,
      textByItemId: this.textByItemId,
    });
    if (event) {
      this.options.onSurfaceEvent(event);
    }
    if (message.method === "turn/completed") {
      this.turnWaiter?.resolve();
      this.turnWaiter = undefined;
    }
  }

  private handleServerRequest(message: JsonObject): void {
    const method = String(message.method);
    const params = isRecord(message.params) ? message.params : {};
    const event = approvalEvent({
      provider: this.provider,
      sessionId: this.options.session.session_id,
      surfaceId: this.options.surfaceId,
      method,
      params,
    });
    this.options.onSurfaceEvent(event);

    let result: JsonObject;
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        result = { decision: "decline" };
        break;
      case "item/permissions/requestApproval":
        result = { permissions: [] };
        break;
      case "item/tool/requestUserInput":
      case "tool/requestUserInput":
        result = { answers: {} };
        break;
      default:
        this.process.send({
          id: message.id,
          error: { code: -32601, message: `Unsupported request: ${method}` },
        });
        return;
    }
    this.process.send({ id: message.id, result });
  }

  private handleExit(error: Error): void {
    this.turnWaiter?.reject(error);
    this.turnWaiter = undefined;
    if (!this.closing) {
      this.options.onSurfaceEvent(
        processExitEvent(this.options, this.provider, error),
      );
    }
  }
}

class ClaudeStreamJsonSession implements ProtocolSession {
  private readonly options: ProtocolSessionOptions;
  private readonly process: JsonLineProcess;
  private readonly initializeRequestId = `omniwork-${randomUUID()}`;
  private initializePromise: Promise<void>;
  private initializeResolve!: () => void;
  private initializeReject!: (error: Error) => void;
  private sessionId: string | null = null;
  private turnCounter = 0;
  private activeTurn:
    | {
        key: string;
        text: string;
        resolve(): void;
        reject(error: Error): void;
      }
    | undefined;
  private closing = false;

  constructor(options: ProtocolSessionOptions) {
    this.options = options;
    this.initializePromise = new Promise<void>((resolve, reject) => {
      this.initializeResolve = resolve;
      this.initializeReject = reject;
    });
    this.process = new JsonLineProcess({
      command: firstShellWord(options.session.command),
      args: [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "acceptEdits",
      ],
      cwd: options.session.cwd,
      logger: options.logger,
      logLabel: "claude stream-json",
      onMessage: (message) => this.handleMessage(message),
      onExit: (error) => this.handleExit(error),
    });
    this.process.send({
      type: "control_request",
      request_id: this.initializeRequestId,
      request: { subtype: "initialize", hooks: null, agents: null },
    });
    setTimeout(
      () => this.initializeReject(new Error("Claude initialization timed out")),
      30_000,
    ).unref();
  }

  async submitPrompt(prompt: string): Promise<void> {
    await this.initializePromise;
    this.turnCounter += 1;
    const key = `${this.options.session.session_id}:${this.turnCounter}`;
    const completion = new Promise<void>((resolve, reject) => {
      this.activeTurn = { key, text: "", resolve, reject };
    });
    this.process.send({
      type: "user",
      session_id: this.sessionId,
      message: {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
      parent_tool_use_id: null,
    });
    await completion;
  }

  close(): void {
    this.closing = true;
    this.process.close();
  }

  private handleMessage(message: JsonObject): void {
    const controlResponse = isRecord(message.response)
      ? message.response
      : null;
    if (
      message.type === "control_response" &&
      (message.request_id === this.initializeRequestId ||
        controlResponse?.request_id === this.initializeRequestId)
    ) {
      this.initializeResolve();
      return;
    }
    if (message.type === "control_request") {
      this.handleControlRequest(message);
      return;
    }
    if (typeof message.session_id === "string") {
      this.sessionId = message.session_id;
    }
    const turn = this.activeTurn;
    if (!turn) {
      return;
    }

    const normalized = normalizeClaudeMessage({
      sessionId: this.options.session.session_id,
      surfaceId: this.options.surfaceId,
      turnKey: turn.key,
      currentText: turn.text,
      message,
    });
    if (normalized?.text !== undefined) {
      turn.text = normalized.text;
    }
    for (const event of normalized?.events ?? []) {
      this.options.onSurfaceEvent(event);
    }
    if (message.type === "result") {
      if (message.is_error === true) {
        turn.reject(
          new Error(
            typeof message.result === "string"
              ? message.result
              : "Claude turn failed",
          ),
        );
      } else {
        turn.resolve();
      }
      this.activeTurn = undefined;
    }
  }

  private handleControlRequest(message: JsonObject): void {
    const requestId = message.request_id;
    const request = isRecord(message.request) ? message.request : {};
    const subtype =
      typeof request.subtype === "string" ? request.subtype : "unknown";
    this.options.onSurfaceEvent(
      approvalEvent({
        provider: "claude-code",
        sessionId: this.options.session.session_id,
        surfaceId: this.options.surfaceId,
        method: subtype,
        params: request,
      }),
    );
    this.process.send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: {
          behavior: "deny",
          message:
            "Interactive approval is not supported by this OmniWork version",
        },
      },
    });
  }

  private handleExit(error: Error): void {
    this.initializeReject(error);
    this.activeTurn?.reject(error);
    this.activeTurn = undefined;
    if (!this.closing) {
      this.options.onSurfaceEvent(
        processExitEvent(this.options, "claude-code", error),
      );
    }
  }
}

export function normalizeAppServerNotification(input: {
  provider: string;
  sessionId: string;
  surfaceId: string;
  method: string;
  params: JsonObject;
  textByItemId?: Map<string, string>;
}): AgentSurfaceEventPayload | null {
  const { method, params } = input;
  const turn = isRecord(params.turn) ? params.turn : null;
  const item = isRecord(params.item) ? params.item : null;
  const threadId =
    stringValue(params.threadId) ??
    (isRecord(params.thread) ? stringValue(params.thread.id) : undefined);
  const turnId =
    stringValue(params.turnId) ?? (turn ? stringValue(turn.id) : undefined);

  if (method === "thread/started") {
    return surfaceEvent(input, {
      rawEventId: `thread:${threadId ?? "started"}`,
      eventType: "agent.started",
      title: `${providerLabel(input.provider)} thread started`,
      payload: params,
    });
  }
  if (method === "turn/started") {
    return surfaceEvent(input, {
      rawEventId: `turn:${turnId ?? "started"}`,
      eventType: "agent.thinking",
      title: `${providerLabel(input.provider)} turn started`,
      payload: params,
    });
  }
  if (method === "turn/completed") {
    const status = turn ? stringValue(turn.status) : undefined;
    const error = turn && isRecord(turn.error) ? stringValue(turn.error.message) : undefined;
    return surfaceEvent(input, {
      rawEventId: `turn:${turnId ?? "completed"}:completed`,
      eventType: status === "failed" ? "agent.failed" : "agent.completed",
      title:
        status === "failed"
          ? `${providerLabel(input.provider)} turn failed`
          : `${providerLabel(input.provider)} turn completed`,
      summary: error,
      payload: params,
    });
  }
  if (method === "turn/diff/updated") {
    return surfaceEvent(input, {
      rawEventId: `turn:${turnId ?? "unknown"}:diff`,
      eventType: "agent.git_diff_changed",
      title: `${providerLabel(input.provider)} updated the diff`,
      summary: stringValue(params.diff),
      payload: params,
    });
  }
  if (method === "turn/plan/updated") {
    return surfaceEvent(input, {
      rawEventId: `turn:${turnId ?? "unknown"}:plan`,
      eventType: "agent.plan_created",
      title: `${providerLabel(input.provider)} updated the plan`,
      payload: params,
    });
  }
  if (method === "item/agentMessage/delta") {
    const itemId = stringValue(params.itemId) ?? "message";
    const delta = stringValue(params.delta) ?? "";
    const textByItemId = input.textByItemId ?? new Map<string, string>();
    const text = `${textByItemId.get(itemId) ?? ""}${delta}`;
    textByItemId.set(itemId, text);
    return assistantMessageEvent(input, itemId, text, "delta", {
      type: "agent_message",
      id: itemId,
      text,
    });
  }
  if ((method === "item/started" || method === "item/completed") && item) {
    return appServerItemEvent(input, item, method === "item/completed");
  }
  if (method === "error") {
    const error = isRecord(params.error) ? params.error : params;
    return surfaceEvent(input, {
      rawEventId: `error:${turnId ?? stableEventId(JSON.stringify(params))}`,
      eventType: "agent.failed",
      title: `${providerLabel(input.provider)} failed`,
      summary: stringValue(error.message),
      payload: params,
    });
  }
  return null;
}

function appServerItemEvent(
  input: Parameters<typeof normalizeAppServerNotification>[0],
  item: JsonObject,
  completed: boolean,
): AgentSurfaceEventPayload {
  const itemId = stringValue(item.id) ?? stableEventId(JSON.stringify(item));
  const itemType = stringValue(item.type) ?? "unknown";
  const normalizedItem = normalizeItem(item);
  if (itemType === "agentMessage") {
    const text = stringValue(item.text) ?? "";
    input.textByItemId?.set(itemId, text);
    return assistantMessageEvent(
      input,
      itemId,
      text,
      completed ? "completed" : "started",
      normalizedItem,
    );
  }

  const failed = stringValue(item.status) === "failed";
  const eventType = itemEventType(itemType, completed, failed);
  return surfaceEvent(input, {
    rawEventId: `item:${itemId}`,
    eventType,
    title: itemTitle(input.provider, itemType, completed),
    summary: itemSummary(item),
    payload: { item: normalizedItem, phase: completed ? "completed" : "started" },
  });
}

export function normalizeClaudeMessage(input: {
  sessionId: string;
  surfaceId: string;
  turnKey: string;
  currentText: string;
  message: JsonObject;
}): { events: AgentSurfaceEventPayload[]; text?: string } | null {
  const base = {
    provider: "claude-code",
    sessionId: input.sessionId,
    surfaceId: input.surfaceId,
    method: "",
    params: input.message,
  };
  if (input.message.type === "stream_event" && isRecord(input.message.event)) {
    const delta = isRecord(input.message.event.delta)
      ? input.message.event.delta
      : null;
    const textDelta = delta ? stringValue(delta.text) : undefined;
    if (textDelta !== undefined) {
      const text = `${input.currentText}${textDelta}`;
      return {
        text,
        events: [
          assistantMessageEvent(base, input.turnKey, text, "delta", {
            type: "agent_message",
            id: input.turnKey,
            text,
          }),
        ],
      };
    }
  }
  if (input.message.type === "assistant" && isRecord(input.message.message)) {
    const content = Array.isArray(input.message.message.content)
      ? input.message.message.content
      : [];
    const text = content
      .filter(isRecord)
      .filter((block) => block.type === "text")
      .map((block) => stringValue(block.text) ?? "")
      .join("");
    const events = content
      .filter(isRecord)
      .filter((block) => block.type === "tool_use")
      .map((block) =>
        surfaceEvent(base, {
          rawEventId: `tool:${stringValue(block.id) ?? randomUUID()}`,
          eventType: "agent.tool_call_started",
          title: `Claude Code used ${stringValue(block.name) ?? "a tool"}`,
          payload: {
            item: {
              type: "mcp_tool_call",
              id: block.id,
              tool: block.name,
              arguments: block.input,
            },
            phase: "started",
          },
        }),
      );
    if (text) {
      events.push(
        assistantMessageEvent(base, input.turnKey, text, "completed", {
          type: "agent_message",
          id: input.turnKey,
          text,
        }),
      );
    }
    return { text: text || undefined, events };
  }
  if (input.message.type === "result") {
    const failed = input.message.is_error === true;
    return {
      events: [
        surfaceEvent(base, {
          rawEventId: `${input.turnKey}:result`,
          eventType: failed ? "agent.failed" : "agent.completed",
          title: failed ? "Claude Code turn failed" : "Claude Code turn completed",
          summary: failed ? stringValue(input.message.result) : undefined,
          payload: input.message,
        }),
      ],
    };
  }
  if (input.message.type === "system") {
    return {
      events: [
        surfaceEvent(base, {
          rawEventId: `${input.turnKey}:system:${stringValue(input.message.subtype) ?? "event"}`,
          eventType: "agent.thinking",
          title: "Claude Code is working",
          summary: stringValue(input.message.message),
          payload: input.message,
        }),
      ],
    };
  }
  return null;
}

function assistantMessageEvent(
  input: {
    provider: string;
    sessionId: string;
    surfaceId: string;
  },
  itemId: string,
  text: string,
  phase: string,
  item: JsonObject,
): AgentSurfaceEventPayload {
  return surfaceEvent(input, {
    rawEventId: `assistant:${itemId}`,
    eventType: phase === "completed" ? "agent.completed" : "agent.thinking",
    title: `${providerLabel(input.provider)} replied`,
    summary: truncate(text, 8_000),
    payload: { item, phase, message_role: "assistant" },
  });
}

function approvalEvent(input: {
  provider: string;
  sessionId: string;
  surfaceId: string;
  method: string;
  params: JsonObject;
}): AgentSurfaceEventPayload {
  return surfaceEvent(input, {
    rawEventId: `approval:${input.method}:${String(input.params.itemId ?? input.params.tool_use_id ?? randomUUID())}`,
    eventType: "agent.approval_required",
    title: `${providerLabel(input.provider)} requested approval`,
    summary: "This OmniWork version declines interactive protocol requests.",
    payload: { method: input.method, ...input.params },
  });
}

function processExitEvent(
  options: ProtocolSessionOptions,
  provider: string,
  error: Error,
): AgentSurfaceEventPayload {
  return surfaceEvent(
    {
      provider,
      sessionId: options.session.session_id,
      surfaceId: options.surfaceId,
    },
    {
      rawEventId: `process-exit:${error.message}`,
      eventType: "agent.exited",
      title: `${providerLabel(provider)} process exited`,
      summary: error.message,
      payload: { error: error.message },
    },
  );
}

function surfaceEvent(
  input: {
    provider: string;
    sessionId: string;
    surfaceId: string;
  },
  event: {
    rawEventId: string;
    eventType: AgentProbeEventType;
    title: string;
    summary?: string;
    payload?: JsonObject;
  },
): AgentSurfaceEventPayload {
  return {
    session_id: input.sessionId,
    surface_id: input.surfaceId,
    provider: input.provider,
    event_id: stableEventId(input.sessionId, input.provider, event.rawEventId),
    event_type: event.eventType,
    title: event.title,
    summary: event.summary,
    payload: event.payload,
    source: {
      kind: input.provider === "claude-code" ? "process" : "app-server",
      raw_event_id: event.rawEventId,
    },
    created_at: new Date().toISOString(),
  };
}

function normalizeItem(item: JsonObject): JsonObject {
  const type = stringValue(item.type);
  const normalizedType =
    type === "agentMessage"
      ? "agent_message"
      : type === "commandExecution"
        ? "command_execution"
        : type === "fileChange"
          ? "file_change"
          : type === "mcpToolCall" || type === "dynamicToolCall"
            ? "mcp_tool_call"
            : type === "webSearch"
              ? "web_search"
              : type === "plan"
                ? "todo_list"
                : type;
  return { ...item, type: normalizedType };
}

function itemEventType(
  itemType: string,
  completed: boolean,
  failed: boolean,
): AgentProbeEventType {
  if (failed) {
    return "agent.failed";
  }
  switch (itemType) {
    case "commandExecution":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "webSearch":
      return completed ? "agent.tool_call_finished" : "agent.tool_call_started";
    case "fileChange":
      return "agent.file_changed";
    case "plan":
      return "agent.plan_created";
    case "reasoning":
      return "agent.thinking";
    case "contextCompaction":
      return completed ? "agent.compaction_finished" : "agent.compaction_started";
    default:
      return completed ? "agent.completed" : "agent.thinking";
  }
}

function itemTitle(provider: string, itemType: string, completed: boolean): string {
  const label = providerLabel(provider);
  switch (itemType) {
    case "commandExecution":
      return `${label} command ${completed ? "finished" : "started"}`;
    case "fileChange":
      return `${label} changed files`;
    case "mcpToolCall":
    case "dynamicToolCall":
      return `${label} used a tool`;
    case "webSearch":
      return `${label} searched the web`;
    case "plan":
      return `${label} updated the plan`;
    case "reasoning":
      return `${label} is reasoning`;
    default:
      return `${label} ${itemType}`;
  }
}

function itemSummary(item: JsonObject): string | undefined {
  if (typeof item.command === "string") {
    return item.command;
  }
  if (typeof item.query === "string") {
    return item.query;
  }
  if (typeof item.text === "string") {
    return item.text;
  }
  if (Array.isArray(item.changes)) {
    return item.changes
      .filter(isRecord)
      .map((change) => stringValue(change.path))
      .filter((path): path is string => Boolean(path))
      .join(", ");
  }
  return undefined;
}

function isAppServerProvider(provider: string): boolean {
  return provider === "codex" || provider === "traex";
}

function isClaudeProvider(provider: string): boolean {
  return ["claude", "claude-code", "claudecode"].includes(provider);
}

function normalizeProvider(provider: string): string {
  return provider;
}

function providerLabel(provider: string): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "traex":
      return "TraeX";
    case "claude":
    case "claude-code":
      return "Claude Code";
    default:
      return provider;
  }
}

function firstShellWord(command: string): string {
  const trimmed = command.trim();
  const match = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+)/.exec(trimmed);
  const word = match?.[1];
  if (!word) {
    throw new Error("Agent provider command is empty");
  }
  if (
    (word.startsWith('"') && word.endsWith('"')) ||
    (word.startsWith("'") && word.endsWith("'"))
  ) {
    return word.slice(1, -1);
  }
  return word;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stableEventId(...parts: string[]): string {
  return `agent_surface_${createHash("sha256")
    .update(parts.join(":"))
    .digest("hex")
    .slice(0, 24)}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3)}...`;
}
