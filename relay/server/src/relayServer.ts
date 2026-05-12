import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import {
  createMessage,
  type AgentHelloPayload,
  type AuthFailedPayload,
  type AuthOkPayload,
  type AuthProofPayload,
  type MessageEnvelope,
  type MobileConnectPayload,
} from "../../../packages/protocol-ts/src/index.ts";

import type { RelayServerConfig } from "./config.ts";
import { acceptWebSocket, WebSocketConnection } from "./websocket.ts";

type RelayRole = "unknown" | "agent" | "mobile";

interface RelayConnection {
  id: string;
  role: RelayRole;
  socket: WebSocketConnection;
  deviceId?: string;
  keyId?: string;
  authenticated: boolean;
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

  constructor(config: RelayServerConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => this.handleHttp(request, response));
    server.on("upgrade", (request, socket) => {
      const connection = acceptWebSocket(request, socket as Socket);
      if (connection) {
        this.register(connection);
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(this.config.port, this.config.host, resolve);
    });

    console.log(`[omniwork-relay] listening on ${this.config.host}:${this.config.port}`);
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

  private register(socket: WebSocketConnection): void {
    const connection: RelayConnection = {
      id: `conn_${randomUUID()}`,
      role: "unknown",
      socket,
      authenticated: false,
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
        this.handleAgentHello(connection, message as MessageEnvelope<AgentHelloPayload>);
        break;
      case "mobile.connect":
        this.handleMobileConnect(connection, message as MessageEnvelope<MobileConnectPayload>);
        break;
      case "auth.proof":
        this.handleAuthProof(connection, message as MessageEnvelope<AuthProofPayload>);
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

  private handleAgentHello(connection: RelayConnection, message: MessageEnvelope<AgentHelloPayload>): void {
    connection.role = "agent";
    connection.deviceId = message.payload.device_id;
    connection.keyId = message.payload.key_id;
    connection.authenticated = true;
    this.agentsByDevice.set(message.payload.device_id, connection);
  }

  private handleMobileConnect(connection: RelayConnection, message: MessageEnvelope<MobileConnectPayload>): void {
    const deviceId = message.payload.device_id;
    const agent = this.agentsByDevice.get(deviceId);
    connection.role = "mobile";
    connection.deviceId = deviceId;

    if (!agent?.keyId) {
      this.send(connection, createMessage<AuthFailedPayload>("auth.failed", {
        reason: "device_not_online",
        connection_id: connection.id,
        retry_after_ms: 2000,
      }, { device_id: deviceId }));
      return;
    }

    const nonce = randomBytes(24).toString("base64url");
    this.pendingAuth.set(connection.id, {
      deviceId,
      nonce,
      keyId: agent.keyId,
    });

    this.send(connection, createMessage("auth.challenge", {
      nonce,
      key_id: agent.keyId,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }, { device_id: deviceId }));
  }

  private handleAuthProof(connection: RelayConnection, message: MessageEnvelope<AuthProofPayload>): void {
    const pending = this.pendingAuth.get(connection.id);
    if (!pending || message.payload.nonce !== pending.nonce || message.payload.key_id !== pending.keyId) {
      this.send(connection, createMessage<AuthFailedPayload>("auth.failed", {
        reason: "malformed_proof",
        connection_id: connection.id,
        retry_after_ms: 2000,
      }, { device_id: connection.deviceId }));
      return;
    }

    const agent = this.agentsByDevice.get(pending.deviceId);
    if (!agent) {
      this.send(connection, createMessage<AuthFailedPayload>("auth.failed", {
        reason: "device_not_online",
        connection_id: connection.id,
        retry_after_ms: 2000,
      }, { device_id: pending.deviceId }));
      return;
    }

    this.send(agent, createMessage("auth.verify", {
      key_id: message.payload.key_id,
      nonce: message.payload.nonce,
      proof: message.payload.proof,
      connection_id: connection.id,
    }, { device_id: pending.deviceId }));
  }

  private handleAuthResult(connection: RelayConnection, message: MessageEnvelope): void {
    if (connection.role !== "agent") {
      return;
    }

    const payload = message.payload as AuthOkPayload | AuthFailedPayload;
    const mobileConnectionId = payload.connection_id;
    const mobile = mobileConnectionId ? this.connections.get(mobileConnectionId) : undefined;
    if (!mobile) {
      return;
    }

    this.pendingAuth.delete(mobile.id);
    if (message.type === "auth.ok") {
      mobile.authenticated = true;
      if (mobile.deviceId) {
        const mobiles = this.mobilesByDevice.get(mobile.deviceId) ?? new Set<RelayConnection>();
        mobiles.add(mobile);
        this.mobilesByDevice.set(mobile.deviceId, mobiles);
      }
    }

    this.send(mobile, message);
  }

  private routeMessage(connection: RelayConnection, message: MessageEnvelope): void {
    if (connection.role === "mobile") {
      if (!connection.authenticated || !connection.deviceId) {
        this.send(connection, createMessage<AuthFailedPayload>("auth.failed", {
          reason: "malformed_proof",
          connection_id: connection.id,
          retry_after_ms: 2000,
        }, { device_id: connection.deviceId }));
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
}
