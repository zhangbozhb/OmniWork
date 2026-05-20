import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

import {
  createMessage,
  type MessageEnvelope,
  type TunnelMobileJoinPayload,
  type TunnelRelayRegisterPayload,
  type TunnelSessionFailedPayload,
} from "../../../packages/protocol-ts/src/index.ts";
import {
  acceptWebSocket,
  WebSocketConnection,
} from "../../server/src/websocket.ts";
import type { TunnelServiceConfig } from "./config.ts";

type TunnelEndpoint = "relay" | "mobile";

interface RelayRegistration {
  deviceId: string;
  socket: WebSocketConnection;
}

interface TunnelSession {
  id: string;
  deviceId: string;
  mobile: WebSocketConnection;
  relay: WebSocketConnection;
}

export class TunnelService {
  private readonly config: TunnelServiceConfig;
  private readonly relaysByDevice = new Map<string, RelayRegistration>();
  private readonly sessionsById = new Map<string, TunnelSession>();
  private readonly sessionsByMobile = new Map<
    WebSocketConnection,
    Set<string>
  >();
  private readonly sessionsByRelay = new Map<
    WebSocketConnection,
    Set<string>
  >();

  constructor(config: TunnelServiceConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    const server = createServer((request, response) =>
      this.handleHttp(request, response),
    );
    server.on("upgrade", (request, socket) => {
      const endpoint = parseTunnelEndpoint(request);
      if (!endpoint) {
        rejectUpgrade(socket as Socket);
        return;
      }

      const connection = acceptWebSocket(request, socket as Socket);
      if (!connection) {
        return;
      }

      if (endpoint === "relay") {
        this.registerRelaySocket(connection);
      } else {
        this.registerMobileSocket(connection);
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(this.config.port, this.config.host, resolve);
    });

    console.log(
      `[omniwork-tunnel] listening on ${this.config.host}:${this.config.port}`,
    );
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

  private registerRelaySocket(socket: WebSocketConnection): void {
    socket.onMessage((raw) => {
      const message = parseEnvelope(raw);
      if (!message) {
        socket.close(1003, "invalid json");
        return;
      }
      this.handleRelayMessage(socket, message);
    });
    socket.onClose(() => this.unregisterRelay(socket));
  }

  private registerMobileSocket(socket: WebSocketConnection): void {
    socket.onMessage((raw) => {
      const message = parseEnvelope(raw);
      if (!message) {
        socket.close(1003, "invalid json");
        return;
      }
      this.handleMobileMessage(socket, message);
    });
    socket.onClose(() => this.unregisterMobile(socket));
  }

  private handleRelayMessage(
    socket: WebSocketConnection,
    message: MessageEnvelope,
  ): void {
    if (message.type === "tunnel.relay.register") {
      const payload = message.payload as TunnelRelayRegisterPayload;
      this.relaysByDevice.set(payload.device_id, {
        deviceId: payload.device_id,
        socket,
      });
      return;
    }

    if (!message.session_id) {
      return;
    }

    const session = this.sessionsById.get(message.session_id);
    if (!session || session.relay !== socket) {
      return;
    }

    sendEnvelope(session.mobile, message);
  }

  private handleMobileMessage(
    socket: WebSocketConnection,
    message: MessageEnvelope,
  ): void {
    if (message.type === "tunnel.mobile.join") {
      this.handleMobileJoin(
        socket,
        message as MessageEnvelope<TunnelMobileJoinPayload>,
      );
      return;
    }

    if (!message.session_id) {
      return;
    }

    const session = this.sessionsById.get(message.session_id);
    if (!session || session.mobile !== socket) {
      return;
    }

    sendEnvelope(session.relay, message);
  }

  private handleMobileJoin(
    mobile: WebSocketConnection,
    message: MessageEnvelope<TunnelMobileJoinPayload>,
  ): void {
    const deviceId = message.payload.device_id;
    const relay = this.relaysByDevice.get(deviceId);
    if (!relay) {
      sendEnvelope(
        mobile,
        createMessage<TunnelSessionFailedPayload>(
          "tunnel.session.failed",
          {
            device_id: deviceId,
            reason: "agent_not_online",
            message: "relay is not registered with tunnel service",
            retry_after_ms: 2000,
          },
          { device_id: deviceId },
        ),
      );
      return;
    }

    const sessionId = `tun_${randomUUID()}`;
    const session: TunnelSession = {
      id: sessionId,
      deviceId,
      mobile,
      relay: relay.socket,
    };
    this.sessionsById.set(sessionId, session);
    addSessionIndex(this.sessionsByMobile, mobile, sessionId);
    addSessionIndex(this.sessionsByRelay, relay.socket, sessionId);

    sendEnvelope(relay.socket, {
      ...message,
      session_id: sessionId,
      payload: {
        ...message.payload,
        device_id: deviceId,
      },
    });
  }

  private unregisterRelay(socket: WebSocketConnection): void {
    for (const [deviceId, registration] of this.relaysByDevice.entries()) {
      if (registration.socket === socket) {
        this.relaysByDevice.delete(deviceId);
      }
    }
    this.closeIndexedSessions(this.sessionsByRelay, socket, "relay closed");
  }

  private unregisterMobile(socket: WebSocketConnection): void {
    this.closeIndexedSessions(this.sessionsByMobile, socket, "mobile closed");
  }

  private closeIndexedSessions(
    index: Map<WebSocketConnection, Set<string>>,
    socket: WebSocketConnection,
    reason: string,
  ): void {
    const sessionIds = index.get(socket);
    index.delete(socket);
    for (const sessionId of sessionIds ?? []) {
      const session = this.sessionsById.get(sessionId);
      if (!session) {
        continue;
      }
      this.sessionsById.delete(sessionId);
      this.sessionsByMobile.get(session.mobile)?.delete(sessionId);
      this.sessionsByRelay.get(session.relay)?.delete(sessionId);
      const target = socket === session.mobile ? session.relay : session.mobile;
      sendEnvelope(
        target,
        createMessage<TunnelSessionFailedPayload>(
          "tunnel.session.failed",
          {
            session_id: sessionId,
            device_id: session.deviceId,
            reason: "session_not_found",
            message: reason,
          },
          { device_id: session.deviceId, session_id: sessionId },
        ),
      );
    }
  }
}

function parseTunnelEndpoint(request: IncomingMessage): TunnelEndpoint | null {
  const url = new URL(request.url ?? "/", "http://tunnel.local");
  const pathname = normalizePathname(url.pathname);
  if (pathname === "/relay") {
    return "relay";
  }
  if (pathname === "/mobile" || pathname === "/tunnel/mobile") {
    return "mobile";
  }
  return null;
}

function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function parseEnvelope(raw: string): MessageEnvelope | null {
  try {
    return JSON.parse(raw) as MessageEnvelope;
  } catch {
    return null;
  }
}

function sendEnvelope(
  socket: WebSocketConnection,
  message: MessageEnvelope,
): void {
  socket.sendText(JSON.stringify(message));
}

function addSessionIndex(
  index: Map<WebSocketConnection, Set<string>>,
  socket: WebSocketConnection,
  sessionId: string,
): void {
  const sessions = index.get(socket) ?? new Set<string>();
  sessions.add(sessionId);
  index.set(socket, sessions);
}

function rejectUpgrade(socket: Socket): void {
  socket.write(
    [
      "HTTP/1.1 404 Not Found",
      "Connection: close",
      "Content-Type: text/plain",
      "\r\n",
      "Use /relay for Relay registrations or /mobile for App signaling.",
    ].join("\r\n"),
  );
  socket.destroy();
}
