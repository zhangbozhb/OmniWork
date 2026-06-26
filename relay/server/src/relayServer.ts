import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

import geoip from "geoip-lite";
import {
  createMessage,
  isTransportPreference,
  parseMessageEnvelope,
  type AgentHelloPayload,
  type AppConnectionObservation,
  type AppInfoPayload,
  type AppNetworkChangedPayload,
  type AuthFailedPayload,
  type AuthOkPayload,
  type BusinessSecurityMode,
  type AuthProofPayload,
  type E2EFailedPayload,
  type E2EHandshakeInitPayload,
  type E2EHandshakeReplyPayload,
  type E2EMessagePayload,
  type E2EReadyPayload,
  type MessageEnvelope,
  type MobileConnectPayload,
  type ProtocolErrorPayload,
  type RelayAppDeliverPayload,
} from "@omniwork/protocol-ts";

import type { RelayServerConfig } from "./config.ts";
import { RelayAdminController } from "./relayAdminController.ts";
import { RelayE2EController } from "./relayE2EController.ts";
import { logRelayEvent, logUpgradeEvent } from "./relayLog.ts";
import { RelayStateStore } from "./relayStateStore.ts";
import { TokenBucketLimiter } from "./tokenBucket.ts";
import { RelayUpgradeOrchestrator } from "./upgrade/orchestrator.ts";
import { acceptWebSocket } from "./websocket.ts";
import type {
  PendingAuth,
  RelayAppInfo,
  RelayConnection,
  RelayConnectionLocation,
  RelayEndpoint,
  RelayRoutedAppMessage,
  RelaySocket,
} from "./relayTypes.ts";

// Relay keeps App request routing context only for immediate Agent control
// responses, not as a request queue. Keep the relay-issued handle short-lived.
const APP_DELIVERY_CONTEXT_TTL_MS = 16_000;

interface AppDeliveryContext {
  deviceId: string;
  agentConnectionId: string;
  appConnectionId: string;
  expiresAt: number;
}

export class RelayServer {
  private readonly config: RelayServerConfig;
  private readonly connections = new Map<string, RelayConnection>();
  private readonly agentsByDevice = new Map<string, Set<RelayConnection>>();
  private readonly primaryAgentByDevice = new Map<string, RelayConnection>();
  private readonly pendingAuth = new Map<string, PendingAuth>();
  private readonly mobilesByDevice = new Map<string, Set<RelayConnection>>();
  private readonly appDeliveryContexts = new Map<string, AppDeliveryContext>();
  private readonly state = new RelayStateStore();
  private readonly admin: RelayAdminController;
  private readonly e2e: RelayE2EController;
  private readonly authLimiter: TokenBucketLimiter;
  private readonly orchestrator: RelayUpgradeOrchestrator;

  constructor(config: RelayServerConfig) {
    this.config = config;
    this.authLimiter = new TokenBucketLimiter({
      capacity: config.authRateLimit.capacity,
      refillPerSecond: config.authRateLimit.refillPerSecond,
      blockMs: config.authRateLimit.blockMs,
    });
    this.admin = new RelayAdminController({
      config,
      connections: this.connections,
      mobilesByDevice: this.mobilesByDevice,
      state: this.state,
      unregister: (connection) => this.unregister(connection),
    });
    this.e2e = new RelayE2EController({
      protocolVersion: config.protocolVersion,
      connections: this.connections,
      agentsByDevice: this.primaryAgentByDevice,
      send: (connection, message) => this.send(connection, message),
      routeMessage: (connection, message) =>
        this.routeMessage(connection, message),
      notifyMobileAuthenticated: (deviceId, mobile) =>
        this.orchestrator.notifyMobileAuthenticated(deviceId, mobile),
    });
    this.orchestrator = new RelayUpgradeOrchestrator({
      config: config.upgrade,
      send: (conn, msg) => this.send(conn as RelayConnection, msg),
      getAgent: (deviceId) => this.primaryAgentByDevice.get(deviceId),
    });
  }

  async start(): Promise<void> {
    const startupToken = this.admin.start();
    const businessServer = createServer((request, response) =>
      this.handleBusinessHttp(request, response),
    );
    const adminServer = createServer((request, response) =>
      this.handleAdminHttp(request, response),
    );
    businessServer.on("upgrade", (request, socket) => {
      const endpoint = parseRelayEndpoint(request);
      const remoteIp = resolveRemoteIp(request, socket as Socket, {
        trustProxy: this.config.admin.trustProxy,
        trustedProxyIps: this.config.admin.trustedProxyIps,
      });
      const activeBan = this.admin.activeIpBan(remoteIp.ip);
      if (activeBan) {
        rejectWebSocketUpgrade(socket as Socket, "ip_banned", 403);
        return;
      }
      if (endpoint !== "agent" && endpoint !== "mobile") {
        rejectWebSocketUpgrade(
          socket as Socket,
          "Use /relay/ws/agent or /relay/ws/mobile for OmniWork connections.",
        );
        return;
      }

      const connection = acceptWebSocket(request, socket as Socket);
      if (connection) {
        this.register(connection, endpoint, {
          remoteIp: remoteIp.ip,
          location: resolveConnectionLocation(remoteIp.ip),
          observations: [createRelayObservation(request, remoteIp)],
        });
      }
    });

    await new Promise<void>((resolve) => {
      businessServer.listen(this.config.port, this.config.host, resolve);
    });
    await new Promise<void>((resolve) => {
      adminServer.listen(
        this.config.admin.port,
        this.config.admin.host,
        resolve,
      );
    });

    logRelayEvent({
      event: "server.listening",
      listener: "business",
      host: this.config.host,
      port: this.config.port,
    });
    logRelayEvent({
      event: "server.listening",
      listener: "admin",
      host: this.config.admin.host,
      port: this.config.admin.port,
    });
    logRelayEvent({
      event: "admin.token.ready",
      token: startupToken.token,
      token_expires_at: new Date(startupToken.expiresAt).toISOString(),
      token_file: this.admin.tokenPath(),
      token_rotate_ms: this.config.admin.tokenRotateMs,
      session_ttl_ms: this.config.admin.sessionTtlMs,
      https_required: this.config.admin.requireHttps,
      web_enabled: this.config.admin.webEnabled,
      admin_host: this.config.admin.host,
      admin_port: this.config.admin.port,
      controls_db: this.config.admin.controlsDbPath,
    });
  }

  private handleBusinessHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    if (request.url === "/healthz" || request.url === "/readyz") {
      this.writeJson(response, 200, { ok: true });
      return;
    }

    if (request.url === "/metrics") {
      this.writeJson(response, 200, {
        relay: this.state.runtimeSnapshot(),
        upgrade: this.orchestrator.getMetrics(),
      });
      return;
    }

    if (
      request.method === "POST" &&
      typeof request.url === "string" &&
      request.url.startsWith("/debug/upgrade")
    ) {
      this.handleDebugUpgrade(request, response);
      return;
    }

    this.writeJson(response, 404, { error: "not_found" });
  }

  private handleAdminHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const url = new URL(request.url ?? "/", "http://relay.local");
    if (!this.admin.matches(url.pathname)) {
      this.writeJson(response, 404, { error: "not_found" });
      return;
    }
    this.admin.handle(request, response, url).catch((error: unknown) => {
      this.writeJson(response, 500, {
        error: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private handleDebugUpgrade(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const url = new URL(request.url ?? "/", "http://relay.local");
    const deviceId = url.searchParams.get("device_id");
    const appConnectionId = url.searchParams.get("app_connection_id");
    if (!deviceId) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "missing_device_id" }));
      return;
    }
    if (!appConnectionId) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "missing_app_connection_id" }));
      return;
    }

    const agent = this.getPrimaryAgent(deviceId);
    const mobile = this.connections.get(appConnectionId);
    if (
      !agent ||
      mobile?.role !== "mobile" ||
      mobile.deviceId !== deviceId ||
      !this.e2e.isBusinessChannelReadyForApp(appConnectionId, deviceId)
    ) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "device_not_online" }));
      return;
    }

    const upgradeId = this.orchestrator.triggerUpgrade(deviceId, mobile, agent);

    logUpgradeEvent({
      event: "debug.trigger_upgrade",
      device_id: deviceId,
      upgrade_id: upgradeId,
    });

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, upgrade_id: upgradeId }));
  }

  private register(
    socket: RelaySocket,
    endpoint: RelayEndpoint,
    options: {
      remoteIp?: string;
      location?: RelayConnectionLocation;
      observations?: AppConnectionObservation[];
    } = {},
  ): void {
    const now = Date.now();
    const connection: RelayConnection = {
      id: `conn_${randomUUID()}`,
      endpoint,
      role: "unknown",
      state: "socket_connected",
      socket,
      authenticated: false,
      remoteIp: options.remoteIp ?? "unknown",
      location: options.location,
      observations: options.observations ?? [],
      connectedAt: now,
      lastSeenAt: now,
      authState: "none",
      transportPath: "relay",
    };
    this.connections.set(connection.id, connection);
    this.state.registerConnection(connection);

    socket.onMessage((raw) => this.handleRawMessage(connection, raw));
    socket.onClose(() => this.unregister(connection));
  }

  private unregister(connection: RelayConnection): void {
    connection.state = "closed";
    this.connections.delete(connection.id);
    this.pendingAuth.delete(connection.id);
    if (connection.role === "agent" && connection.deviceId) {
      const agents = this.agentsByDevice.get(connection.deviceId);
      agents?.delete(connection);
      if (agents && agents.size === 0) {
        this.agentsByDevice.delete(connection.deviceId);
      }
      if (this.primaryAgentByDevice.get(connection.deviceId) === connection) {
        const next = agents?.values().next().value;
        if (next) {
          this.primaryAgentByDevice.set(connection.deviceId, next);
        } else {
          this.primaryAgentByDevice.delete(connection.deviceId);
          this.orchestrator.notifyAgentDisconnected(connection.deviceId);
        }
      }
    }
    if (connection.role === "mobile" && connection.deviceId) {
      this.mobilesByDevice.get(connection.deviceId)?.delete(connection);
      this.orchestrator.notifyMobileDisconnected(
        connection.deviceId,
        connection,
      );
    }
    this.state.closeConnection(connection);
  }

  private handleRawMessage(connection: RelayConnection, raw: string): void {
    connection.lastSeenAt = Date.now();
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      connection.socket.close(1003, "invalid json");
      return;
    }
    const message = parseMessageEnvelope(decoded);
    if (!message) {
      connection.socket.close(1003, "invalid protocol message");
      return;
    }
    this.state.recordIngress(connection, message, Buffer.byteLength(raw));

    switch (message.type) {
      case "agent.hello":
        if (!this.ensureEndpoint(connection, "agent")) {
          return;
        }
        this.handleAgentHello(
          connection,
          message as MessageEnvelope<AgentHelloPayload>,
        );
        break;
      case "mobile.connect":
        if (!this.ensureEndpoint(connection, "mobile")) {
          return;
        }
        this.handleMobileConnect(
          connection,
          message as MessageEnvelope<MobileConnectPayload>,
        );
        break;
      case "auth.proof":
        this.handleAuthProof(
          connection,
          message as MessageEnvelope<AuthProofPayload>,
        );
        break;
      case "auth.ok":
      case "auth.failed":
        this.handleAuthResult(connection, message);
        break;
      case "app.network.changed":
        this.handleAppNetworkChanged(
          connection,
          message as MessageEnvelope<AppNetworkChangedPayload>,
        );
        break;
      case "relay.app.deliver":
        this.handleRelayAppDeliver(
          connection,
          message as MessageEnvelope<RelayAppDeliverPayload>,
        );
        break;
      case "e2e.handshake.init":
        this.e2e.handleHandshakeInit(
          connection,
          message as MessageEnvelope<E2EHandshakeInitPayload>,
        );
        this.updateLinkForConnection(connection);
        break;
      case "e2e.handshake.reply":
        {
          const typed = message as MessageEnvelope<E2EHandshakeReplyPayload>;
          this.e2e.handleHandshakeReply(connection, typed);
          this.updateLinkForAppConnectionId(typed.payload.app_connection_id);
        }
        break;
      case "e2e.ready":
        {
          const typed = message as MessageEnvelope<E2EReadyPayload>;
          this.e2e.handleReady(connection, typed);
          this.updateLinkForAppConnectionId(typed.payload.app_connection_id);
        }
        break;
      case "e2e.message":
        {
          const typed = message as MessageEnvelope<E2EMessagePayload>;
          this.e2e.handleMessage(connection, typed);
          this.updateLinkForAppConnectionId(typed.payload.app_connection_id);
        }
        break;
      case "e2e.failed":
        {
          const typed = message as MessageEnvelope<E2EFailedPayload>;
          this.e2e.handleFailed(connection, typed);
          this.updateLinkForAppConnectionId(typed.payload.app_connection_id);
        }
        break;
      case "e2e.rekey.init":
      case "e2e.rekey.reply":
      case "e2e.rekey.ready":
      case "e2e.close":
        this.e2e.routeControl(connection, message);
        break;
      case "tunnel.upgrade.propose":
      case "tunnel.upgrade.offer":
      case "tunnel.upgrade.answer":
      case "tunnel.upgrade.candidate":
      case "tunnel.upgrade.committed":
      case "tunnel.upgrade.downgrade":
        logUpgradeEvent({
          event: message.type,
          device_id: connection.deviceId,
          upgrade_id: (message.payload as { upgrade_id?: string })?.upgrade_id,
          reason: (message.payload as { reason?: string })?.reason,
          source_role: connection.role,
        });
        if (
          message.type === "tunnel.upgrade.committed" ||
          message.type === "tunnel.upgrade.downgrade"
        ) {
          if (message.type === "tunnel.upgrade.committed") {
            connection.transportPath = "p2p";
          } else {
            connection.transportPath = "relay";
          }
          this.updateLinkForAppConnectionId(
            (message.payload as { app_connection_id?: string })
              ?.app_connection_id,
          );
          this.orchestrator.handleControlMessage(message);
        }
        this.routeMessage(connection, message);
        break;
      default:
        this.routeMessage(connection, message);
        break;
    }
  }

  private handleAgentHello(
    connection: RelayConnection,
    message: MessageEnvelope<AgentHelloPayload>,
  ): void {
    if (
      this.admin.activeDisabledAgentInstance(message.payload.agent_instance_id)
    ) {
      connection.socket.close(4403, "agent_disabled");
      return;
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
    this.addAgentToDevice(message.payload.device_id, connection);
    this.state.registerAgent(connection);
  }

  private handleMobileConnect(
    connection: RelayConnection,
    message: MessageEnvelope<MobileConnectPayload>,
  ): void {
    const deviceId = message.payload.device_id;
    const agent = this.getPrimaryAgent(deviceId);
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
    this.state.registerApp(connection);

    if (!agent?.keyId) {
      connection.authState = "failed";
      this.send(
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
    this.pendingAuth.set(connection.id, {
      deviceId,
      nonce,
      keyId: agent.keyId,
      appInfo,
    });

    this.send(
      connection,
      createMessage(
        "auth.challenge",
        {
          nonce,
          key_id: agent.keyId,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
        { device_id: deviceId },
      ),
    );
  }

  private handleAuthProof(
    connection: RelayConnection,
    message: MessageEnvelope<AuthProofPayload>,
  ): void {
    const pending = this.pendingAuth.get(connection.id);
    const limiterKey = buildAuthRateLimitKey(
      message.payload.key_id,
      pending?.deviceId ?? connection.deviceId,
      connection.remoteIp,
    );

    if (this.authLimiter.isBlocked(limiterKey)) {
      logRelayEvent({
        event: "auth.rate_limit",
        key_id: message.payload.key_id,
        device_id: pending?.deviceId ?? connection.deviceId,
        remote_ip: connection.remoteIp,
      });
      this.send(
        connection,
        createMessage<AuthFailedPayload>(
          "auth.failed",
          {
            reason: "too_many_attempts",
            connection_id: connection.id,
            retry_after_ms: this.config.authRateLimit.blockMs,
          },
          { device_id: connection.deviceId },
        ),
      );
      connection.authState = "failed";
      this.state.recordAuthFailed();
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
      this.authLimiter.consume(limiterKey);
      this.send(
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
      this.state.recordAuthFailed();
      return;
    }

    const agent = this.getPrimaryAgent(pending.deviceId);
    if (!agent) {
      this.send(
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
      this.state.recordAuthFailed();
      return;
    }

    this.send(
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

  private handleAppNetworkChanged(
    connection: RelayConnection,
    message: MessageEnvelope<AppNetworkChangedPayload>,
  ): void {
    if (
      connection.role !== "mobile" ||
      !connection.authenticated ||
      !connection.deviceId ||
      message.payload.app_connection_id !== connection.id
    ) {
      this.rejectInvalidState(connection, message.type);
      return;
    }
    if (
      !this.e2e.isBusinessChannelReadyForApp(connection.id, connection.deviceId)
    ) {
      this.rejectInvalidState(connection, message.type);
      return;
    }

    const upgradeId = this.orchestrator.handleConnectivityChanged(
      connection.deviceId,
      connection,
    );
    logUpgradeEvent({
      event: message.type,
      device_id: connection.deviceId,
      upgrade_id: upgradeId ?? undefined,
      reason: message.payload.reason,
      source_role: connection.role,
    });
  }

  private handleAuthResult(
    connection: RelayConnection,
    message: MessageEnvelope,
  ): void {
    if (connection.role !== "agent") {
      return;
    }

    const payload = message.payload as AuthOkPayload | AuthFailedPayload;
    const mobileConnectionId = payload.connection_id;
    const mobile = mobileConnectionId
      ? this.connections.get(mobileConnectionId)
      : undefined;
    if (!mobile) {
      return;
    }

    const pending = this.pendingAuth.get(mobile.id);
    this.pendingAuth.delete(mobile.id);
    if (message.type === "auth.ok") {
      const okPayload = message.payload as AuthOkPayload;
      const agentMode = connection.businessSecurityMode ?? "e2e_required";
      okPayload.business_security_mode ??= agentMode;
      okPayload.e2e ??= connection.e2e;
      mobile.authenticated = true;
      mobile.authState = "verified";
      mobile.state = "relay_pairing_verified";
      this.state.authenticateApp(mobile, connection);
      // 鉴权成功后释放限流计数，避免合法重连被旧失败拖累。
      this.authLimiter.reset(
        buildAuthRateLimitKey(pending?.keyId, mobile.deviceId, mobile.remoteIp),
      );
      if (mobile.deviceId) {
        const mobiles =
          this.mobilesByDevice.get(mobile.deviceId) ??
          new Set<RelayConnection>();
        mobiles.add(mobile);
        this.mobilesByDevice.set(mobile.deviceId, mobiles);
        if (agentMode === "plaintext_allowed") {
          this.orchestrator.notifyMobileAuthenticated(mobile.deviceId, mobile);
        }
      }
    } else if (message.type === "auth.failed") {
      mobile.authState = "failed";
      this.state.recordAuthFailed();
      // agent 端确认 key 不匹配 → 这才是真实的鉴权失败，计入限流；
      // 避免合法 proof 被一并消耗 token 触发 60s 误封禁。
      this.authLimiter.consume(
        buildAuthRateLimitKey(pending?.keyId, mobile.deviceId, mobile.remoteIp),
      );
    }

    this.send(mobile, message);
  }

  private routeMessage(
    connection: RelayConnection,
    message: MessageEnvelope,
  ): void {
    if (connection.role === "mobile") {
      if (!connection.authenticated || !connection.deviceId) {
        this.send(
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

      const agent = this.getPrimaryAgent(connection.deviceId);
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
        this.send(agent, routedMessage);
      } else {
        this.state.recordRouteDropped();
      }
      return;
    }

    if (connection.role === "agent" && connection.deviceId) {
      if (message.app_connection_id) {
        const mobile = this.connections.get(message.app_connection_id);
        if (mobile) {
          this.send(mobile, message);
        } else {
          this.state.recordRouteDropped();
        }
        return;
      }
      const mobiles = this.mobilesByDevice.get(connection.deviceId);
      if (!mobiles) {
        this.state.recordRouteDropped();
        return;
      }
      for (const mobile of mobiles) {
        this.send(mobile, message);
      }
    }
  }

  private handleRelayAppDeliver(
    connection: RelayConnection,
    message: MessageEnvelope<RelayAppDeliverPayload>,
  ): void {
    if (connection.role !== "agent" || !connection.deviceId) {
      this.rejectInvalidState(connection, message.type);
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

    const mobile = this.connections.get(context.appConnectionId);
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
    this.send(
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
      expiresAt: Date.now() + APP_DELIVERY_CONTEXT_TTL_MS,
    });
    return relayContextId;
  }

  private takeAppDeliveryContext(
    relayContextId: string,
  ): AppDeliveryContext | null {
    this.cleanupExpiredAppDeliveryContexts();
    const context = this.appDeliveryContexts.get(relayContextId);
    if (!context) {
      return null;
    }
    this.appDeliveryContexts.delete(relayContextId);
    return context;
  }

  private cleanupExpiredAppDeliveryContexts(now = Date.now()): void {
    for (const [relayContextId, context] of this.appDeliveryContexts) {
      if (context.expiresAt <= now) {
        this.appDeliveryContexts.delete(relayContextId);
      }
    }
  }

  private rejectInvalidState(connection: RelayConnection, type: string): void {
    this.sendProtocolError(
      connection,
      "invalid_state",
      `Message type "${type}" is not allowed in state "${connection.state}".`,
      false,
    );
  }

  private sendProtocolError(
    connection: RelayConnection,
    code: ProtocolErrorPayload["code"],
    detail: string,
    retryable: boolean,
  ): void {
    this.state.recordProtocolErrorSent();
    this.send(
      connection,
      createMessage<ProtocolErrorPayload>(
        "protocol.error",
        {
          v: this.config.protocolVersion,
          code,
          detail,
          retryable,
        },
        { device_id: connection.deviceId },
      ),
    );
  }

  private writeJson(
    response: ServerResponse,
    statusCode: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    response.writeHead(statusCode, {
      "content-type": "application/json",
      ...headers,
    });
    response.end(JSON.stringify(body));
  }

  private send(connection: RelayConnection, message: MessageEnvelope): void {
    connection.lastSeenAt = Date.now();
    const raw = JSON.stringify(message);
    this.state.recordEgress(connection, message, Buffer.byteLength(raw));
    connection.socket.sendText(raw);
  }

  private getPrimaryAgent(
    deviceId: string | undefined,
  ): RelayConnection | undefined {
    return deviceId ? this.primaryAgentByDevice.get(deviceId) : undefined;
  }

  private addAgentToDevice(
    deviceId: string,
    connection: RelayConnection,
  ): void {
    const agents =
      this.agentsByDevice.get(deviceId) ?? new Set<RelayConnection>();
    agents.add(connection);
    this.agentsByDevice.set(deviceId, agents);
    if (!this.primaryAgentByDevice.has(deviceId)) {
      this.primaryAgentByDevice.set(deviceId, connection);
    }
  }

  private updateLinkForConnection(connection: RelayConnection): void {
    if (connection.role !== "mobile" || !connection.deviceId) {
      return;
    }
    const agent = this.getPrimaryAgent(connection.deviceId);
    if (!agent) {
      return;
    }
    this.state.createOrUpdateLink({
      deviceId: connection.deviceId,
      agentConnectionId: agent.id,
      appConnectionId: connection.id,
      state:
        connection.transportPath === "p2p"
          ? "p2p"
          : connection.state === "e2e_ready"
            ? "e2e_ready"
            : connection.state === "e2e_handshaking"
              ? "e2e_handshaking"
              : "authenticated",
      transportPath: connection.transportPath,
      e2eSessionId: connection.e2eSessionId,
    });
  }

  private updateLinkForAppConnectionId(
    appConnectionId: string | undefined,
  ): void {
    if (!appConnectionId) {
      return;
    }
    const mobile = this.connections.get(appConnectionId);
    if (mobile) {
      this.updateLinkForConnection(mobile);
    }
  }

  private ensureEndpoint(
    connection: RelayConnection,
    expected: RelayEndpoint,
  ): boolean {
    if (connection.endpoint === expected) {
      return true;
    }

    connection.socket.close(
      1008,
      `wrong endpoint: use /${expected} for ${expected} connections`,
    );
    return false;
  }
}

/**
 * 构造 auth.proof 限流键：(key_id, device_id, remote_ip)。
 * 任一字段缺失时使用 "_" 占位，确保未携带身份的连接也会被限流。
 */
function buildAuthRateLimitKey(
  keyId: string | undefined,
  deviceId: string | undefined,
  remoteIp: string | undefined,
): string {
  return [keyId ?? "_", deviceId ?? "_", remoteIp ?? "_"].join("|");
}

function appInfoFromMobileConnect(payload: MobileConnectPayload): RelayAppInfo {
  return {
    instanceId: payload.app_info.instance_id,
    runtimeId: payload.app_info.runtime_id,
    device: payload.app_info.device,
    app: payload.app_info.app,
  };
}

function appInfoToPayload(appInfo: RelayAppInfo): AppInfoPayload {
  return {
    instance_id: appInfo.instanceId,
    runtime_id: appInfo.runtimeId,
    device: appInfo.device,
    app: appInfo.app,
  };
}

type RelayIpSource = NonNullable<
  NonNullable<AppConnectionObservation["network"]>["ip_source"]
>;

interface ResolvedRemoteIp {
  ip: string;
  source: Extract<RelayIpSource, "x_forwarded_for" | "socket_remote_address">;
}

/**
 * 只有在请求来自可信反代时才使用 X-Forwarded-For；否则使用底层
 * socket.remoteAddress，避免客户端直连时伪造来源 IP。
 */
export function resolveRemoteIp(
  request: IncomingMessage,
  socket: Socket,
  options: {
    trustProxy: boolean;
    trustedProxyIps: Set<string>;
  },
): ResolvedRemoteIp {
  const socketIp = normalizeIpLiteral(socket.remoteAddress ?? "unknown");
  if (
    options.trustProxy &&
    isTrustedProxyIp(socketIp, options.trustedProxyIps)
  ) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      const first = forwarded.split(",")[0]?.trim();
      if (first) {
        return { ip: normalizeIpLiteral(first), source: "x_forwarded_for" };
      }
    }
    if (Array.isArray(forwarded) && forwarded.length > 0) {
      const first = forwarded[0]?.split(",")[0]?.trim();
      if (first) {
        return { ip: normalizeIpLiteral(first), source: "x_forwarded_for" };
      }
    }
  }
  return {
    ip: socketIp,
    source: "socket_remote_address",
  };
}

function isTrustedProxyIp(ip: string, trustedProxyIps: Set<string>): boolean {
  for (const trustedIp of trustedProxyIps) {
    if (normalizeIpLiteral(trustedIp) === ip) {
      return true;
    }
  }
  return false;
}

function resolveConnectionLocation(
  remoteIp: string,
): RelayConnectionLocation | undefined {
  const geo = geoip.lookup(normalizeIpForGeoLookup(remoteIp));
  if (!geo || !Array.isArray(geo.ll) || geo.ll.length !== 2) {
    return undefined;
  }
  const [latitude, longitude] = geo.ll;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return undefined;
  }
  const countryCode = geo.country || undefined;
  const country = countryCode ? countryName(countryCode) : undefined;
  const city = geo.city || undefined;
  const region = geo.region || undefined;
  const accuracy = city ? "city" : region ? "region" : "country";
  const label = [city, region && !city ? region : undefined, country]
    .filter(Boolean)
    .join(", ");
  return {
    location_id: [
      accuracy,
      slugLocationPart(countryCode ?? "unknown"),
      slugLocationPart(region ?? "unknown"),
      slugLocationPart(city ?? "unknown"),
    ].join(":"),
    label: label || countryCode || "Unknown Internet",
    latitude,
    longitude,
    source: "geoip",
    accuracy,
    country_code: countryCode,
    country,
    region,
    city,
  };
}

function normalizeIpForGeoLookup(remoteIp: string): string {
  return normalizeIpLiteral(remoteIp);
}

function normalizeIpLiteral(remoteIp: string): string {
  const trimmed = remoteIp.trim().toLowerCase();
  return trimmed.startsWith("::ffff:")
    ? trimmed.slice("::ffff:".length)
    : trimmed;
}

function countryName(countryCode: string): string {
  try {
    return (
      new Intl.DisplayNames(["en"], { type: "region" }).of(countryCode) ??
      countryCode
    );
  } catch {
    return countryCode;
  }
}

function slugLocationPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function createRelayObservation(
  request: IncomingMessage,
  remoteIp: ResolvedRemoteIp,
): AppConnectionObservation {
  const userAgent = request.headers["user-agent"];
  const normalizedUserAgent =
    typeof userAgent === "string" ? userAgent.trim() || undefined : undefined;
  return {
    source: "relay",
    observed_at: new Date().toISOString(),
    network: {
      remote_ip: remoteIp.ip,
      ip_source: remoteIp.source,
    },
    ...(normalizedUserAgent
      ? { http: { user_agent: normalizedUserAgent } }
      : {}),
  };
}

function parseRelayEndpoint(request: IncomingMessage): RelayEndpoint | null {
  const url = new URL(request.url ?? "/", "http://relay.local");
  const pathname = normalizeRelayPathname(url.pathname);
  if (pathname === "/relay/ws/agent") {
    return "agent";
  }
  if (pathname === "/relay/ws/mobile") {
    return "mobile";
  }
  return null;
}

function normalizeRelayPathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }

  return pathname;
}

function rejectWebSocketUpgrade(
  socket: Socket,
  message: string,
  statusCode = 404,
): void {
  const statusText = statusCode === 403 ? "Forbidden" : "Not Found";
  const body = JSON.stringify({
    error: statusCode === 403 ? message : "invalid_relay_path",
    message,
  });
  socket.write(
    [
      `HTTP/1.1 ${statusCode} ${statusText}`,
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n"),
  );
  socket.destroy();
}
