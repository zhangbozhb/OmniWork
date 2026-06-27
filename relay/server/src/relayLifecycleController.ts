import {
  createMessage,
  type AuthFailedPayload,
  type MessageEnvelope,
} from "@omniwork/protocol-ts";

import type { RelayServerConfig } from "./config.ts";
import { RelayConnectionRegistry } from "./relayConnectionRegistry.ts";
import { RelayMessageRouter } from "./relayMessageRouter.ts";
import type { RelayStateStore } from "./relayStateStore.ts";
import type { RelayUserAuthStore } from "./relayUserAuthStore.ts";
import type { PendingAuth, RelayConnection } from "./relayTypes.ts";

export interface RelayLifecycleControllerOptions {
  config: RelayServerConfig;
  registry: RelayConnectionRegistry;
  state: RelayStateStore;
  userAuthStore: RelayUserAuthStore;
  pendingAuth: Map<string, PendingAuth>;
  router: RelayMessageRouter;
  send(connection: RelayConnection, message: MessageEnvelope): void;
}

export class RelayLifecycleController {
  private readonly options: RelayLifecycleControllerOptions;
  private deviceStatusFlushTimer: ReturnType<typeof setInterval> | null = null;
  private lifecycleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RelayLifecycleControllerOptions) {
    this.options = options;
  }

  start(): void {
    this.startLifecycleSweeper();
    this.startDeviceStatusFlusher();
  }

  private startLifecycleSweeper(): void {
    if (this.lifecycleTimer) {
      return;
    }
    this.lifecycleTimer = setInterval(() => {
      const now = Date.now();
      this.options.state.sweep({
        now,
        offlineDeviceRetentionMs:
          this.options.config.state.deviceStatusRetentionMs,
      });
      this.cleanupExpiredPendingAuth(now);
      this.options.router.cleanupExpiredAppDeliveryContexts(now);
      this.options.userAuthStore.sweep(now);
    }, this.options.config.state.sweepIntervalMs);
    this.lifecycleTimer.unref?.();
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
      const connection = this.options.registry.getConnection(connectionId);
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
