import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";

import { renderAgentAdminPage } from "../adminPage.ts";

import type {
  AgentObservedAppConnection,
  ConnectionSummary,
  DeviceConnectionStats,
} from "./appConnectionRegistry.ts";
import type { RelayConnectionStatus } from "./relayReconnectPolicy.ts";
import type { PendingPairingRequest } from "./agentAppSecurityGateway.ts";
import type { TrustedAppRecord } from "../config/trustedAppStore.ts";

export interface AgentAdminServerOptions {
  host: string;
  port: number;
  token?: string;
  getStatus(): AgentAdminStatus;
  getConnections(): {
    agent: AgentAdminStatus["agent"];
    summary: ConnectionSummary;
    devices: DeviceConnectionStats[];
    connections: AgentObservedAppConnection[];
  };
  getPairingRequests(): PendingPairingRequest[];
  getTrustedApps(): TrustedAppRecord[];
  approvePairing(requestId: string): boolean;
  rejectPairing(requestId: string): boolean;
  revokeApp(appId: string): boolean;
  removeApp(appId: string): boolean;
}

export interface AgentAdminStatus {
  agent: {
    device_id: string;
    hostname: string;
    platform: "darwin";
    version: string;
    started_at: number;
    now: number;
  };
  runtime: {
    admin_enabled: boolean;
    relay_configured: boolean;
    relay_connected: boolean;
    relay_status: RelayConnectionStatus;
    relay_reconnect_attempts: number;
    relay_next_retry_at: number | null;
    relay_last_error: string | null;
    relay_last_close: {
      code?: number;
      reason?: string;
    } | null;
    e2e_required: boolean;
  };
  connections_summary: ConnectionSummary;
}

export class AgentAdminServer {
  private readonly options: AgentAdminServerOptions;
  private readonly server = createServer((request, response) =>
    this.handleRequest(request, response),
  );

  constructor(options: AgentAdminServerOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (!this.options.token && !isLoopbackHostname(this.options.host)) {
      throw new Error(
        "Agent Admin requires admin.token when binding to a non-loopback host.",
      );
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  close(): void {
    this.server.close();
  }

  private handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      this.writeJson(response, 400, { error: "invalid_url" });
      return;
    }
    if (!this.isAuthorized(request, url.pathname)) {
      this.writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method === "POST" && !this.isAuthorizedMutation(request)) {
      this.writeJson(response, 403, { error: "forbidden" });
      return;
    }

    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/index.html")
    ) {
      this.writeHtml(response, renderAgentAdminPage());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/healthz") {
      this.writeJson(response, 200, {
        ok: true,
        service: "omniwork-agent-admin",
        now: Date.now(),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      this.writeJson(response, 200, this.options.getStatus());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/connections") {
      this.writeJson(response, 200, this.options.getConnections());
      return;
    }
    if (url.pathname === "/api/pairing/requests" && request.method === "GET") {
      this.writeJson(response, 200, {
        requests: this.options.getPairingRequests(),
      });
      return;
    }
    if (url.pathname === "/api/trusted-apps" && request.method === "GET") {
      this.writeJson(response, 200, {
        apps: this.options.getTrustedApps(),
      });
      return;
    }
    const pairingAction = matchActionPath(
      url.pathname,
      "/api/pairing/requests/",
      ["approve", "reject"],
    );
    if (pairingAction && request.method === "POST") {
      const handled =
        pairingAction.action === "approve"
          ? this.options.approvePairing(pairingAction.id)
          : this.options.rejectPairing(pairingAction.id);
      this.writeJson(
        response,
        handled ? 200 : 404,
        handled ? { ok: true } : { error: "not_found" },
      );
      return;
    }
    const trustedAppAction = matchActionPath(
      url.pathname,
      "/api/trusted-apps/",
      ["revoke", "remove"],
    );
    if (trustedAppAction && request.method === "POST") {
      const handled =
        trustedAppAction.action === "revoke"
          ? this.options.revokeApp(trustedAppAction.id)
          : this.options.removeApp(trustedAppAction.id);
      this.writeJson(
        response,
        handled ? 200 : 404,
        handled ? { ok: true } : { error: "not_found" },
      );
      return;
    }
    if (request.method !== "GET") {
      this.writeJson(response, 405, { error: "method_not_allowed" });
      return;
    }
    this.writeJson(response, 404, { error: "not_found" });
  }

  private isAuthorized(request: IncomingMessage, pathname: string): boolean {
    if (!pathname.startsWith("/api/") || !this.options.token) {
      return true;
    }
    const header = request.headers.authorization;
    return header === `Bearer ${this.options.token}`;
  }

  private isAuthorizedMutation(request: IncomingMessage): boolean {
    if (this.options.token) {
      return true;
    }
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (
      typeof origin !== "string" ||
      typeof host !== "string" ||
      !isLoopbackAddress(request.socket.remoteAddress)
    ) {
      return false;
    }
    try {
      const originUrl = new URL(origin);
      return (
        originUrl.protocol === "http:" &&
        originUrl.host === host &&
        isLoopbackHostname(originUrl.hostname)
      );
    } catch {
      return false;
    }
  }

  private writeJson(
    response: ServerResponse,
    statusCode: number,
    body: unknown,
  ): void {
    response.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(`${JSON.stringify(body, null, 2)}\n`);
  }

  private writeHtml(response: ServerResponse, body: string): void {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(body);
  }
}

function matchActionPath<Action extends string>(
  pathname: string,
  prefix: string,
  actions: readonly Action[],
): { id: string; action: Action } | null {
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const [rawId, action, extra] = pathname.slice(prefix.length).split("/");
  if (
    !rawId ||
    !action ||
    extra !== undefined ||
    !actions.includes(action as Action)
  ) {
    return null;
  }
  try {
    return { id: decodeURIComponent(rawId), action: action as Action };
  } catch {
    return null;
  }
}

function isLoopbackAddress(value: string | undefined): boolean {
  const normalized = value?.toLowerCase().replace(/^::ffff:/u, "");
  return (
    normalized === "::1" ||
    (normalized !== undefined &&
      isIP(normalized) === 4 &&
      normalized.startsWith("127."))
  );
}

function isLoopbackHostname(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  return normalized === "localhost" || isLoopbackAddress(normalized);
}
