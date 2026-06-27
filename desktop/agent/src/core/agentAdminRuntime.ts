import type { AgentConfig } from "../config/config.ts";
import type { Logger } from "../telemetry/logger.ts";
import { AgentAdminServer } from "./adminServer.ts";
import type { AppConnectionRegistry } from "./appConnectionRegistry.ts";
import type {
  AgentInfo,
  AgentRelayRuntimeStatus,
} from "./agentRuntimeTypes.ts";

interface AgentAdminRuntimeOptions {
  config: AgentConfig;
  logger: Logger;
  appConnections: AppConnectionRegistry;
  getAgentInfo(): AgentInfo;
  getRelayStatus(): AgentRelayRuntimeStatus;
}

export class AgentAdminRuntime {
  private readonly config: AgentConfig;
  private readonly logger: Logger;
  private readonly appConnections: AppConnectionRegistry;
  private readonly getAgentInfo: () => AgentInfo;
  private readonly getRelayStatus: () => AgentRelayRuntimeStatus;
  private server: AgentAdminServer | null = null;

  constructor(options: AgentAdminRuntimeOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.appConnections = options.appConnections;
    this.getAgentInfo = options.getAgentInfo;
    this.getRelayStatus = options.getRelayStatus;
  }

  async start(): Promise<void> {
    if (!this.config.adminEnabled || this.server) {
      return;
    }
    const server = new AgentAdminServer({
      host: this.config.adminHost,
      port: this.config.adminPort,
      token: this.config.adminToken,
      getStatus: () => {
        const relay = this.getRelayStatus();
        return {
          agent: this.getAgentInfo(),
          runtime: {
            admin_enabled: this.config.adminEnabled,
            relay_configured: Boolean(this.config.relayUrl),
            relay_connected: relay.status === "connected",
            relay_status: relay.status,
            relay_reconnect_attempts: relay.reconnectAttempts,
            relay_next_retry_at: relay.nextRetryAt,
            relay_last_error: relay.lastError,
            relay_last_close: relay.lastClose,
            e2e_required: this.config.businessSecurityMode === "e2e_required",
          },
          connections_summary: this.appConnections.summary(),
        };
      },
      getConnections: () => ({
        agent: this.getAgentInfo(),
        summary: this.appConnections.summary(),
        devices: this.appConnections.devices(),
        connections: this.appConnections.list(),
      }),
    });
    await server.start();
    this.server = server;
    this.logger.info("agent admin server started", {
      url: `http://${this.config.adminHost}:${this.config.adminPort}/`,
    });
  }

  close(): void {
    this.server?.close();
    this.server = null;
  }
}
