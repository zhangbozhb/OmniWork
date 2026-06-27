import {
  createMessage,
  type AgentMessageAckPayload,
  type AgentMessageDeliveredPayload,
  type AgentMessageListRequestPayload,
  type AgentMessageReadRequestPayload,
  type AgentNotificationSettingsPayload,
  type MessageEnvelope,
} from "@omniwork/protocol-ts";
import type { Logger } from "../telemetry/logger.ts";
import type { AgentMessageService } from "../probes/agentMessageService.ts";
import type { AgentDispatchContext } from "./agentRuntimeTypes.ts";

interface AgentInboxHandlerOptions {
  deviceId: string;
  logger: Logger;
  agentMessages: AgentMessageService;
  sendToApp(
    context: AgentDispatchContext | undefined,
    message: MessageEnvelope,
  ): void;
}

export class AgentInboxHandler {
  private readonly deviceId: string;
  private readonly logger: Logger;
  private readonly agentMessages: AgentMessageService;
  private readonly sendToApp: (
    context: AgentDispatchContext | undefined,
    message: MessageEnvelope,
  ) => void;

  constructor(options: AgentInboxHandlerOptions) {
    this.deviceId = options.deviceId;
    this.logger = options.logger;
    this.agentMessages = options.agentMessages;
    this.sendToApp = options.sendToApp;
  }

  handleMessageList(
    message: MessageEnvelope<AgentMessageListRequestPayload>,
    context?: AgentDispatchContext,
  ): void {
    this.sendToApp(
      context,
      createMessage(
        "agent.message.list",
        { messages: this.agentMessages.list(message.payload) },
        {
          device_id: this.deviceId,
          id: message.id,
        },
      ),
    );
  }

  handleMessageRead(
    message: MessageEnvelope<AgentMessageReadRequestPayload>,
    context?: AgentDispatchContext,
  ): void {
    this.sendToApp(
      context,
      createMessage(
        "agent.message.read",
        { message: this.agentMessages.read(message.payload.message_id) },
        {
          device_id: this.deviceId,
          id: message.id,
        },
      ),
    );
  }

  handleMessageAck(
    message: MessageEnvelope<AgentMessageAckPayload>,
    context?: AgentDispatchContext,
  ): void {
    this.sendToApp(
      context,
      createMessage(
        "agent.message.ack",
        {
          message: this.agentMessages.ack(
            message.payload.message_id,
            message.payload.read === true,
          ),
        },
        {
          device_id: this.deviceId,
          id: message.id,
        },
      ),
    );
  }

  handleMessageDelivered(
    message: MessageEnvelope<AgentMessageDeliveredPayload>,
    context?: AgentDispatchContext,
  ): void {
    const appConnectionId =
      message.payload.app_connection_id ?? context?.appConnectionId;
    this.logger.info("agent message delivered", {
      message_id: message.payload.message_id,
      app_connection_id: appConnectionId,
      delivered_at: message.payload.delivered_at,
    });
  }

  handleNotificationSettingsGet(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ): void {
    this.sendToApp(
      context,
      createMessage(
        "agent.notification.settings.get",
        this.agentMessages.getNotificationSettings(),
        {
          device_id: this.deviceId,
          id: message.id,
        },
      ),
    );
  }

  handleNotificationSettingsSet(
    message: MessageEnvelope<AgentNotificationSettingsPayload>,
    context?: AgentDispatchContext,
  ): void {
    this.sendToApp(
      context,
      createMessage(
        "agent.notification.settings.set",
        this.agentMessages.setNotificationSettings(message.payload),
        {
          device_id: this.deviceId,
          id: message.id,
        },
      ),
    );
  }
}
