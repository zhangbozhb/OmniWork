import {
  createMessage,
  type AgentSurfaceSyncRequestPayload,
  type MessageEnvelope,
} from "@omni-work/protocol-ts";

import type { AgentSurfaceEventStore } from "../agent-surface/agentSurfaceEventStore.ts";
import type { AgentDispatchContext } from "./agentRuntimeTypes.ts";

interface AgentSurfaceSyncHandlerOptions {
  deviceId: string;
  store: AgentSurfaceEventStore;
  sendToApp(
    context: AgentDispatchContext | undefined,
    message: MessageEnvelope,
  ): void;
}

export class AgentSurfaceSyncHandler {
  private readonly deviceId: string;
  private readonly store: AgentSurfaceEventStore;
  private readonly sendToApp: AgentSurfaceSyncHandlerOptions["sendToApp"];

  constructor(options: AgentSurfaceSyncHandlerOptions) {
    this.deviceId = options.deviceId;
    this.store = options.store;
    this.sendToApp = options.sendToApp;
  }

  handleSync(
    message: MessageEnvelope<AgentSurfaceSyncRequestPayload>,
    context?: AgentDispatchContext,
  ): void {
    const page = this.store.list(
      message.payload.session_id,
      message.payload.surface_id,
      message.payload.after_cursor,
      message.payload.limit,
    );
    this.sendToApp(
      context,
      createMessage(
        "agent.surface.sync",
        {
          kind: "response",
          request_id: message.id,
          session_id: message.payload.session_id,
          surface_id: message.payload.surface_id,
          events: page.events,
          next_cursor: page.nextCursor,
          has_more: page.hasMore,
        },
        {
          device_id: this.deviceId,
          session_id: message.payload.session_id,
          surface_id: message.payload.surface_id,
        },
      ),
    );
  }
}
