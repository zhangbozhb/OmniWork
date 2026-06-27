import {
  createMessage,
  type AuthFailedPayload,
  type MessageEnvelope,
} from "@omniwork/protocol-ts";

import type { RelayServerConfig } from "../config.ts";
import { RuntimeTopology } from "./topology.ts";
import { AppAgentChannel } from "../app-agent/channel.ts";
import type { RelayStateStore } from "../relayStateStore.ts";
import type { RelayUserAuthStore } from "../relayUserAuthStore.ts";
import type { PendingAuth, RelayConnection } from "../relayTypes.ts";

export interface RuntimeMaintenanceOptions {
  config: RelayServerConfig;
  topology: RuntimeTopology;
  state: RelayStateStore;
  userAuthStore: RelayUserAuthStore;
  pendingAuth: Map<string, PendingAuth>;
  appAgentChannel: AppAgentChannel;
  send(connection: RelayConnection, message: MessageEnvelope): void;
}

export class RuntimeMaintenance {
  private readonly options: RuntimeMaintenanceOptions;
  private deviceStatusFlushTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RuntimeMaintenanceOptions) {
    this.options = options;
  }

  start(): void {
    this.startLifecycleSweeper();
    this.startDeviceStatusFlusher();
  }

  private startLifecycleSweeper(): void {
    if (this.maintenanceTimer) {
      return;
    }
    this.maintenanceTimer = setInterval(() => {
      const now = Date.now();
      this.options.state.sweep({
        now,
        offlineDeviceRetentionMs:
          this.options.config.state.deviceStatusRetentionMs,
      });
      this.cleanupExpiredPendingAuth(now);
      this.options.appAgentChannel.cleanupExpiredAppDeliveryContexts(now);
      this.options.userAuthStore.sweep(now);
    }, this.options.config.state.sweepIntervalMs);
    this.maintenanceTimer.unref?.();
  }

  private startDeviceStatusFlusher(): void {
    if (this.deviceStatusFlushTimer) {
      return;
    }
    this.deviceStatusFlushTimer = setInterval(() => {
      this.options.state.flushDeviceStatus();
    }, this.options.config.state.deviceStatusFlushIntervalMs);
    this.deviceStatusFlushTimer.unref?.();
  }

  private cleanupExpiredPendingAuth(now = Date.now()): void {
    for (const [connectionId, pending] of this.options.pendingAuth) {
      if (pending.expiresAt > now) {
        continue;
      }
      this.options.pendingAuth.delete(connectionId);
      const connection = this.options.topology.getConnection(connectionId);
      if (connection?.role === "mobile" && !connection.authenticated) {
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
        connection.authState = "failed";
        connection.socket.close(1008, "auth timeout");
      }
    }
  }
}
