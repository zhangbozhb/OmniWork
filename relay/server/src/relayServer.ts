import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

import {
  createMessage,
  type AgentHelloPayload,
  type AuthFailedPayload,
  type AuthOkPayload,
  type AuthProofPayload,
  type MessageEnvelope,
  type MobileConnectPayload,
  type TunnelIceCandidatePayload,
  type TunnelMobileJoinPayload,
  type TunnelRelayRegisterPayload,
  type TunnelSessionDescriptionPayload,
  type TunnelSessionFailedPayload,
  type TunnelSessionReadyPayload,
} from "../../../packages/protocol-ts/src/index.ts";
import type {
  WebRtcDataChannelLike,
  WebRtcPeerConnectionFactory,
  WebRtcPeerConnectionLike,
} from "../../../packages/relay-client/src/webrtcTransport.ts";
import { candidateToInit } from "../../../packages/relay-client/src/webrtcTransport.ts";
import {
  RelayClient,
  type RelayCloseEvent,
} from "../../../packages/relay-client/src/index.ts";

import type { RelayServerConfig } from "./config.ts";
import { DataChannelSocket } from "./dataChannelSocket.ts";
import { TokenBucketLimiter } from "./tokenBucket.ts";
import { acceptWebSocket, WebSocketConnection } from "./websocket.ts";
import { createDefaultPeerConnectionFactory } from "./webrtcFactory.ts";

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
}

interface TunnelSession {
  id: string;
  deviceId: string;
  signal: TunnelSignal;
  peer: WebRtcPeerConnectionLike;
  dataSocket?: DataChannelSocket;
}

interface TunnelSignal {
  sendText(message: string): void;
  close(code?: number, reason?: string): void;
}

interface PendingAuth {
  deviceId: string;
  nonce: string;
  keyId: string;
}

export class RelayServer {
  private readonly config: RelayServerConfig;
  private readonly peerConnectionFactory: WebRtcPeerConnectionFactory | null;
  private readonly connections = new Map<string, RelayConnection>();
  private readonly agentsByDevice = new Map<string, RelayConnection>();
  private readonly pendingAuth = new Map<string, PendingAuth>();
  private readonly mobilesByDevice = new Map<string, Set<RelayConnection>>();
  private readonly tunnelSessions = new Map<string, TunnelSession>();
  private readonly authLimiter: TokenBucketLimiter;
  private publicTunnelClient: RelayClient | null = null;
  private publicTunnelReconnectTimer: ReturnType<typeof setTimeout> | null =
    null;

  constructor(config: RelayServerConfig) {
    this.config = config;
    this.peerConnectionFactory = createDefaultPeerConnectionFactory(
      config.webrtc.iceServers,
    );
    this.authLimiter = new TokenBucketLimiter({
      capacity: config.authRateLimit.capacity,
      refillPerSecond: config.authRateLimit.refillPerSecond,
      blockMs: config.authRateLimit.blockMs,
    });
  }

  async start(): Promise<void> {
    const server = createServer((request, response) =>
      this.handleHttp(request, response),
    );
    server.on("upgrade", (request, socket) => {
      const endpoint = parseRelayUpgradeEndpoint(request);
      const remoteIp = resolveRemoteIp(request, socket as Socket);
      if (endpoint === "tunnel-mobile") {
        const connection = acceptWebSocket(request, socket as Socket);
        if (connection) {
          this.registerTunnelMobile(connection);
        }
        return;
      }

      if (endpoint !== "agent" && endpoint !== "mobile") {
        rejectWebSocketUpgrade(
          socket as Socket,
          "Use /agent, /mobile, or /tunnel/mobile for OmniWork connections.",
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

    this.connectPublicTunnelService();
  }

  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    if (request.url === "/healthz" || request.url === "/readyz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
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

  private registerTunnelMobile(signal: WebSocketConnection): void {
    signal.onMessage((raw) => {
      this.handleTunnelSignal(signal, raw).catch((error: unknown) => {
        this.sendTunnelFailure(signal, {
          reason: "internal_error",
          message: error instanceof Error ? error.message : "unknown error",
        });
      });
    });
    signal.onClose(() => {
      this.closeTunnelSessionsBySignal(signal);
    });
  }

  private connectPublicTunnelService(): void {
    const tunnelRelayUrl = this.config.tunnelService?.relayUrl;
    if (!tunnelRelayUrl || this.publicTunnelClient) {
      return;
    }

    const client = new RelayClient({ url: tunnelRelayUrl });
    this.publicTunnelClient = client;
    const signal = new RelayClientTunnelSignal(client);

    client.onMessage((message) => {
      this.handleTunnelMessage(signal, message).catch((error: unknown) => {
        signal.sendText(
          JSON.stringify(
            createMessage<TunnelSessionFailedPayload>("tunnel.session.failed", {
              reason: "internal_error",
              message: error instanceof Error ? error.message : "unknown error",
            }),
          ),
        );
      });
    });
    client.onClose((event) =>
      this.handlePublicTunnelClose(client, signal, event),
    );

    client
      .connect()
      .then(() => {
        for (const deviceId of this.agentsByDevice.keys()) {
          client.send(createTunnelRelayRegisterMessage(deviceId));
        }
        console.log("[omniwork-relay] connected to tunnel service", {
          tunnel_relay_url: tunnelRelayUrl,
        });
      })
      .catch((error: unknown) => {
        if (this.publicTunnelClient === client) {
          this.publicTunnelClient = null;
        }
        console.error("[omniwork-relay] tunnel service connection failed", {
          tunnel_relay_url: tunnelRelayUrl,
          error: String(error),
        });
        this.schedulePublicTunnelReconnect();
      });
  }

  private handlePublicTunnelClose(
    client: RelayClient,
    signal: TunnelSignal,
    event: RelayCloseEvent,
  ): void {
    if (this.publicTunnelClient === client) {
      this.publicTunnelClient = null;
    }
    this.closeTunnelSessionsBySignal(signal);
    console.warn("[omniwork-relay] tunnel service connection closed", {
      code: event.code,
      reason: event.reason,
    });
    this.schedulePublicTunnelReconnect();
  }

  private schedulePublicTunnelReconnect(): void {
    if (
      !this.config.tunnelService?.relayUrl ||
      this.publicTunnelReconnectTimer
    ) {
      return;
    }

    this.publicTunnelReconnectTimer = setTimeout(() => {
      this.publicTunnelReconnectTimer = null;
      this.connectPublicTunnelService();
    }, 2000);
  }

  private unregister(connection: RelayConnection): void {
    this.connections.delete(connection.id);
    this.pendingAuth.delete(connection.id);
    if (connection.role === "agent" && connection.deviceId) {
      const current = this.agentsByDevice.get(connection.deviceId);
      if (current === connection) {
        this.agentsByDevice.delete(connection.deviceId);
      }
    }
    if (connection.role === "mobile" && connection.deviceId) {
      this.mobilesByDevice.get(connection.deviceId)?.delete(connection);
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
    this.registerDeviceWithPublicTunnel(message.payload.device_id);
  }

  private registerDeviceWithPublicTunnel(deviceId: string): void {
    try {
      this.publicTunnelClient?.send(createTunnelRelayRegisterMessage(deviceId));
    } catch {
      // The public tunnel connector is optional; local Relay mode must continue.
    }
  }

  private handleMobileConnect(
    connection: RelayConnection,
    message: MessageEnvelope<MobileConnectPayload>,
  ): void {
    const deviceId = message.payload.device_id;
    const agent = this.agentsByDevice.get(deviceId);
    connection.role = "mobile";
    connection.deviceId = deviceId;

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

    if (!this.authLimiter.consume(limiterKey)) {
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
      }
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

  private async handleTunnelSignal(
    signal: TunnelSignal,
    raw: string,
  ): Promise<void> {
    let message: MessageEnvelope;
    try {
      message = JSON.parse(raw) as MessageEnvelope;
    } catch {
      this.sendTunnelFailure(signal, {
        reason: "invalid_signal",
        message: "invalid json",
      });
      return;
    }

    await this.handleTunnelMessage(signal, message);
  }

  private async handleTunnelMessage(
    signal: TunnelSignal,
    message: MessageEnvelope,
  ): Promise<void> {
    switch (message.type) {
      case "tunnel.mobile.join":
        await this.handleTunnelMobileJoin(
          signal,
          message as MessageEnvelope<TunnelMobileJoinPayload>,
        );
        break;
      case "tunnel.session.answer":
        await this.handleTunnelAnswer(
          message as MessageEnvelope<TunnelSessionDescriptionPayload>,
        );
        break;
      case "tunnel.session.candidate":
        await this.handleTunnelCandidate(
          message as MessageEnvelope<TunnelIceCandidatePayload>,
        );
        break;
      case "tunnel.session.close":
        this.closeTunnelSession(message.session_id, "mobile closed");
        break;
      default:
        this.sendTunnelFailure(signal, {
          reason: "invalid_signal",
          message: `unsupported tunnel message: ${message.type}`,
        });
        break;
    }
  }

  private async handleTunnelMobileJoin(
    signal: TunnelSignal,
    message: MessageEnvelope<TunnelMobileJoinPayload>,
  ): Promise<void> {
    const deviceId = message.payload.device_id;
    if (!this.agentsByDevice.has(deviceId)) {
      this.sendTunnelFailure(signal, {
        device_id: deviceId,
        reason: "agent_not_online",
        retry_after_ms: 2000,
      });
      return;
    }

    const peer = this.peerConnectionFactory?.();
    if (!peer?.createDataChannel || !peer.createOffer) {
      this.sendTunnelFailure(signal, {
        device_id: deviceId,
        reason: "webrtc_unavailable",
        message:
          "RTCPeerConnection is not available in this Relay runtime. Provide a WebRTC runtime before enabling /tunnel/mobile.",
      });
      return;
    }

    const sessionId = message.session_id ?? `tun_${randomUUID()}`;
    const session: TunnelSession = {
      id: sessionId,
      deviceId,
      signal,
      peer,
    };
    this.tunnelSessions.set(sessionId, session);

    peer.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }
      const candidate = candidateToInit(event.candidate);
      this.sendTunnelSignal(
        signal,
        createMessage<TunnelIceCandidatePayload>(
          "tunnel.session.candidate",
          {
            session_id: sessionId,
            device_id: deviceId,
            candidate: candidate.candidate,
            sdp_mid: candidate.sdpMid,
            sdp_m_line_index: candidate.sdpMLineIndex,
          },
          { device_id: deviceId, session_id: sessionId },
        ),
      );
    };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed") {
        this.sendTunnelFailure(signal, {
          session_id: sessionId,
          device_id: deviceId,
          reason: "ice_failed",
        });
      }
    };

    this.attachTunnelDataChannel(
      session,
      peer.createDataChannel("omniwork.envelope"),
    );

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const local = peer.localDescription ?? offer;

    this.sendTunnelSignal(
      signal,
      createMessage<TunnelSessionDescriptionPayload>(
        "tunnel.session.offer",
        {
          session_id: sessionId,
          device_id: deviceId,
          sdp: local.sdp ?? "",
          sdp_type: "offer",
        },
        { device_id: deviceId, session_id: sessionId },
      ),
    );
  }

  private async handleTunnelAnswer(
    message: MessageEnvelope<TunnelSessionDescriptionPayload>,
  ): Promise<void> {
    const session = this.tunnelSessions.get(message.payload.session_id);
    if (!session) {
      return;
    }

    await session.peer.setRemoteDescription({
      type: "answer",
      sdp: message.payload.sdp,
    });
  }

  private async handleTunnelCandidate(
    message: MessageEnvelope<TunnelIceCandidatePayload>,
  ): Promise<void> {
    const session = this.tunnelSessions.get(message.payload.session_id);
    if (!session) {
      return;
    }

    await session.peer.addIceCandidate({
      candidate: message.payload.candidate,
      sdpMid: message.payload.sdp_mid,
      sdpMLineIndex: message.payload.sdp_m_line_index,
    });
  }

  private attachTunnelDataChannel(
    session: TunnelSession,
    channel: WebRtcDataChannelLike,
  ): void {
    const registerMobile = () => {
      if (session.dataSocket) {
        return;
      }

      const socket = new DataChannelSocket(channel);
      session.dataSocket = socket;
      this.register(socket, "mobile");
      this.sendTunnelSignal(
        session.signal,
        createMessage<TunnelSessionReadyPayload>(
          "tunnel.session.ready",
          {
            session_id: session.id,
            device_id: session.deviceId,
            transport: "webrtc",
          },
          { device_id: session.deviceId, session_id: session.id },
        ),
      );
    };

    if (channel.readyState === "open") {
      registerMobile();
      return;
    }

    channel.onopen = registerMobile;
  }

  private closeTunnelSessionsBySignal(signal: TunnelSignal): void {
    for (const session of this.tunnelSessions.values()) {
      if (session.signal === signal) {
        this.closeTunnelSession(session.id, "signaling closed");
      }
    }
  }

  private closeTunnelSession(
    sessionId: string | undefined,
    reason: string,
  ): void {
    if (!sessionId) {
      return;
    }

    const session = this.tunnelSessions.get(sessionId);
    if (!session) {
      return;
    }

    session.dataSocket?.close();
    session.peer.close();
    this.tunnelSessions.delete(sessionId);
    this.sendTunnelFailure(session.signal, {
      session_id: sessionId,
      device_id: session.deviceId,
      reason: "session_not_found",
      message: reason,
    });
  }

  private sendTunnelFailure(
    signal: TunnelSignal,
    payload: TunnelSessionFailedPayload,
  ): void {
    this.sendTunnelSignal(
      signal,
      createMessage<TunnelSessionFailedPayload>(
        "tunnel.session.failed",
        payload,
        { device_id: payload.device_id, session_id: payload.session_id },
      ),
    );
  }

  private sendTunnelSignal(
    signal: TunnelSignal,
    message: MessageEnvelope,
  ): void {
    signal.sendText(JSON.stringify(message));
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

class RelayClientTunnelSignal implements TunnelSignal {
  private readonly client: RelayClient;

  constructor(client: RelayClient) {
    this.client = client;
  }

  sendText(message: string): void {
    this.client.send(JSON.parse(message) as MessageEnvelope);
  }

  close(code?: number, reason?: string): void {
    this.client.close(code, reason);
  }
}

function createTunnelRelayRegisterMessage(
  deviceId: string,
): MessageEnvelope<TunnelRelayRegisterPayload> {
  return createMessage<TunnelRelayRegisterPayload>(
    "tunnel.relay.register",
    {
      device_id: deviceId,
      key_id: deviceId,
      transport: "webrtc",
    },
    { device_id: deviceId },
  );
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

type RelayUpgradeEndpoint = RelayEndpoint | "tunnel-mobile";

function parseRelayUpgradeEndpoint(
  request: IncomingMessage,
): RelayUpgradeEndpoint | null {
  const url = new URL(request.url ?? "/", "http://relay.local");
  const pathname = normalizeRelayPathname(url.pathname);
  if (pathname === "/agent") {
    return "agent";
  }
  if (pathname === "/mobile") {
    return "mobile";
  }
  if (pathname === "/tunnel/mobile") {
    return "tunnel-mobile";
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
