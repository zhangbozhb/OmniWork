import {
  createMessage,
  type AgentInteractionAnswerPayload,
  type AgentInteractionErrorPayload,
  type AgentInteractionPayload,
  type AgentInteractionSyncRequestPayload,
  type MessageEnvelope,
} from "@omni-work/protocol-ts";

import type { AgentInteractionService } from "../agent-surface/agentInteractionService.ts";
import type { AgentDispatchContext } from "./agentRuntimeTypes.ts";

interface AgentInteractionHandlerOptions {
  deviceId: string;
  interactions: AgentInteractionService;
  sendToApp(
    context: AgentDispatchContext | undefined,
    message: MessageEnvelope,
  ): void;
}

export class AgentInteractionHandler {
  private readonly deviceId: string;
  private readonly interactions: AgentInteractionService;
  private readonly sendToApp: AgentInteractionHandlerOptions["sendToApp"];

  constructor(options: AgentInteractionHandlerOptions) {
    this.deviceId = options.deviceId;
    this.interactions = options.interactions;
    this.sendToApp = options.sendToApp;
  }

  handle(
    message: MessageEnvelope<AgentInteractionPayload>,
    context?: AgentDispatchContext,
  ): void {
    if (message.payload.kind === "answer") {
      this.handleAnswer(message.payload, context);
      return;
    }
    if (message.payload.kind === "sync_request") {
      this.handleSync(message.id, message.payload, context);
    }
  }

  private handleAnswer(
    answer: AgentInteractionAnswerPayload,
    context?: AgentDispatchContext,
  ): void {
    const resolved = this.interactions.answer(answer);
    if (
      (resolved.outcome === "duplicate" ||
        resolved.outcome === "conflict") &&
      resolved.result
    ) {
      this.sendToApp(
        context,
        createMessage("agent.interaction", resolved.result, {
          device_id: this.deviceId,
          session_id: answer.session_id,
          surface_id: answer.surface_id,
        }),
      );
      return;
    }
    if (resolved.outcome === "not_found") {
      this.sendError(context, {
        kind: "error",
        interaction_id: answer.interaction_id,
        code: "not_found",
        message: "The interaction was not found for this session and surface.",
      });
      return;
    }
    if (resolved.outcome === "conflict") {
      this.sendError(context, {
        kind: "error",
        interaction_id: answer.interaction_id,
        code: "invalid_answer",
        message: "The action identifier was already used by another request.",
      });
    }
  }

  private handleSync(
    requestId: string,
    filter: AgentInteractionSyncRequestPayload,
    context?: AgentDispatchContext,
  ): void {
    this.sendToApp(
      context,
      createMessage(
        "agent.interaction",
        {
          kind: "sync_response",
          request_id: requestId,
          interactions: this.interactions.listPending(filter),
        },
        {
          device_id: this.deviceId,
          session_id: filter.session_id,
          surface_id: filter.surface_id,
        },
      ),
    );
  }

  private sendError(
    context: AgentDispatchContext | undefined,
    error: AgentInteractionErrorPayload,
  ): void {
    this.sendToApp(
      context,
      createMessage("agent.interaction", error, {
        device_id: this.deviceId,
      }),
    );
  }
}
