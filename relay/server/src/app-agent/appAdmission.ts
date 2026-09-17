import { randomBytes } from "node:crypto";

import {
  createMessage,
  isTransportPreference,
  type AuthFailedPayload,
  type MessageEnvelope,
  type MobileConnectPayload,
} from "@omni-work/protocol-ts";

import type { RelayServerConfig } from "../config.ts";
import { RelayAuthExecutor } from "../auth/executor.ts";
import { RelayAuthGuard } from "../auth/guard.ts";
import { RuntimeTopology } from "../runtime/topology.ts";
import { appInfoFromMobileConnect } from "./payload.ts";
import type { RelayStateStore } from "../relayStateStore.ts";
import type {
  PendingAuth,
  RelayConnection,
} from "../relayTypes.ts";

export interface AppAdmissionOptions {
  config: RelayServerConfig;
  authGuard: RelayAuthGuard;
  authExecutor: RelayAuthExecutor;
  topology: RuntimeTopology;
  state: RelayStateStore;
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
    const decision = this.options.authGuard.authorize({
      surface: "mobile_connect",
      message,
      connectionUserId: connection.userId,
    });
    if (!decision.ok) {
      connection.authState = "failed";
      this.options.authExecutor.execute(decision, { connection });
      return;
    }
    connection.userId = decision.subject?.userId ?? connection.userId;
    const agent = this.options.topology.getPrimaryAgent(deviceId);
    connection.role = "mobile";
    connection.state = "mobile_connected";
    connection.deviceId = deviceId;
    connection.appId = message.payload.app_id;
    connection.appPublicKey = message.payload.app_public_key;
    connection.authState = "pending";
    const appInfo = appInfoFromMobileConnect(message.payload);
    connection.appInfo = appInfo;

    const rawPreference = message.payload.transport_preference;
    if (isTransportPreference(rawPreference)) {
      connection.transportPreference = rawPreference;
    }
    this.options.state.registerApp(connection);

    if (!agent) {
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
    if (!agent.devicePublicKey) {
      connection.authState = "failed";
      this.options.send(
        connection,
        createMessage<AuthFailedPayload>(
          "auth.failed",
          {
            reason: "identity_mismatch",
            connection_id: connection.id,
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
      agentPublicKey: agent.devicePublicKey,
      appId: message.payload.app_id,
      appPublicKey: message.payload.app_public_key,
      agentConnectionId: agent.id,
      nonce,
      appInfo,
      expiresAt,
    });

    this.options.send(
      connection,
      createMessage(
        "auth.challenge",
        {
          nonce,
          expires_at: new Date(expiresAt).toISOString(),
          connection_id: connection.id,
          agent_connection_id: agent.id,
          agent_public_key: agent.devicePublicKey,
        },
        { device_id: deviceId },
      ),
    );
  }
}
