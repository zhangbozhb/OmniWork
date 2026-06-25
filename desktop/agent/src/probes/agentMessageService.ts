import {
  createMessageId,
  type AgentAppMessage,
  type AgentAppMessageKind,
  type AgentAppMessagePriority,
  type AgentMessageListRequestPayload,
  type AgentProbeEvent,
  type AgentProbeEventType,
} from "@omniwork/protocol-ts";

export interface AgentMessageServiceOptions {
  maxMessages?: number;
  onMessage?(message: AgentAppMessage): void;
}

const DEFAULT_MAX_MESSAGES = 500;
type AgentAppMessageActionType = NonNullable<AgentAppMessage["action"]>["type"];

const EVENT_TO_MESSAGE: Partial<
  Record<
    AgentProbeEventType,
    {
      kind: AgentAppMessageKind;
      priority: AgentAppMessagePriority;
      title: string;
      action: AgentAppMessageActionType;
    }
  >
> = {
  "agent.started": {
    kind: "status",
    priority: "low",
    title: "Agent session started",
    action: "open_session",
  },
  "agent.plan_created": {
    kind: "plan",
    priority: "normal",
    title: "Agent updated its plan",
    action: "open_session",
  },
  "agent.approval_required": {
    kind: "approval",
    priority: "high",
    title: "Agent needs approval",
    action: "open_approval",
  },
  "agent.waiting_user_input": {
    kind: "input_required",
    priority: "high",
    title: "Agent is waiting for input",
    action: "open_session",
  },
  "agent.git_diff_changed": {
    kind: "diff_summary",
    priority: "normal",
    title: "Agent updated the diff",
    action: "open_diff",
  },
  "agent.file_changed": {
    kind: "diff_summary",
    priority: "normal",
    title: "Agent changed files",
    action: "open_diff",
  },
  "agent.subagent_started": {
    kind: "status",
    priority: "low",
    title: "Subagent started",
    action: "open_session",
  },
  "agent.subagent_completed": {
    kind: "result",
    priority: "normal",
    title: "Subagent completed",
    action: "open_session",
  },
  "agent.completed": {
    kind: "result",
    priority: "normal",
    title: "Agent completed",
    action: "open_session",
  },
  "agent.failed": {
    kind: "error",
    priority: "high",
    title: "Agent failed",
    action: "open_session",
  },
  "agent.exited": {
    kind: "status",
    priority: "low",
    title: "Agent exited",
    action: "open_session",
  },
};

export class AgentMessageService {
  private readonly maxMessages: number;
  private readonly onMessage?: (message: AgentAppMessage) => void;
  private readonly seenProbeEventKeys = new Set<string>();
  private readonly messages: AgentAppMessage[] = [];

  constructor(options: AgentMessageServiceOptions = {}) {
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.onMessage = options.onMessage;
  }

  publishProbeEvent(event: AgentProbeEvent): AgentAppMessage | null {
    const eventKey = `${event.provider}:${event.probe_id}:${event.id}`;
    if (this.seenProbeEventKeys.has(eventKey)) {
      return null;
    }
    this.seenProbeEventKeys.add(eventKey);

    const message = this.toAppMessage(event);
    if (!message) {
      return null;
    }
    this.messages.push(message);
    while (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }
    this.onMessage?.(message);
    return message;
  }

  list(filter: AgentMessageListRequestPayload = {}): AgentAppMessage[] {
    const limit = normalizeLimit(filter.limit);
    return this.messages
      .filter((message) => {
        if (filter.session_id && message.session_id !== filter.session_id) {
          return false;
        }
        if (filter.surface_id && message.surface_id !== filter.surface_id) {
          return false;
        }
        if (filter.provider && message.provider !== filter.provider) {
          return false;
        }
        if (filter.unread_only && message.read_at) {
          return false;
        }
        return true;
      })
      .slice(-limit)
      .reverse();
  }

  read(messageId: string): AgentAppMessage | undefined {
    return this.messages.find((message) => message.id === messageId);
  }

  ack(messageId: string, read: boolean): AgentAppMessage | undefined {
    const message = this.read(messageId);
    if (!message) {
      return undefined;
    }
    if (read) {
      message.read_at = new Date().toISOString();
    }
    return message;
  }

  private toAppMessage(event: AgentProbeEvent): AgentAppMessage | null {
    const mapping = EVENT_TO_MESSAGE[event.event_type];
    if (!mapping) {
      return null;
    }

    return {
      id: createMessageId(),
      type: "agent.message",
      provider: event.provider,
      session_id: event.session_id,
      surface_id: event.surface_id,
      workspace_id: event.workspace_id,
      message_kind: mapping.kind,
      title: event.title ?? mapping.title,
      summary: event.summary,
      priority:
        event.severity === "critical" ? "critical" : mapping.priority,
      action: {
        type: mapping.action,
        session_id: event.session_id,
        surface_id: event.surface_id,
        workspace_id: event.workspace_id,
      },
      created_at: event.created_at,
    };
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit) || limit === undefined || limit <= 0) {
    return 50;
  }
  return Math.min(limit, 100);
}
