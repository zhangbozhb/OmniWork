import type {
  AgentProbeEvent,
  AgentSurfaceEventPayload,
} from "@omni-work/protocol-ts";
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
  ensureTraeFamilyHooksInstalled,
  type TraeHookInstallProvider,
} from "../probes/traeHookInstaller.ts";
import {
  importTraeHookRecords as importTraeHookRecordFiles,
} from "../probes/traeHookRecordImporter.ts";
import {
  isClaudeTerminalProvider,
  isCodexTerminalProvider,
  resolveTraeTerminalProvider,
} from "./agentCommandUtils.ts";

interface AgentProbeRuntimeOptions {
  config: AgentConfig;
  logger: Logger;
  agentMessages: AgentMessageService;
  sessionManager: SessionManager;
  getKeyRecord(): SessionKeyRecord;
  onSurfaceEvent?(event: AgentSurfaceEventPayload): void;
}

export class AgentProbeRuntime {
  private readonly config: AgentConfig;
  private readonly logger: Logger;
  private readonly agentMessages: AgentMessageService;
  private readonly sessionManager: SessionManager;
  private readonly getKeyRecord: () => SessionKeyRecord;
  private readonly onSurfaceEvent?: (event: AgentSurfaceEventPayload) => void;
  private receiver: AgentHookReceiver | null = null;

  constructor(options: AgentProbeRuntimeOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.agentMessages = options.agentMessages;
    this.sessionManager = options.sessionManager;
    this.getKeyRecord = options.getKeyRecord;
    this.onSurfaceEvent = options.onSurfaceEvent;
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
        await this.acceptProbeEvent(event, "agent probe event accepted");
      },
    });
    try {
      await receiver.start();
      this.receiver = receiver;
      this.logger.info("agent hook receiver started", {
        url: `http://${this.config.agentProbeHost}:${this.config.agentProbePort}/api/probes/hooks`,
        token_source: this.config.agentProbeToken ? "env" : "session_key",
      });
      await this.importTraeHookRecords();
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
      return;
    }
    const traeProvider = resolveTraeTerminalProvider(terminalProvider);
    if (traeProvider) {
      await this.prepareTraeTerminalProvider(traeProvider);
    }
  }

  publishLocalProbeEvent(event: AgentProbeEvent): void {
    const message = this.agentMessages.publishProbeEvent(event);
    this.publishSurfaceEvent(event);
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

  private async acceptProbeEvent(
    event: AgentProbeEvent,
    logMessage: string,
  ): Promise<void> {
    const enrichedEvent = await this.enrichProbeEvent(event).catch((error) => {
      this.logger.warn("agent probe event enrichment failed", {
        provider: event.provider,
        event_type: event.event_type,
        session_id: event.session_id,
        error: String(error),
      });
      return event;
    });
    const message = this.agentMessages.publishProbeEvent(enrichedEvent);
    this.publishSurfaceEvent(enrichedEvent);
    if (message) {
      this.logger.info(logMessage, {
        provider: enrichedEvent.provider,
        event_type: enrichedEvent.event_type,
        session_id: enrichedEvent.session_id,
        surface_id: enrichedEvent.surface_id,
        message_kind: message.message_kind,
      });
    }
  }

  private async importTraeHookRecords(): Promise<void> {
    try {
      const results = await importTraeHookRecordFiles({
        onProbeEvent: async (event) => {
          await this.acceptProbeEvent(
            event,
            "trae hook record imported as probe event",
          );
        },
      });
      for (const result of results) {
        if (
          result.files === 0 &&
          result.imported === 0 &&
          result.invalid === 0
        ) {
          continue;
        }
        this.logger.info("trae hook records import checked", {
          provider: result.provider,
          records_root: result.recordsRoot,
          files: result.files,
          imported: result.imported,
          skipped: result.skipped,
          invalid: result.invalid,
        });
      }
    } catch (error) {
      this.logger.warn("trae hook records import failed", {
        error: String(error),
      });
    }
  }

  private publishSurfaceEvent(event: AgentProbeEvent): void {
    if (!event.surface_id || event.source.kind !== "app-server") {
      return;
    }
    this.onSurfaceEvent?.({
      session_id: event.session_id,
      surface_id: event.surface_id,
      provider: event.provider,
      event_id: event.id,
      event_type: event.event_type,
      title: event.title ?? "Agent event",
      summary: event.summary,
      payload: event.payload,
      source: event.source,
      created_at: event.created_at,
    });
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

  private async prepareTraeTerminalProvider(
    provider: TraeHookInstallProvider,
  ): Promise<void> {
    try {
      const results = await ensureTraeFamilyHooksInstalled({
        provider,
        receiverUrl: `http://${this.config.agentProbeHost}:${this.config.agentProbePort}/api/probes/hooks`,
        sessionKeyPath: this.config.sessionKeyPath,
      });
      for (const result of results) {
        if (!result.installed) {
          this.logger.warn("trae hooks auto install skipped", {
            hooks_path: result.hooksPath,
            provider: result.provider,
            reason: result.reason,
          });
          continue;
        }
        this.logger.info("trae hooks auto install checked", {
          hooks_path: result.hooksPath,
          provider: result.provider,
          changed: result.changed,
        });
      }
    } catch (error) {
      this.logger.warn("trae hooks auto install failed", {
        provider,
        error: String(error),
      });
    }
  }
}
