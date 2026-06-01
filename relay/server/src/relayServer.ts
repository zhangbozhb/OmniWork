import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

import {
  createMessage,
  isTransportPreference,
  type AgentHelloPayload,
  type AuthFailedPayload,
  type AuthOkPayload,
  type AuthProofPayload,
  type E2EFailedPayload,
  type E2EHandshakeInitPayload,
  type E2EHandshakeReplyPayload,
  type E2EMessagePayload,
  type E2EReadyPayload,
  type MessageEnvelope,
  type MobileConnectPayload,
  type ProtocolErrorPayload,
  type TransportPreference,
} from "../../../packages/protocol-ts/src/index.ts";

import type { RelayServerConfig } from "./config.ts";
import { TokenBucketLimiter } from "./tokenBucket.ts";
import { RelayUpgradeOrchestrator } from "./upgrade/orchestrator.ts";
import { acceptWebSocket } from "./websocket.ts";

type RelayRole = "unknown" | "agent" | "mobile";
type RelayEndpoint = "agent" | "mobile";
type RelayConnectionState =
  | "socket_connected"
  | "registered_agent"
  | "mobile_connected"
  | "relay_pairing_verified"
  | "e2e_handshaking"
  | "e2e_ready"
  | "closed";

interface RelaySocket {
  onMessage(handler: (message: string) => void): () => void;
  onClose(handler: () => void): () => void;
  sendText(message: string): void;
  close(code?: number, reason?: string): void;
}

interface RelayConnection {
  id: string;
  endpoint: RelayEndpoint;
  role: RelayRole;
  state: RelayConnectionState;
  socket: RelaySocket;
  deviceId?: string;
  keyId?: string;
  authenticated: boolean;
  /** Remote address used as the secondary key for auth.proof rate limiting. */
  remoteIp: string;
  /**
   * App 在 mobile.connect 中显式声明的传输偏好，由 orchestrator 在 propose
   * 守门时读取；缺省视为 "auto"。
   */
  transportPreference?: TransportPreference;
  e2eHandshakeId?: string;
  e2eTranscriptHash?: string;
  e2eSessionId?: string;
}

interface PendingAuth {
  deviceId: string;
  nonce: string;
  keyId: string;
}

export class RelayServer {
  private readonly config: RelayServerConfig;
  private readonly connections = new Map<string, RelayConnection>();
  private readonly agentsByDevice = new Map<string, RelayConnection>();
  private readonly pendingAuth = new Map<string, PendingAuth>();
  private readonly mobilesByDevice = new Map<string, Set<RelayConnection>>();
  private readonly authLimiter: TokenBucketLimiter;
  private readonly orchestrator: RelayUpgradeOrchestrator;

  constructor(config: RelayServerConfig) {
    this.config = config;
    this.authLimiter = new TokenBucketLimiter({
      capacity: config.authRateLimit.capacity,
      refillPerSecond: config.authRateLimit.refillPerSecond,
      blockMs: config.authRateLimit.blockMs,
    });
    this.orchestrator = new RelayUpgradeOrchestrator({
      config: config.upgrade,
      send: (conn, msg) => this.send(conn as RelayConnection, msg),
      getAgent: (deviceId) => this.agentsByDevice.get(deviceId),
    });
  }

  async start(): Promise<void> {
    const server = createServer((request, response) =>
      this.handleHttp(request, response),
    );
    server.on("upgrade", (request, socket) => {
      const endpoint = parseRelayEndpoint(request);
      const remoteIp = resolveRemoteIp(request, socket as Socket);
      if (endpoint !== "agent" && endpoint !== "mobile") {
        rejectWebSocketUpgrade(
          socket as Socket,
          "Use /agent or /mobile for OmniWork connections.",
        );
        return;
      }

      const connection = acceptWebSocket(request, socket as Socket);
      if (connection) {
        this.register(connection, endpoint, remoteIp);
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(this.config.port, this.config.host, resolve);
    });

    console.log(
      `[omniwork-relay] listening on ${this.config.host}:${this.config.port}`,
    );
  }

  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    if (request.url === "/healthz" || request.url === "/readyz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (request.url === "/metrics") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(this.orchestrator.getMetrics()));
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

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  }

  private handleDebugUpgrade(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    if (this.config.requireE2E) {
      response.writeHead(409, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "p2p_debug_disabled_until_e2e" }));
      return;
    }

    const url = new URL(request.url ?? "/", "http://relay.local");
    const deviceId = url.searchParams.get("device_id");
    if (!deviceId) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "missing_device_id" }));
      return;
    }

    const agent = this.agentsByDevice.get(deviceId);
    const mobiles = this.mobilesByDevice.get(deviceId);
    const firstMobile = mobiles ? mobiles.values().next().value : undefined;
    if (!agent || !firstMobile) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "device_not_online" }));
      return;
    }

    const upgradeId = this.orchestrator.triggerUpgrade(
      deviceId,
      firstMobile,
      agent,
    );

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
    remoteIp = "unknown",
  ): void {
    const connection: RelayConnection = {
      id: `conn_${randomUUID()}`,
      endpoint,
      role: "unknown",
      state: "socket_connected",
      socket,
      authenticated: false,
      remoteIp,
    };
    this.connections.set(connection.id, connection);

    socket.onMessage((raw) => this.handleRawMessage(connection, raw));
    socket.onClose(() => this.unregister(connection));
  }

  private unregister(connection: RelayConnection): void {
    connection.state = "closed";
    this.connections.delete(connection.id);
    this.pendingAuth.delete(connection.id);
    if (connection.role === "agent" && connection.deviceId) {
      const current = this.agentsByDevice.get(connection.deviceId);
      if (current === connection) {
        this.agentsByDevice.delete(connection.deviceId);
      }
      this.orchestrator.notifyAgentDisconnected(connection.deviceId);
    }
    if (connection.role === "mobile" && connection.deviceId) {
      this.mobilesByDevice.get(connection.deviceId)?.delete(connection);
      this.orchestrator.notifyMobileDisconnected(
        connection.deviceId,
        connection,
      );
    }
  }

  private handleRawMessage(connection: RelayConnection, raw: string): void {
    let message: MessageEnvelope;
    try {
      message = JSON.parse(raw) as MessageEnvelope;
    } catch {
      connection.socket.close(1003, "invalid json");
      return;
    }

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
      case "e2e.handshake.init":
        this.handleE2EHandshakeInit(
          connection,
          message as MessageEnvelope<E2EHandshakeInitPayload>,
        );
        break;
      case "e2e.handshake.reply":
        this.handleE2EHandshakeReply(
          connection,
          message as MessageEnvelope<E2EHandshakeReplyPayload>,
        );
        break;
      case "e2e.ready":
        this.handleE2EReady(
          connection,
          message as MessageEnvelope<E2EReadyPayload>,
        );
        break;
      case "e2e.message":
        this.handleE2EMessage(
          connection,
          message as MessageEnvelope<E2EMessagePayload>,
        );
        break;
      case "e2e.failed":
        this.handleE2EFailed(
          connection,
          message as MessageEnvelope<E2EFailedPayload>,
        );
        break;
      case "e2e.rekey.init":
      case "e2e.rekey.reply":
      case "e2e.rekey.ready":
      case "e2e.close":
        this.routeE2EControl(connection, message);
        break;
      case "tunnel.upgrade.propose":
      case "tunnel.upgrade.offer":
      case "tunnel.upgrade.answer":
      case "tunnel.upgrade.candidate":
      case "tunnel.upgrade.committed":
      case "tunnel.upgrade.downgrade":
        if (this.config.requireE2E) {
          this.rejectPlaintextBusiness(connection, message.type);
          return;
        }
        if (!this.isE2EPairReady(connection)) {
          this.rejectInvalidState(connection, message.type);
          return;
        }
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
          this.orchestrator.handleControlMessage(message);
        }
        this.routeMessage(connection, message);
        break;
      default:
        if (isPlaintextBusinessMessage(message.type)) {
          this.rejectPlaintextBusiness(connection, message.type);
          return;
        }
        this.routeMessage(connection, message);
        break;
    }
  }

  private handleAgentHello(
    connection: RelayConnection,
    message: MessageEnvelope<AgentHelloPayload>,
  ): void {
    connection.role = "agent";
    connection.state = "registered_agent";
    connection.deviceId = message.payload.device_id;
    connection.keyId = message.payload.key_id;
    connection.authenticated = true;
    this.agentsByDevice.set(message.payload.device_id, connection);
  }

  private handleMobileConnect(
    connection: RelayConnection,
    message: MessageEnvelope<MobileConnectPayload>,
  ): void {
    const deviceId = message.payload.device_id;
    const agent = this.agentsByDevice.get(deviceId);
    connection.role = "mobile";
    connection.state = "mobile_connected";
    connection.deviceId = deviceId;

    const rawPreference = message.payload.transport_preference;
    if (isTransportPreference(rawPreference)) {
      connection.transportPreference = rawPreference;
    }

    if (!agent?.keyId) {
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
      console.warn("[omniwork-relay] auth rate limit hit", {
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
      connection.socket.close(1008, "auth rate limit");
      return;
    }

    if (
      !pending ||
      message.payload.nonce !== pending.nonce ||
      message.payload.key_id !== pending.keyId
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
      return;
    }

    const agent = this.agentsByDevice.get(pending.deviceId);
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
      return;
    }

    this.send(
      agent,
      createMessage(
        "auth.verify",
        {
          key_id: message.payload.key_id,
          nonce: message.payload.nonce,
          proof: message.payload.proof,
          connection_id: connection.id,
        },
        { device_id: pending.deviceId },
      ),
    );
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
      mobile.authenticated = true;
      mobile.state = "relay_pairing_verified";
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
      }
    } else if (message.type === "auth.failed") {
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
    if (this.config.requireE2E && isPlaintextBusinessMessage(message.type)) {
      this.rejectPlaintextBusiness(connection, message.type);
      return;
    }

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

      const agent = this.agentsByDevice.get(connection.deviceId);
      if (agent) {
        this.send(agent, message);
      }
      return;
    }

    if (connection.role === "agent" && connection.deviceId) {
      const mobiles = this.mobilesByDevice.get(connection.deviceId);
      if (!mobiles) {
        return;
      }
      for (const mobile of mobiles) {
        this.send(mobile, message);
      }
    }
  }

  private handleE2EHandshakeInit(
    connection: RelayConnection,
    message: MessageEnvelope<E2EHandshakeInitPayload>,
  ): void {
    if (connection.role !== "mobile") {
      this.rejectInvalidState(connection, "e2e.handshake.init");
      return;
    }
    if (
      !connection.authenticated ||
      connection.state !== "relay_pairing_verified"
    ) {
      this.rejectInvalidState(connection, "e2e.handshake.init");
      return;
    }
    connection.e2eHandshakeId = message.payload.handshake_id;
    connection.e2eTranscriptHash = undefined;
    connection.e2eSessionId = undefined;
    connection.state = "e2e_handshaking";
    this.routeMessage(connection, message);
  }

  private handleE2EHandshakeReply(
    connection: RelayConnection,
    message: MessageEnvelope<E2EHandshakeReplyPayload>,
  ): void {
    if (connection.role !== "agent") {
      this.rejectInvalidState(connection, "e2e.handshake.reply");
      return;
    }
    connection.e2eHandshakeId = message.payload.handshake_id;
    connection.e2eTranscriptHash = undefined;
    connection.e2eSessionId = undefined;
    connection.state = "e2e_handshaking";
    this.routeMessage(connection, message);
  }

  private handleE2EReady(
    connection: RelayConnection,
    message: MessageEnvelope<E2EReadyPayload>,
  ): void {
    if (connection.state !== "e2e_handshaking") {
      this.rejectInvalidState(connection, "e2e.ready");
      return;
    }
    if (
      connection.e2eHandshakeId &&
      message.payload.handshake_id !== connection.e2eHandshakeId
    ) {
      this.rejectInvalidState(connection, "e2e.ready");
      return;
    }
    connection.e2eHandshakeId = message.payload.handshake_id;
    connection.e2eTranscriptHash = message.payload.transcript_hash;
    connection.state = "e2e_ready";
    // P2P 数据路径尚未完成统一 E2E 包装。安全优先：在 tunnel.upgrade.*
    // 控制面纳入 E2E 之前，不自动触发 P2P propose，避免业务消息绕过
    // App/Agent 的 e2e.message 加解密门禁。
    this.routeMessage(connection, message);
  }

  private handleE2EMessage(
    connection: RelayConnection,
    message: MessageEnvelope<E2EMessagePayload>,
  ): void {
    if (connection.state !== "e2e_ready") {
      this.rejectInvalidState(connection, "e2e.message");
      return;
    }
    if (!this.isE2EPairReady(connection)) {
      this.rejectInvalidState(connection, "e2e.message");
      return;
    }
    if (
      connection.e2eSessionId &&
      connection.e2eSessionId !== message.payload.e2e_session_id
    ) {
      this.rejectInvalidState(connection, "e2e.message");
      return;
    }
    connection.e2eSessionId = message.payload.e2e_session_id;
    this.routeMessage(connection, message);
  }

  private handleE2EFailed(
    connection: RelayConnection,
    message: MessageEnvelope<E2EFailedPayload>,
  ): void {
    connection.state = connection.authenticated
      ? "relay_pairing_verified"
      : connection.state;
    connection.e2eHandshakeId = undefined;
    connection.e2eTranscriptHash = undefined;
    connection.e2eSessionId = undefined;
    this.routeMessage(connection, message);
  }

  private routeE2EControl(
    connection: RelayConnection,
    message: MessageEnvelope,
  ): void {
    if (connection.state !== "e2e_ready") {
      this.rejectInvalidState(connection, message.type);
      return;
    }
    if (!this.isE2EPairReady(connection)) {
      this.rejectInvalidState(connection, message.type);
      return;
    }
    this.routeMessage(connection, message);
  }

  private isE2EPairReady(connection: RelayConnection): boolean {
    if (!connection.deviceId || connection.state !== "e2e_ready") {
      return false;
    }
    if (connection.role === "mobile") {
      const agent = this.agentsByDevice.get(connection.deviceId);
      return isMatchingE2EPeer(connection, agent);
    }
    if (connection.role === "agent") {
      const mobiles = this.mobilesByDevice.get(connection.deviceId);
      if (!mobiles) {
        return false;
      }
      for (const mobile of mobiles) {
        if (isMatchingE2EPeer(connection, mobile)) {
          return true;
        }
      }
    }
    return false;
  }

  private rejectPlaintextBusiness(
    connection: RelayConnection,
    type: string,
  ): void {
    this.sendProtocolError(
      connection,
      "plaintext_business_rejected",
      `Message type "${type}" must be sent inside e2e.message.`,
      false,
    );
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

  private send(connection: RelayConnection, message: MessageEnvelope): void {
    connection.socket.sendText(JSON.stringify(message));
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

function isMatchingE2EPeer(
  connection: RelayConnection,
  peer: RelayConnection | undefined,
): boolean {
  return (
    peer?.state === "e2e_ready" &&
    !!connection.e2eHandshakeId &&
    connection.e2eHandshakeId === peer.e2eHandshakeId &&
    !!connection.e2eTranscriptHash &&
    connection.e2eTranscriptHash === peer.e2eTranscriptHash
  );
}

function isPlaintextBusinessMessage(type: string): boolean {
  return (
    type.startsWith("session.") ||
    type.startsWith("terminal.") ||
    type.startsWith("workspace.") ||
    type.startsWith("files.") ||
    type.startsWith("git.") ||
    type.startsWith("codex.") ||
    type.startsWith("tunnel.upgrade.")
  );
}

/**
 * 优先从 X-Forwarded-For 获取真实客户端 IP（在前置 reverse proxy / TLS 终端时），
 * 退化到底层 socket.remoteAddress；空值返回 "unknown" 以保证限流键稳定。
 */
function resolveRemoteIp(request: IncomingMessage, socket: Socket): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    const first = forwarded[0]?.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  return socket.remoteAddress ?? "unknown";
}

function parseRelayEndpoint(request: IncomingMessage): RelayEndpoint | null {
  const url = new URL(request.url ?? "/", "http://relay.local");
  const pathname = normalizeRelayPathname(url.pathname);
  if (pathname === "/agent") {
    return "agent";
  }
  if (pathname === "/mobile") {
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

function rejectWebSocketUpgrade(socket: Socket, message: string): void {
  const body = JSON.stringify({ error: "invalid_relay_path", message });
  socket.write(
    [
      "HTTP/1.1 404 Not Found",
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n"),
  );
  socket.destroy();
}

/**
 * 升级控制面统一结构化日志：所有字段以 JSON 输出，便于 stdout 采集。
 * 关键字段固定为 event/upgrade_id/device_id/reason，方便日志检索。
 */
interface UpgradeLogFields {
  event: string;
  upgrade_id?: string;
  device_id?: string;
  reason?: string;
  source_role?: string;
}

function logUpgradeEvent(fields: UpgradeLogFields): void {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    component: "omniwork-relay",
    event: fields.event,
  };
  if (fields.upgrade_id) record.upgrade_id = fields.upgrade_id;
  if (fields.device_id) record.device_id = fields.device_id;
  if (fields.reason) record.reason = fields.reason;
  if (fields.source_role) record.source_role = fields.source_role;
  console.info(JSON.stringify(record));
}
