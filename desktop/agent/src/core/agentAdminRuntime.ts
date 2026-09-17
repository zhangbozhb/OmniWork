import type { AgentConfig } from "../config/config.ts";
import type { Logger } from "../telemetry/logger.ts";
import { AgentAdminServer } from "./adminServer.ts";
import type { AppConnectionRegistry } from "./appConnectionRegistry.ts";
import type { AgentAppSecurityGateway } from "./agentAppSecurityGateway.ts";
import type {
  AgentInfo,
  AgentRelayRuntimeStatus,
} from "./agentRuntimeTypes.ts";

interface AgentAdminRuntimeOptions {
  config: AgentConfig;
  logger: Logger;
  appConnections: AppConnectionRegistry;
  security: AgentAppSecurityGateway;
  getAgentInfo(): AgentInfo;
  getRelayStatus(): AgentRelayRuntimeStatus;
}

export class AgentAdminRuntime {
  private readonly config: AgentConfig;
  private readonly logger: Logger;
  private readonly appConnections: AppConnectionRegistry;
  private readonly security: AgentAppSecurityGateway;
  private readonly getAgentInfo: () => AgentInfo;
  private readonly getRelayStatus: () => AgentRelayRuntimeStatus;
  private server: AgentAdminServer | null = null;

  constructor(options: AgentAdminRuntimeOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.appConnections = options.appConnections;
    this.security = options.security;
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
            e2e_required: true,
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
      getPairingRequests: () => this.security.listPendingPairings(),
      getTrustedApps: () => this.security.listTrustedApps(),
      approvePairing: (requestId) => this.security.approvePairing(requestId),
      rejectPairing: (requestId) => this.security.rejectPairing(requestId),
      revokeApp: (appId) => this.security.revokeApp(appId),
      removeApp: (appId) => this.security.removeApp(appId),
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
