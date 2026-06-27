import { randomUUID } from "node:crypto";

import {
  createMessage,
  type AuthFailedPayload,
  type MessageEnvelope,
  type ProtocolErrorPayload,
  type RelayAppDeliverPayload,
} from "@omniwork/protocol-ts";

import type { RelayServerConfig } from "../config.ts";
import { RuntimeTopology } from "../runtime/topology.ts";
import type { RelayStateStore } from "../relayStateStore.ts";
import type { RelayConnection, RelayRoutedAppMessage } from "../relayTypes.ts";

interface AppDeliveryContext {
  deviceId: string;
  agentConnectionId: string;
  appConnectionId: string;
  expiresAt: number;
}

export interface AppAgentChannelOptions {
  config: RelayServerConfig;
  topology: RuntimeTopology;
  state: RelayStateStore;
  send(connection: RelayConnection, message: MessageEnvelope): void;
}

export class AppAgentChannel {
  private readonly options: AppAgentChannelOptions;
  private readonly appDeliveryContexts = new Map<string, AppDeliveryContext>();

  constructor(options: AppAgentChannelOptions) {
    this.options = options;
  }

  routeMessage(connection: RelayConnection, message: MessageEnvelope): void {
    if (connection.role === "mobile") {
      if (!connection.authenticated || !connection.deviceId) {
        this.options.send(
          connection,
          createMessage<AuthFailedPayload>(
            "auth.failed",
            {
              reason: "malformed_proof",
              connection_id: connection.id,
              retry_after_ms: 2000,
            },
            { device_id: connection.deviceId },
          ),
        );
        return;
      }

      const agent = this.options.topology.getPrimaryAgent(connection.deviceId);
      if (agent) {
        const relayContextId = this.rememberAppDeliveryContext({
          deviceId: connection.deviceId,
          agentConnectionId: agent.id,
          appConnectionId: connection.id,
        });
        const routedMessage: RelayRoutedAppMessage = {
          ...message,
          device_id: connection.deviceId,
          app_connection_id: connection.id,
          relay_context_id: relayContextId,
        };
        this.options.send(agent, routedMessage);
      } else {
        this.options.state.recordRouteDropped();
      }
      return;
    }

    if (connection.role === "agent" && connection.deviceId) {
      if (message.app_connection_id) {
        const mobile = this.options.topology.getConnection(
          message.app_connection_id,
        );
        if (mobile) {
          this.options.send(mobile, message);
        } else {
          this.options.state.recordRouteDropped();
        }
        return;
      }
      const mobiles = this.options.topology.mobilesByDevice.get(
        connection.deviceId,
      );
      if (!mobiles) {
        this.options.state.recordRouteDropped();
        return;
      }
      for (const mobile of mobiles) {
        this.options.send(mobile, message);
      }
    }
  }

  handleRelayAppDeliver(
    connection: RelayConnection,
    message: MessageEnvelope<RelayAppDeliverPayload>,
  ): void {
    if (connection.role !== "agent" || !connection.deviceId) {
      this.sendProtocolError(
        connection,
        "invalid_state",
        `Message type "${message.type}" is not allowed in state "${connection.state}".`,
        false,
      );
      return;
    }

    const context = this.takeAppDeliveryContext(
      message.payload.relay_context_id,
    );
    if (
      !context ||
      context.deviceId !== connection.deviceId ||
      context.agentConnectionId !== connection.id
    ) {
      this.sendProtocolError(
        connection,
        "route_not_found",
        `No active App delivery context for "${message.payload.relay_context_id}".`,
        false,
      );
      return;
    }

    const mobile = this.options.topology.getConnection(context.appConnectionId);
    if (
      mobile?.role !== "mobile" ||
      mobile.deviceId !== connection.deviceId ||
      !mobile.authenticated
    ) {
      this.sendProtocolError(
        connection,
        "route_not_found",
        `App delivery context "${message.payload.relay_context_id}" is no longer routable.`,
        false,
      );
      return;
    }

    const delivery = message.payload.message;
    this.options.send(
      mobile,
      createMessage(delivery.type, delivery.payload, {
        id: delivery.id,
        device_id: connection.deviceId,
        session_id: delivery.session_id,
        surface_id: delivery.surface_id,
        seq: delivery.seq,
        app_connection_id: mobile.id,
      }),
    );
  }

  cleanupExpiredAppDeliveryContexts(now = Date.now()): void {
    for (const [relayContextId, context] of this.appDeliveryContexts) {
      if (context.expiresAt <= now) {
        this.appDeliveryContexts.delete(relayContextId);
      }
    }
  }

  private rememberAppDeliveryContext(input: {
    deviceId: string;
    agentConnectionId: string;
    appConnectionId: string;
  }): string {
    this.cleanupExpiredAppDeliveryContexts();
    const relayContextId = `relay_ctx_${randomUUID()}`;
    this.appDeliveryContexts.set(relayContextId, {
      deviceId: input.deviceId,
      agentConnectionId: input.agentConnectionId,
      appConnectionId: input.appConnectionId,
      expiresAt: Date.now() + this.options.config.state.appContextTtlMs,
    });
    return relayContextId;
  }

  private takeAppDeliveryContext(relayContextId: string): AppDeliveryContext | null {
    this.cleanupExpiredAppDeliveryContexts();
    const context = this.appDeliveryContexts.get(relayContextId);
    if (!context) {
      return null;
    }
    this.appDeliveryContexts.delete(relayContextId);
    return context;
  }

  private sendProtocolError(
    connection: RelayConnection,
    code: ProtocolErrorPayload["code"],
    detail: string,
    retryable: boolean,
  ): void {
    this.options.state.recordProtocolErrorSent();
    this.options.send(
      connection,
      createMessage<ProtocolErrorPayload>(
        "protocol.error",
        {
          v: this.options.config.protocolVersion,
          code,
          detail,
          retryable,
        },
        { device_id: connection.deviceId },
      ),
    );
  }
}
