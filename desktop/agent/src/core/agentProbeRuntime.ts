import type { AgentProbeEvent } from "@omniwork/protocol-ts";
import type { AgentConfig } from "../config/config.ts";
import type { Logger } from "../telemetry/logger.ts";
import type { SessionKeyRecord } from "../auth-key/authKey.ts";
import type { SessionManager } from "./sessionManager.ts";
import type { AgentMessageService } from "../probes/agentMessageService.ts";
import { AgentHookReceiver } from "../probes/agentHookReceiver.ts";
import { enrichProbeEventWithSessions } from "../probes/agentProbeEnrichment.ts";
import { ensureClaudeHooksInstalled } from "../probes/claudeHookInstaller.ts";
import { ensureCodexHooksInstalled } from "../probes/codexHookInstaller.ts";
import {
  isClaudeTerminalProvider,
  isCodexTerminalProvider,
} from "./agentCommandUtils.ts";

interface AgentProbeRuntimeOptions {
  config: AgentConfig;
  logger: Logger;
  agentMessages: AgentMessageService;
  sessionManager: SessionManager;
  getKeyRecord(): SessionKeyRecord;
}

export class AgentProbeRuntime {
  private readonly config: AgentConfig;
  private readonly logger: Logger;
  private readonly agentMessages: AgentMessageService;
  private readonly sessionManager: SessionManager;
  private readonly getKeyRecord: () => SessionKeyRecord;
  private receiver: AgentHookReceiver | null = null;

  constructor(options: AgentProbeRuntimeOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.agentMessages = options.agentMessages;
    this.sessionManager = options.sessionManager;
    this.getKeyRecord = options.getKeyRecord;
  }

  async start(): Promise<void> {
    if (!this.config.agentProbeEnabled || this.receiver) {
      return;
    }
    const token = this.config.agentProbeToken ?? this.getKeyRecord().key;
    const receiver = new AgentHookReceiver({
      host: this.config.agentProbeHost,
      port: this.config.agentProbePort,
      token,
      onProbeEvent: async (event) => {
        const enrichedEvent = await this.enrichProbeEvent(event).catch(
          (error) => {
            this.logger.warn("agent probe event enrichment failed", {
              provider: event.provider,
              event_type: event.event_type,
              session_id: event.session_id,
              error: String(error),
            });
            return event;
          },
        );
        const message = this.agentMessages.publishProbeEvent(enrichedEvent);
        if (message) {
          this.logger.info("agent probe event accepted", {
            provider: enrichedEvent.provider,
            event_type: enrichedEvent.event_type,
            session_id: enrichedEvent.session_id,
            surface_id: enrichedEvent.surface_id,
            message_kind: message.message_kind,
          });
        }
      },
    });
    try {
      await receiver.start();
      this.receiver = receiver;
      this.logger.info("agent hook receiver started", {
        url: `http://${this.config.agentProbeHost}:${this.config.agentProbePort}/api/probes/hooks`,
        token_source: this.config.agentProbeToken ? "env" : "session_key",
      });
    } catch (error) {
      receiver.close();
      this.logger.warn("agent hook receiver disabled after startup failure", {
        host: this.config.agentProbeHost,
        port: this.config.agentProbePort,
        error: String(error),
      });
    }
  }

  close(): void {
    this.receiver?.close();
    this.receiver = null;
  }

  async prepareTerminalProvider(terminalProvider: {
    kind: string;
    command: string;
  }): Promise<void> {
    if (!this.config.agentProbeEnabled) {
      return;
    }
    if (isCodexTerminalProvider(terminalProvider)) {
      await this.prepareCodexTerminalProvider();
      return;
    }
    if (isClaudeTerminalProvider(terminalProvider)) {
      await this.prepareClaudeTerminalProvider();
    }
  }

  publishLocalProbeEvent(event: AgentProbeEvent): void {
    const message = this.agentMessages.publishProbeEvent(event);
    if (message) {
      this.logger.info("local probe event accepted", {
        provider: event.provider,
        event_type: event.event_type,
        session_id: event.session_id,
        surface_id: event.surface_id,
        message_kind: message.message_kind,
      });
    }
  }

  private async enrichProbeEvent(
    event: AgentProbeEvent,
  ): Promise<AgentProbeEvent> {
    return enrichProbeEventWithSessions(
      event,
      await this.sessionManager.list(),
    );
  }

  private async prepareCodexTerminalProvider(): Promise<void> {
    try {
      const result = await ensureCodexHooksInstalled({
        receiverUrl: `http://${this.config.agentProbeHost}:${this.config.agentProbePort}/api/probes/hooks`,
        sessionKeyPath: this.config.sessionKeyPath,
      });
      if (!result.installed) {
        this.logger.warn("codex hooks auto install skipped", {
          hooks_path: result.hooksPath,
          reason: result.reason,
        });
        return;
      }
      this.logger.info("codex hooks auto install checked", {
        hooks_path: result.hooksPath,
        changed: result.changed,
      });
    } catch (error) {
      this.logger.warn("codex hooks auto install failed", {
        error: String(error),
      });
    }
  }

  private async prepareClaudeTerminalProvider(): Promise<void> {
    try {
      const result = await ensureClaudeHooksInstalled({
        receiverUrl: `http://${this.config.agentProbeHost}:${this.config.agentProbePort}/api/probes/hooks`,
        sessionKeyPath: this.config.sessionKeyPath,
      });
      if (!result.installed) {
        this.logger.warn("claude hooks auto install skipped", {
          settings_path: result.settingsPath,
          reason: result.reason,
        });
        return;
      }
      this.logger.info("claude hooks auto install checked", {
        settings_path: result.settingsPath,
        changed: result.changed,
      });
    } catch (error) {
      this.logger.warn("claude hooks auto install failed", {
        error: String(error),
      });
    }
  }
}
