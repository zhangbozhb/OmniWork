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
  type MessageEnvelope,
  type MobileConnectPayload,
  type TransportPreference,
} from "../../../packages/protocol-ts/src/index.ts";

import type { RelayServerConfig } from "./config.ts";
import { TokenBucketLimiter } from "./tokenBucket.ts";
import { RelayUpgradeOrchestrator } from "./upgrade/orchestrator.ts";
import { acceptWebSocket } from "./websocket.ts";

type RelayRole = "unknown" | "agent" | "mobile";
type RelayEndpoint = "agent" | "mobile";

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
      socket,
      authenticated: false,
      remoteIp,
    };
    this.connections.set(connection.id, connection);

    socket.onMessage((raw) => this.handleRawMessage(connection, raw));
    socket.onClose(() => this.unregister(connection));
  }

  private unregister(connection: RelayConnection): void {
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
    connection.role = "agent";
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
        // 阶段 4：通知 orchestrator 安排自动 upgrade。
        this.orchestrator.notifyMobileAuthenticated(mobile.deviceId, mobile);
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
