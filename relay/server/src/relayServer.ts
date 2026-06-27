import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

import {
  createMessage,
  parseMessageEnvelope,
  type AgentHelloPayload,
  type AppNetworkChangedPayload,
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
import { createMailSender } from "./mailSender.ts";
import { RelayAdminController } from "./relayAdminController.ts";
import { RelayAgentSessionController } from "./relayAgentSessionController.ts";
import { RelayConnectionRegistry } from "./relayConnectionRegistry.ts";
import { RelayDeviceStatusStore } from "./relayDeviceStatusStore.ts";
import { RelayE2EController } from "./relayE2EController.ts";
import { RelayLifecycleController } from "./relayLifecycleController.ts";
import { logRelayEvent, logUpgradeEvent } from "./relayLog.ts";
import { RelayMessageRouter } from "./relayMessageRouter.ts";
import { RelayMobileSessionController } from "./relayMobileSessionController.ts";
import { RelayPairingController } from "./relayPairingController.ts";
import {
  createRelayObservation,
  parseRelayEndpoint,
  rejectWebSocketUpgrade,
  relayAdminWebUrl,
  resolveConnectionLocation,
  resolveRemoteIp,
} from "./relayNetworkIdentity.ts";
import { RelayStateStore } from "./relayStateStore.ts";
import { RelayUserAuthController } from "./relayUserAuthController.ts";
import { RelayUserAuthStore } from "./relayUserAuthStore.ts";
import { TokenBucketLimiter } from "./tokenBucket.ts";
import { RelayUpgradeOrchestrator } from "./upgrade/orchestrator.ts";
import { acceptWebSocket } from "./websocket.ts";
import type {
  PendingAuth,
  RelayConnection,
  RelayEndpoint,
} from "./relayTypes.ts";

export { resolveRemoteIp } from "./relayNetworkIdentity.ts";

export class RelayServer {
  private readonly config: RelayServerConfig;
  private readonly registry: RelayConnectionRegistry;
  readonly connections: Map<string, RelayConnection>;
  readonly agentsByDevice: Map<string, Set<RelayConnection>>;
  readonly primaryAgentByDevice: Map<string, RelayConnection>;
  private readonly pendingAuth = new Map<string, PendingAuth>();
  readonly mobilesByDevice: Map<string, Set<RelayConnection>>;
  private readonly state: RelayStateStore;
  private readonly userAuthStore: RelayUserAuthStore;
  private readonly userAuth: RelayUserAuthController;
  private readonly admin: RelayAdminController;
  private readonly agentSessions: RelayAgentSessionController;
  private readonly mobileSessions: RelayMobileSessionController;
  private readonly pairing: RelayPairingController;
  private readonly router: RelayMessageRouter;
  private readonly lifecycle: RelayLifecycleController;
  private readonly e2e: RelayE2EController;
  private readonly authLimiter: TokenBucketLimiter;
  private readonly orchestrator: RelayUpgradeOrchestrator;

  constructor(config: RelayServerConfig) {
    this.config = config;
    this.state = new RelayStateStore({
      deviceStatusStore: new RelayDeviceStatusStore(
        config.state.deviceStatusDbPath,
      ),
    });
    this.registry = new RelayConnectionRegistry({
      state: this.state,
      pendingAuth: this.pendingAuth,
      onRawMessage: (connection, raw) => this.handleRawMessage(connection, raw),
      onAgentDisconnected: (deviceId) =>
        this.orchestrator.notifyAgentDisconnected(deviceId),
      onMobileDisconnected: (deviceId, connection) =>
        this.orchestrator.notifyMobileDisconnected(deviceId, connection),
    });
    this.connections = this.registry.connections;
    this.agentsByDevice = this.registry.agentsByDevice;
    this.primaryAgentByDevice = this.registry.primaryAgentByDevice;
    this.mobilesByDevice = this.registry.mobilesByDevice;
    this.userAuthStore = new RelayUserAuthStore(config.auth.dbPath);
    this.userAuth = new RelayUserAuthController({
      config,
      store: this.userAuthStore,
      mail: createMailSender(config),
      resolveRemoteIp: (request) =>
        resolveRemoteIp(request, request.socket as Socket, {
          trustProxy: this.config.admin.trustProxy,
          trustedProxyIps: this.config.admin.trustedProxyIps,
        }).ip,
      revokeActiveDevice: (deviceId) =>
        this.registry.closeDeviceConnections(deviceId),
    });
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
      unregister: (connection) => this.registry.unregister(connection),
    });
    this.router = new RelayMessageRouter({
      config,
      registry: this.registry,
      state: this.state,
      send: (connection, message) => this.send(connection, message),
    });
    this.e2e = new RelayE2EController({
      protocolVersion: config.protocolVersion,
      connections: this.connections,
      agentsByDevice: this.primaryAgentByDevice,
      send: (connection, message) => this.send(connection, message),
      routeMessage: (connection, message) =>
        this.router.routeMessage(connection, message),
      notifyMobileAuthenticated: (deviceId, mobile) =>
        this.orchestrator.notifyMobileAuthenticated(deviceId, mobile),
    });
    this.orchestrator = new RelayUpgradeOrchestrator({
      config: config.upgrade,
      send: (conn, msg) => this.send(conn as RelayConnection, msg),
      getAgent: (deviceId) => this.primaryAgentByDevice.get(deviceId),
    });
    this.agentSessions = new RelayAgentSessionController({
      config,
      admin: this.admin,
      registry: this.registry,
      state: this.state,
      userAuthStore: this.userAuthStore,
    });
    this.mobileSessions = new RelayMobileSessionController({
      config,
      registry: this.registry,
      state: this.state,
      userAuth: this.userAuth,
      userAuthStore: this.userAuthStore,
      pendingAuth: this.pendingAuth,
      send: (connection, message) => this.send(connection, message),
    });
    this.pairing = new RelayPairingController({
      config,
      registry: this.registry,
      state: this.state,
      pendingAuth: this.pendingAuth,
      authLimiter: this.authLimiter,
      orchestrator: this.orchestrator,
      send: (connection, message) => this.send(connection, message),
    });
    this.lifecycle = new RelayLifecycleController({
      config,
      registry: this.registry,
      state: this.state,
      userAuthStore: this.userAuthStore,
      pendingAuth: this.pendingAuth,
      router: this.router,
      send: (connection, message) => this.send(connection, message),
    });
  }

  async start(): Promise<void> {
    const startupToken = this.admin.start();
    this.lifecycle.start();
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
        const user =
          endpoint === "mobile" && this.config.auth.mode === "email_link"
            ? this.userAuth.authenticateRequest(request)
            : null;
        this.registry.register(connection, endpoint, {
          remoteIp: remoteIp.ip,
          location: resolveConnectionLocation(remoteIp.ip),
          observations: [createRelayObservation(request, remoteIp)],
          userId: user?.id,
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
    if (this.config.admin.webEnabled) {
      logRelayEvent({
        event: "admin.web.ready",
        url: relayAdminWebUrl(this.config.admin.host, this.config.admin.port),
        https_required: this.config.admin.requireHttps,
      });
    }
  }

  private handleBusinessHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const url = new URL(request.url ?? "/", "http://relay.local");
    if (this.userAuth.matches(url.pathname)) {
      this.userAuth.handle(request, response, url).catch((error: unknown) => {
        this.writeJson(response, 500, {
          error: "internal_error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }

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

  private closeDeviceConnections(deviceId: string): void {
    this.registry.closeDeviceConnections(deviceId);
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
    this.agentSessions.handleAgentHello(connection, message);
  }

  private handleMobileConnect(
    connection: RelayConnection,
    message: MessageEnvelope<MobileConnectPayload>,
  ): void {
    this.mobileSessions.handleMobileConnect(connection, message);
  }

  private handleAuthProof(
    connection: RelayConnection,
    message: MessageEnvelope<AuthProofPayload>,
  ): void {
    this.pairing.handleAuthProof(connection, message);
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
    this.pairing.handleAuthResult(connection, message);
  }

  private routeMessage(
    connection: RelayConnection,
    message: MessageEnvelope,
  ): void {
    this.router.routeMessage(connection, message);
  }

  private handleRelayAppDeliver(
    connection: RelayConnection,
    message: MessageEnvelope<RelayAppDeliverPayload>,
  ): void {
    this.router.handleRelayAppDeliver(connection, message);
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
    return this.registry.getPrimaryAgent(deviceId);
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
