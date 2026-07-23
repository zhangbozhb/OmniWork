import {
  createMessage,
  type AgentAuthChallengePayload,
  type AgentAuthInitPayload,
  type AuthOkPayload,
  type AgentHelloPayload,
  type MessageEnvelope,
} from "@omni-work/protocol-ts";

import type { RelayServerConfig } from "../config.ts";
import { createStatelessAgentAuthChallenge } from "../relayDeviceSignature.ts";
import { RelayAuthExecutor } from "../auth/executor.ts";
import { RelayAuthGuard } from "../auth/guard.ts";
import { RuntimeTopology } from "../runtime/topology.ts";
import { TokenBucketLimiter } from "../tokenBucket.ts";
import { logRelayEvent } from "../relayLog.ts";
import { resolvePublicRemoteIp } from "../ingress/identity.ts";
import type { RelayStateStore } from "../relayStateStore.ts";
import type { RelayConnection } from "../relayTypes.ts";

export interface AgentAdmissionOptions {
  config: RelayServerConfig;
  challengeSecret: Buffer;
  authGuard: RelayAuthGuard;
  authExecutor: RelayAuthExecutor;
  authLimiter: TokenBucketLimiter;
  topology: RuntimeTopology;
  state: RelayStateStore;
  send(connection: RelayConnection, message: MessageEnvelope): void;
}

export class AgentAdmission {
  private readonly options: AgentAdmissionOptions;

  constructor(options: AgentAdmissionOptions) {
    this.options = options;
  }

  handleAgentAuthInit(
    connection: RelayConnection,
    message: MessageEnvelope<AgentAuthInitPayload>,
  ): void {
    if (connection.authState !== "none") {
      connection.socket.close(4403, "invalid_agent_auth_state");
      return;
    }
    if (this.isRateLimited(connection, message.payload.device_id)) {
      return;
    }
    const decision = this.options.authGuard.authorize({
      surface: "agent_auth_init",
      message,
      connectionId: connection.id,
      remoteIp: connection.remoteIp,
    });
    if (!decision.ok) {
      this.recordAuthFailure(connection, message.payload.device_id);
      this.options.authExecutor.execute(decision, { connection });
      return;
    }
    if (!this.consumeInitChallengeAttempt(connection)) {
      return;
    }

    const challenge = createStatelessAgentAuthChallenge({
      deviceId: message.payload.device_id,
      connectionId: connection.id,
      secret: this.options.challengeSecret,
      ttlMs: this.options.config.auth.agentAuthChallengeTtlMs,
    });
    connection.authState = "pending";
    this.options.send(
      connection,
      createMessage<AgentAuthChallengePayload>(
        "agent.auth.challenge",
        { challenge },
        { device_id: message.payload.device_id },
      ),
    );
  }

  handleAgentHello(
    connection: RelayConnection,
    message: MessageEnvelope<AgentHelloPayload>,
  ): void {
    if (this.options.config.auth.mode === "email_link") {
      if (connection.authState === "verified") {
        logRelayEvent({
          event: "agent.hello.ignored",
          reason: "already_verified",
          device_id: connection.deviceId ?? message.payload.device_id,
          agent_connection_id: connection.id,
          remote_ip: connection.remoteIp,
          public_remote_ip: resolvePublicRemoteIp(connection.remoteIp),
        });
        return;
      }
      if (connection.authState !== "pending") {
        connection.socket.close(4403, "invalid_agent_auth_state");
        return;
      }
    }
    if (this.isRateLimited(connection, message.payload.device_id)) {
      return;
    }
    const decision = this.options.authGuard.authorize({
      surface: "agent_hello",
      message,
      connectionId: connection.id,
      remoteIp: connection.remoteIp,
    });
    if (!decision.ok) {
      this.recordAuthFailure(connection, message.payload.device_id);
      this.options.authExecutor.execute(decision, { connection });
      return;
    }
    const publicIp = resolvePublicRemoteIp(connection.remoteIp);
    if (publicIp) {
      this.options.authLimiter.reset(
        buildAgentDeviceAuthRateLimitKey(message.payload.device_id, publicIp),
      );
    }
    connection.userId = decision.subject?.userId;
    connection.role = "agent";
    connection.state = "registered_agent";
    connection.deviceId = message.payload.device_id;
    connection.businessSecurityMode =
      message.payload.business_security_mode ?? "e2e_required";
    connection.e2e = message.payload.e2e;
    connection.authenticated = true;
    connection.authState = "verified";
    this.options.topology.addAgentToDevice(
      message.payload.device_id,
      connection,
    );
    this.options.state.registerAgent(connection);
    this.options.send(
      connection,
      createMessage<AuthOkPayload>(
        "auth.ok",
        {
          agent_connection_id: connection.id,
        },
        { device_id: message.payload.device_id },
      ),
    );
  }

  private isRateLimited(
    connection: RelayConnection,
    deviceId: string,
  ): boolean {
    const publicIp = resolvePublicRemoteIp(connection.remoteIp);
    if (!publicIp) {
      return false;
    }
    const limiterKey = buildAgentAuthRateLimitKey(deviceId, publicIp);
    const ipLimiterKey = buildAgentIpAuthRateLimitKey(publicIp);
    if (
      !this.options.authLimiter.isBlocked(limiterKey) &&
      !this.options.authLimiter.isBlocked(ipLimiterKey)
    ) {
      return false;
    }
    connection.socket.close(4403, "too_many_attempts");
    return true;
  }

  private recordAuthFailure(
    connection: RelayConnection,
    deviceId: string,
  ): void {
    const publicIp = resolvePublicRemoteIp(connection.remoteIp);
    if (!publicIp) {
      return;
    }
    this.options.authLimiter.consume(
      buildAgentDeviceAuthRateLimitKey(deviceId, publicIp),
    );
    this.options.authLimiter.consume(buildAgentIpAuthRateLimitKey(publicIp));
  }

  private consumeInitChallengeAttempt(connection: RelayConnection): boolean {
    const publicIp = resolvePublicRemoteIp(connection.remoteIp);
    if (!publicIp) {
      return true;
    }
    const ok = this.options.authLimiter.consume(
      buildAgentIpAuthRateLimitKey(publicIp),
    );
    if (ok) {
      return true;
    }
    connection.socket.close(4403, "too_many_attempts");
    return false;
  }
}

function buildAgentAuthRateLimitKey(
  deviceId: string | undefined,
  remoteIp: string | undefined,
): string {
  return buildAgentDeviceAuthRateLimitKey(deviceId, remoteIp);
}

function buildAgentDeviceAuthRateLimitKey(
  deviceId: string | undefined,
  remoteIp: string | undefined,
): string {
  return ["agent", deviceId ?? "_", remoteIp ?? "_"].join("|");
}

function buildAgentIpAuthRateLimitKey(remoteIp: string | undefined): string {
  return ["agent_ip", remoteIp ?? "_"].join("|");
}
