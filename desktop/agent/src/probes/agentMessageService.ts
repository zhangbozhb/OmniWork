import {
  createMessageId,
  type AgentAppMessage,
  type AgentAppMessageKind,
  type AgentAppMessagePriority,
  type AgentMessageListRequestPayload,
  type AgentNotificationSettingsPayload,
  type AgentProbeEvent,
  type AgentProbeEventType,
} from "@omniwork/protocol-ts";
import type { AgentMessageStore } from "./agentMessageStore.ts";

export interface AgentMessageServiceOptions {
  maxMessages?: number;
  store?: AgentMessageStore;
  onMessage?(message: AgentAppMessage): void;
  onNotification?(notification: AgentSystemNotificationPayload): void;
}

const DEFAULT_MAX_MESSAGES = 500;
type AgentAppMessageActionType = NonNullable<AgentAppMessage["action"]>["type"];

export interface AgentSystemNotificationPayload {
  message_id: string;
  title: string;
  body?: string;
  action?: AgentAppMessageActionType;
  priority: AgentAppMessagePriority;
  created_at: string;
}

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
  private readonly store?: AgentMessageStore;
  private readonly onMessage?: (message: AgentAppMessage) => void;
  private readonly onNotification?: (
    notification: AgentSystemNotificationPayload,
  ) => void;
  private readonly seenProbeEventKeys = new Set<string>();
  private readonly messages: AgentAppMessage[] = [];
  private notificationSettings: AgentNotificationSettingsPayload = {
    enabled: true,
    min_priority: "high",
    muted_providers: [],
    muted_message_kinds: [],
  };

  constructor(options: AgentMessageServiceOptions = {}) {
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.store = options.store;
    this.onMessage = options.onMessage;
    this.onNotification = options.onNotification;
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
    const storedMessage = this.store?.insertMessage(eventKey, message);
    if (this.store && !storedMessage) {
      return null;
    }
    this.messages.push(message);
    while (this.messages.length > this.maxMessages) {
      this.messages.shift();
    }
    this.onMessage?.(message);
    if (this.shouldNotify(message)) {
      this.onNotification?.(toSystemNotification(message));
    }
    return message;
  }

  list(filter: AgentMessageListRequestPayload = {}): AgentAppMessage[] {
    if (this.store) {
      return this.store.list(filter);
    }
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
    if (this.store) {
      return this.store.read(messageId);
    }
    return this.messages.find((message) => message.id === messageId);
  }

  ack(messageId: string, read: boolean): AgentAppMessage | undefined {
    if (this.store) {
      return this.store.ack(messageId, read);
    }
    const message = this.read(messageId);
    if (!message) {
      return undefined;
    }
    if (read) {
      message.read_at = new Date().toISOString();
    }
    return message;
  }

  getNotificationSettings(): AgentNotificationSettingsPayload {
    return this.store?.getNotificationSettings() ?? this.notificationSettings;
  }

  setNotificationSettings(
    settings: AgentNotificationSettingsPayload,
  ): AgentNotificationSettingsPayload {
    const normalized = normalizeNotificationSettings(settings);
    this.notificationSettings = normalized;
    return this.store?.setNotificationSettings(normalized) ?? normalized;
  }

  shouldNotify(message: AgentAppMessage): boolean {
    const settings = this.getNotificationSettings();
    if (!settings.enabled) {
      return false;
    }
    if (settings.muted_providers?.includes(message.provider)) {
      return false;
    }
    if (settings.muted_message_kinds?.includes(message.message_kind)) {
      return false;
    }
    return (
      priorityRank(message.priority) >=
      priorityRank(settings.min_priority ?? "high")
    );
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

function normalizeNotificationSettings(
  settings: AgentNotificationSettingsPayload,
): AgentNotificationSettingsPayload {
  return {
    enabled: settings.enabled !== false,
    min_priority: settings.min_priority ?? "high",
    muted_providers: settings.muted_providers ?? [],
    muted_message_kinds: settings.muted_message_kinds ?? [],
  };
}

function priorityRank(priority: AgentAppMessagePriority): number {
  switch (priority) {
    case "low":
      return 0;
    case "normal":
      return 1;
    case "high":
      return 2;
    case "critical":
      return 3;
  }
}

function toSystemNotification(
  message: AgentAppMessage,
): AgentSystemNotificationPayload {
  return {
    message_id: message.id,
    title: message.title,
    body: message.summary,
    action: message.action?.type,
    priority: message.priority,
    created_at: message.created_at,
  };
}
