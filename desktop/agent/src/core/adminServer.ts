import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { renderAgentAdminPage } from "../adminPage.ts";

import type {
  AgentObservedAppConnection,
  ConnectionSummary,
} from "./appConnectionRegistry.ts";
import type { RelayConnectionStatus } from "./relayReconnectPolicy.ts";

export interface AgentAdminServerOptions {
  host: string;
  port: number;
  token?: string;
  getStatus(): AgentAdminStatus;
  getConnections(): {
    agent: AgentAdminStatus["agent"];
    summary: ConnectionSummary;
    connections: AgentObservedAppConnection[];
  };
}

export interface AgentAdminStatus {
  agent: {
    device_id: string;
    agent_instance_id: string;
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
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method !== "GET") {
      this.writeJson(response, 405, { error: "method_not_allowed" });
      return;
    }
    if (!this.isAuthorized(request, url.pathname)) {
      this.writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      this.writeHtml(response, renderAgentAdminPage());
      return;
    }
    if (url.pathname === "/api/healthz") {
      this.writeJson(response, 200, {
        ok: true,
        service: "omniwork-agent-admin",
        now: Date.now(),
      });
      return;
    }
    if (url.pathname === "/api/status") {
      this.writeJson(response, 200, this.options.getStatus());
      return;
    }
    if (url.pathname === "/api/connections") {
      this.writeJson(response, 200, this.options.getConnections());
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
