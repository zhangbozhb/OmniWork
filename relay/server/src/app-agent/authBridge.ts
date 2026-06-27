import {
  createMessage,
  type AuthFailedPayload,
  type AuthOkPayload,
  type AuthProofPayload,
  type MessageEnvelope,
} from "@omniwork/protocol-ts";

import type { RelayServerConfig } from "../config.ts";
import { RuntimeTopology } from "../runtime/topology.ts";
import { logRelayEvent } from "../relayLog.ts";
import { appInfoToPayload, buildAuthRateLimitKey } from "./payload.ts";
import type { RelayStateStore } from "../relayStateStore.ts";
import { TokenBucketLimiter } from "../tokenBucket.ts";
import { RelayUpgradeOrchestrator } from "../upgrade/orchestrator.ts";
import type { PendingAuth, RelayConnection } from "../relayTypes.ts";

export interface AppAuthBridgeOptions {
  config: RelayServerConfig;
  topology: RuntimeTopology;
  state: RelayStateStore;
  pendingAuth: Map<string, PendingAuth>;
  authLimiter: TokenBucketLimiter;
  orchestrator: RelayUpgradeOrchestrator;
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
      message.payload.key_id,
      pending?.deviceId ?? connection.deviceId,
      connection.remoteIp,
    );

    if (this.options.authLimiter.isBlocked(limiterKey)) {
      logRelayEvent({
        event: "auth.rate_limit",
        key_id: message.payload.key_id,
        device_id: pending?.deviceId ?? connection.deviceId,
        remote_ip: connection.remoteIp,
      });
      this.options.send(
        connection,
        createMessage<AuthFailedPayload>(
          "auth.failed",
          {
            reason: "too_many_attempts",
            connection_id: connection.id,
            retry_after_ms: this.options.config.authRateLimit.blockMs,
          },
          { device_id: connection.deviceId },
        ),
      );
      connection.authState = "failed";
      this.options.state.recordAuthFailed();
      connection.socket.close(1008, "auth rate limit");
      return;
    }

    if (
      !pending ||
      message.payload.nonce !== pending.nonce ||
      message.payload.key_id !== pending.keyId ||
      message.payload.app_info.instance_id !== pending.appInfo.instanceId ||
      message.payload.app_info.runtime_id !== pending.appInfo.runtimeId
    ) {
      // 仅对失败的 proof 计数，避免合法重连/切偏好的连续 proof 把桶耗尽
      // 触发 60s 误封禁。limiter.reset 在 auth.ok 时清零，所以正常路径
      // 始终通过；这里 consume 的返回值已经被上面的 isBlocked 覆盖，忽略即可。
      this.options.authLimiter.consume(limiterKey);
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
      this.options.state.recordAuthFailed();
      return;
    }

    const agent = this.options.topology.getPrimaryAgent(pending.deviceId);
    if (!agent) {
      this.options.send(
        connection,
        createMessage<AuthFailedPayload>(
          "auth.failed",
          {
            reason: "device_not_online",
            connection_id: connection.id,
            retry_after_ms: 2000,
          },
          { device_id: pending.deviceId },
        ),
      );
      connection.authState = "failed";
      this.options.state.recordAuthFailed();
      return;
    }

    this.options.send(
      agent,
      createMessage(
        "auth.verify",
        {
          key_id: message.payload.key_id,
          nonce: message.payload.nonce,
          app_info: appInfoToPayload(pending.appInfo),
          proof: message.payload.proof,
          connection_id: connection.id,
          observations: connection.observations,
        },
        { device_id: pending.deviceId },
      ),
    );
  }

  handleAuthResult(
    connection: RelayConnection,
    message: MessageEnvelope,
  ): void {
    if (connection.role !== "agent") {
      return;
    }

    const payload = message.payload as AuthOkPayload | AuthFailedPayload;
    const mobile = this.options.topology.getConnection(payload.connection_id);
    if (!mobile) {
      return;
    }

    const pending = this.options.pendingAuth.get(mobile.id);
    this.options.pendingAuth.delete(mobile.id);
    if (message.type === "auth.ok") {
      const okPayload = message.payload as AuthOkPayload;
      const agentMode = connection.businessSecurityMode ?? "e2e_required";
      okPayload.business_security_mode ??= agentMode;
      okPayload.e2e ??= connection.e2e;
      mobile.authenticated = true;
      mobile.authState = "verified";
      mobile.state = "relay_pairing_verified";
      this.options.state.authenticateApp(mobile, connection);
      // 鉴权成功后释放限流计数，避免合法重连被旧失败拖累。
      this.options.authLimiter.reset(
        buildAuthRateLimitKey(pending?.keyId, mobile.deviceId, mobile.remoteIp),
      );
      if (mobile.deviceId) {
        this.options.topology.addMobileToDevice(mobile.deviceId, mobile);
        if (agentMode === "plaintext_allowed") {
          this.options.orchestrator.notifyMobileAuthenticated(
            mobile.deviceId,
            mobile,
          );
        }
      }
    } else if (message.type === "auth.failed") {
      mobile.authState = "failed";
      this.options.state.recordAuthFailed();
      // agent 端确认 key 不匹配 → 这才是真实的鉴权失败，计入限流；
      // 避免合法 proof 被一并消耗 token 触发 60s 误封禁。
      this.options.authLimiter.consume(
        buildAuthRateLimitKey(pending?.keyId, mobile.deviceId, mobile.remoteIp),
      );
    }

    this.options.send(mobile, message);
  }
}
