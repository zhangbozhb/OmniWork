import type { AgentHelloPayload, MessageEnvelope } from "@omniwork/protocol-ts";

import type { RelayServerConfig } from "./config.ts";
import { RelayAdminController } from "./relayAdminController.ts";
import { RelayConnectionRegistry } from "./relayConnectionRegistry.ts";
import { verifyRelayDeviceSignature } from "./relayDeviceSignature.ts";
import type { RelayStateStore } from "./relayStateStore.ts";
import type { RelayUserAuthStore } from "./relayUserAuthStore.ts";
import type { RelayConnection } from "./relayTypes.ts";

export interface RelayAgentSessionControllerOptions {
  config: RelayServerConfig;
  admin: RelayAdminController;
  registry: RelayConnectionRegistry;
  state: RelayStateStore;
  userAuthStore: RelayUserAuthStore;
}

export class RelayAgentSessionController {
  private readonly options: RelayAgentSessionControllerOptions;

  constructor(options: RelayAgentSessionControllerOptions) {
    this.options = options;
  }

  handleAgentHello(
    connection: RelayConnection,
    message: MessageEnvelope<AgentHelloPayload>,
  ): void {
    if (
      this.options.admin.activeDisabledAgentInstance(
        message.payload.agent_instance_id,
      )
    ) {
      connection.socket.close(4403, "agent_disabled");
      return;
    }
    if (this.options.config.auth.mode === "email_link") {
      const device = this.options.userAuthStore.getDevice(
        message.payload.device_id,
      );
      if (!device || device.revoked_at) {
        connection.socket.close(4403, "device_not_registered");
        return;
      }
      const verified = verifyRelayDeviceSignature({
        publicKey: device.public_key,
        hello: message.payload,
        skewMs: this.options.config.auth.nonceTtlMs,
      });
      if (!verified.ok) {
        connection.socket.close(4403, verified.reason);
        return;
      }
      const nonceOk = this.options.userAuthStore.rememberNonce(
        message.payload.device_id,
        message.payload.relay_auth?.nonce ?? "",
        this.options.config.auth.nonceTtlMs,
      );
      if (!nonceOk) {
        connection.socket.close(4403, "replayed_nonce");
        return;
      }
      connection.userId = device.user_id;
      this.options.userAuthStore.markDeviceSeen(device.id);
    }
    connection.role = "agent";
    connection.state = "registered_agent";
    connection.deviceId = message.payload.device_id;
    connection.agentInstanceId = message.payload.agent_instance_id;
    connection.keyId = message.payload.key_id;
    connection.businessSecurityMode =
      message.payload.business_security_mode ?? "e2e_required";
    connection.e2e = message.payload.e2e;
    connection.authenticated = true;
    connection.authState = "verified";
    this.options.registry.addAgentToDevice(
      message.payload.device_id,
      connection,
    );
    this.options.state.registerAgent(connection);
  }
}
