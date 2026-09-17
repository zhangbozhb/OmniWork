import {
  SIGNATURE_DOMAINS,
  appAuthSignatureFields,
  createMessage,
  identityMatchesPublicKey,
  verifyIdentityFields,
  type AuthFailedPayload,
  type AuthOkPayload,
  type AuthPendingPayload,
  type AuthProofPayload,
  type AuthVerifyPayload,
  type MessageEnvelope,
} from "@omni-work/protocol-ts";

import type { RelayServerConfig } from "../config.ts";
import { RuntimeTopology } from "../runtime/topology.ts";
import { logRelayEvent } from "../relayLog.ts";
import { appInfoToPayload, buildAuthRateLimitKey } from "./payload.ts";
import type { RelayStateStore } from "../relayStateStore.ts";
import { TokenBucketLimiter } from "../tokenBucket.ts";
import type { PendingAuth, RelayConnection } from "../relayTypes.ts";

export interface AppAuthBridgeOptions {
  config: RelayServerConfig;
  topology: RuntimeTopology;
  state: RelayStateStore;
  pendingAuth: Map<string, PendingAuth>;
  authLimiter: TokenBucketLimiter;
  send(connection: RelayConnection, message: MessageEnvelope): void;
}

export class AppAuthBridge {
  private readonly options: AppAuthBridgeOptions;

  constructor(options: AppAuthBridgeOptions) {
    this.options = options;
  }

  handleAuthProof(
    connection: RelayConnection,
    message: MessageEnvelope<AuthProofPayload>,
  ): void {
    const pending = this.options.pendingAuth.get(connection.id);
    const limiterKey = buildAuthRateLimitKey(
      pending?.deviceId ?? connection.deviceId,
      connection.remoteIp,
    );
    if (this.options.authLimiter.isBlocked(limiterKey)) {
      logRelayEvent({
        event: "auth.rate_limit",
        device_id: pending?.deviceId ?? connection.deviceId,
        remote_ip: connection.remoteIp,
      });
      this.fail(connection, "too_many_attempts");
      connection.socket.close(1008, "auth rate limit");
      return;
    }

    if (!pending || !this.matchesPending(connection, pending, message.payload)) {
      this.options.authLimiter.consume(limiterKey);
      this.fail(connection, "malformed_proof");
      return;
    }
    const now = Date.now();
    if (pending.expiresAt <= now) {
      this.options.pendingAuth.delete(connection.id);
      this.options.authLimiter.consume(limiterKey);
      this.fail(connection, "malformed_proof");
      return;
    }
    if (
      Math.abs(now - message.payload.timestamp) >
      this.options.config.auth.nonceTtlMs
    ) {
      this.options.authLimiter.consume(limiterKey);
      this.fail(connection, "malformed_proof");
      return;
    }
    const { signature, ...unsigned } = message.payload;
    if (
      !verifyIdentityFields(
        message.payload.app_public_key,
        SIGNATURE_DOMAINS.appAuth,
        appAuthSignatureFields(unsigned),
        signature,
      )
    ) {
      this.options.authLimiter.consume(limiterKey);
      this.fail(connection, "invalid_signature");
      return;
    }

    const agent = this.options.topology.getPrimaryAgent(pending.deviceId);
    if (!agent || agent.id !== pending.agentConnectionId) {
      this.fail(connection, "device_not_online");
      return;
    }

    const forwarded: AuthVerifyPayload = {
      ...message.payload,
      app_info: appInfoToPayload(pending.appInfo),
      observations: connection.observations,
    };
    this.options.send(
      agent,
      createMessage("auth.verify", forwarded, {
        device_id: pending.deviceId,
        app_connection_id: connection.id,
      }),
    );
  }

  handleAuthResult(
    connection: RelayConnection,
    message: MessageEnvelope,
  ): void {
    if (connection.role !== "agent") {
      return;
    }

    const payload = message.payload as
      | AuthOkPayload
      | AuthPendingPayload
      | AuthFailedPayload;
    const mobile = this.options.topology.getConnection(payload.connection_id);
    if (
      mobile?.role !== "mobile" ||
      mobile.deviceId !== connection.deviceId
    ) {
      return;
    }

    if (message.type === "auth.pending") {
      const pending = this.options.pendingAuth.get(mobile.id);
      const approvalExpiresAt = Date.parse(
        (message.payload as AuthPendingPayload).expires_at,
      );
      if (pending && Number.isFinite(approvalExpiresAt)) {
        pending.expiresAt = approvalExpiresAt;
        pending.approvalPending = true;
      }
      this.options.send(mobile, message);
      return;
    }

    const pending = this.options.pendingAuth.get(mobile.id);
    this.options.pendingAuth.delete(mobile.id);
    if (message.type === "auth.ok") {
      const ok = message.payload as AuthOkPayload;
      if (
        !pending ||
        ok.nonce !== pending.nonce ||
        ok.device_id !== pending.deviceId ||
        ok.app_id !== pending.appId ||
        ok.agent_connection_id !== connection.id ||
        ok.connection_id !== mobile.id ||
        ok.agent_public_key !== connection.devicePublicKey
      ) {
        this.fail(mobile, "malformed_proof");
        return;
      }
      mobile.authenticated = true;
      mobile.authState = "verified";
      mobile.state = "relay_pairing_verified";
      this.options.state.authenticateApp(mobile, connection);
      this.options.authLimiter.reset(
        buildAuthRateLimitKey(mobile.deviceId, mobile.remoteIp),
      );
      if (mobile.deviceId) {
        this.options.topology.addMobileToDevice(mobile.deviceId, mobile);
      }
    } else if (message.type === "auth.failed") {
      mobile.authState = "failed";
      this.options.state.recordAuthFailed();
      this.options.authLimiter.consume(
        buildAuthRateLimitKey(mobile.deviceId, mobile.remoteIp),
      );
    }
    this.options.send(mobile, message);
  }

  private matchesPending(
    connection: RelayConnection,
    pending: PendingAuth,
    payload: AuthProofPayload,
  ): boolean {
    return (
      payload.nonce === pending.nonce &&
      payload.connection_id === connection.id &&
      payload.agent_connection_id === pending.agentConnectionId &&
      payload.device_id === pending.deviceId &&
      payload.agent_public_key === pending.agentPublicKey &&
      payload.app_id === pending.appId &&
      payload.app_public_key === pending.appPublicKey &&
      payload.app_info.instance_id === pending.appInfo.instanceId &&
      payload.app_info.runtime_id === pending.appInfo.runtimeId &&
      identityMatchesPublicKey("app", payload.app_id, payload.app_public_key) &&
      identityMatchesPublicKey(
        "agent",
        payload.device_id,
        payload.agent_public_key,
      )
    );
  }

  private fail(
    connection: RelayConnection,
    reason: AuthFailedPayload["reason"],
  ): void {
    connection.authState = "failed";
    this.options.state.recordAuthFailed();
    this.options.send(
      connection,
      createMessage<AuthFailedPayload>(
        "auth.failed",
        {
          reason,
          connection_id: connection.id,
          retry_after_ms: 2000,
        },
        { device_id: connection.deviceId },
      ),
    );
  }
}
