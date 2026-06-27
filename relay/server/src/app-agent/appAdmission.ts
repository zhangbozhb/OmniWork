import { randomBytes } from "node:crypto";

import {
  createMessage,
  isTransportPreference,
  type AuthFailedPayload,
  type MessageEnvelope,
  type MobileConnectPayload,
} from "@omniwork/protocol-ts";

import type { RelayServerConfig } from "../config.ts";
import { RuntimeTopology } from "../runtime/topology.ts";
import { appInfoFromMobileConnect } from "./payload.ts";
import type { RelayStateStore } from "../relayStateStore.ts";
import { RelayUserAuthController } from "../relayUserAuthController.ts";
import type { RelayUserAuthStore } from "../relayUserAuthStore.ts";
import type {
  PendingAuth,
  RelayConnection,
} from "../relayTypes.ts";

export interface AppAdmissionOptions {
  config: RelayServerConfig;
  topology: RuntimeTopology;
  state: RelayStateStore;
  userAuth: RelayUserAuthController;
  userAuthStore: RelayUserAuthStore;
  pendingAuth: Map<string, PendingAuth>;
  send(connection: RelayConnection, message: MessageEnvelope): void;
}

export class AppAdmission {
  private readonly options: AppAdmissionOptions;

  constructor(options: AppAdmissionOptions) {
    this.options = options;
  }

  handleMobileConnect(
    connection: RelayConnection,
    message: MessageEnvelope<MobileConnectPayload>,
  ): void {
    const deviceId = message.payload.device_id;
    if (this.options.config.auth.mode === "email_link") {
      const user = this.options.userAuth.authenticateToken(
        message.payload.session_token,
      );
      const device = this.options.userAuthStore.getDevice(deviceId);
      const userId = user?.id ?? connection.userId;
      if (
        !userId ||
        !device ||
        device.revoked_at ||
        device.user_id !== userId
      ) {
        connection.authState = "failed";
        this.options.send(
          connection,
          createMessage<AuthFailedPayload>(
            "auth.failed",
            {
              reason: "malformed_proof",
              connection_id: connection.id,
              retry_after_ms: 2000,
            },
            { device_id: deviceId },
          ),
        );
        return;
      }
      connection.userId = userId;
    }
    const agent = this.options.topology.getPrimaryAgent(deviceId);
    connection.role = "mobile";
    connection.state = "mobile_connected";
    connection.deviceId = deviceId;
    connection.authState = "pending";
    const appInfo = appInfoFromMobileConnect(message.payload);
    connection.appInfo = appInfo;

    const rawPreference = message.payload.transport_preference;
    if (isTransportPreference(rawPreference)) {
      connection.transportPreference = rawPreference;
    }
    this.options.state.registerApp(connection);

    if (!agent?.keyId) {
      connection.authState = "failed";
      this.options.send(
        connection,
        createMessage<AuthFailedPayload>(
          "auth.failed",
          {
            reason: "device_not_online",
            connection_id: connection.id,
            retry_after_ms: 2000,
          },
          { device_id: deviceId },
        ),
      );
      return;
    }

    const nonce = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + this.options.config.state.pendingAuthTtlMs;
    this.options.pendingAuth.set(connection.id, {
      deviceId,
      nonce,
      keyId: agent.keyId,
      appInfo,
      expiresAt,
    });

    this.options.send(
      connection,
      createMessage(
        "auth.challenge",
        {
          nonce,
          key_id: agent.keyId,
          expires_at: new Date(expiresAt).toISOString(),
        },
        { device_id: deviceId },
      ),
    );
  }
}
