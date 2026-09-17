import {
  RELAY_AGENT_APPROVAL_REQUIRED_CLOSE_CODE,
  RELAY_AGENT_APPROVAL_REQUIRED_CLOSE_REASON,
  RELAY_AGENT_SHUTDOWN_CLOSE_CODE,
  createMessage,
  type AgentAuthChallengePayload,
  type AgentAuthInitPayload,
  type AgentAuthOkPayload,
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
import type {
  AgentAuthorizationDecision,
  RelayConnection,
  RelayConnectionBase,
} from "../relayTypes.ts";

export interface AgentAdmissionOptions {
  config: RelayServerConfig;
  challengeSecret: Buffer;
  authGuard: RelayAuthGuard;
  authExecutor: RelayAuthExecutor;
  authLimiter: TokenBucketLimiter;
  topology: RuntimeTopology;
  state: RelayStateStore;
  authorizeAgent(input: {
    deviceId: string;
    devicePublicKey: string;
    remoteIp: string;
    publicRemoteIp: string | null;
    hostname: string;
    systemType: string;
    uname: string;
    agentVersion: string;
  }): AgentAuthorizationDecision;
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
    const authorization = this.options.authorizeAgent({
      deviceId: message.payload.device_id,
      devicePublicKey: message.payload.device_public_key,
      remoteIp: connection.remoteIp,
      publicRemoteIp: publicIp,
      hostname: message.payload.hostname,
      systemType: message.payload.system_type ?? message.payload.platform,
      uname: message.payload.uname ?? message.payload.hostname,
      agentVersion: message.payload.agent_version,
    });
    if (!authorization.ok) {
      connection.authState = "failed";
      logRelayEvent({
        event: "agent.authorization.rejected",
        reason: authorization.reason,
        device_id: message.payload.device_id,
        agent_connection_id: connection.id,
        remote_ip: connection.remoteIp,
      });
      connection.socket.close(
        authorization.reason === RELAY_AGENT_APPROVAL_REQUIRED_CLOSE_REASON
          ? RELAY_AGENT_APPROVAL_REQUIRED_CLOSE_CODE
          : RELAY_AGENT_SHUTDOWN_CLOSE_CODE,
        authorization.reason,
      );
      return;
    }
    if (publicIp) {
      this.options.authLimiter.reset(
        buildAgentDeviceAuthRateLimitKey(message.payload.device_id, publicIp),
      );
    }
    const authenticated = connection as RelayConnectionBase;
    authenticated.userId = decision.subject?.userId;
    authenticated.role = "agent";
    authenticated.state = "registered_agent";
    authenticated.deviceId = message.payload.device_id;
    authenticated.devicePublicKey = message.payload.device_public_key;
    authenticated.e2e = message.payload.e2e;
    authenticated.authenticated = true;
    authenticated.authState = "verified";
    this.options.topology.addAgentToDevice(
      message.payload.device_id,
      connection,
    );
    this.options.state.registerAgent(connection);
    this.options.send(
      connection,
      createMessage<AgentAuthOkPayload>(
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
