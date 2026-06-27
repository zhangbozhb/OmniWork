import type {
  AgentMessageAckPayload,
  AgentMessageDeliveredPayload,
  AgentMessageListRequestPayload,
  AgentMessageReadRequestPayload,
  AgentNotificationSettingsPayload,
  AppConnectionGoodbyePayload,
  AppConnectionHeartbeatPayload,
  AuthVerifyPayload,
  E2EHandshakeInitPayload,
  E2EMessagePayload,
  E2EReadyPayload,
  FilesListRequestPayload,
  FilesReadRequestPayload,
  FilesWriteRequestPayload,
  GitDiffRequestPayload,
  GitStatusRequestPayload,
  MessageEnvelope,
  SessionCreatePayload,
  SessionRenamePayload,
  TerminalInputPayload,
  TerminalResizePayload,
  TerminalStreamStartPayload,
  TerminalStreamStopPayload,
  TunnelUpgradeAnswerPayload,
  TunnelUpgradeCandidatePayload,
  TunnelUpgradeCommittedPayload,
  TunnelUpgradeDowngradePayload,
  TunnelUpgradeOfferPayload,
  TunnelUpgradeProposePayload,
} from "@omniwork/protocol-ts";
import type { AgentConfig } from "../config/config.ts";
import type { Logger } from "../telemetry/logger.ts";
import type { ResourceRequestHandler } from "./resourceRequestHandler.ts";
import type { SessionRequestHandler } from "./sessionRequestHandler.ts";
import type { TerminalStreamPusher } from "./terminalStreamPusher.ts";
import type { TerminalRequestHandler } from "./terminalRequestHandler.ts";
import type { AgentInboxHandler } from "./agentInboxHandler.ts";
import type { AgentAppSecurityGateway } from "./agentAppSecurityGateway.ts";
import type { AgentTunnelUpgradeHandler } from "./agentTunnelUpgradeHandler.ts";
import type { AgentDispatchContext } from "./agentRuntimeTypes.ts";

interface AgentMessageDispatcherOptions {
  config: AgentConfig;
  logger: Logger;
  security: AgentAppSecurityGateway;
  tunnelUpgrade: AgentTunnelUpgradeHandler;
  sessionRequests: SessionRequestHandler;
  resourceRequests: ResourceRequestHandler;
  terminalRequests: TerminalRequestHandler;
  terminalStreamPusher: TerminalStreamPusher;
  inbox: AgentInboxHandler;
}

export class AgentMessageDispatcher {
  private readonly options: AgentMessageDispatcherOptions;

  constructor(options: AgentMessageDispatcherOptions) {
    this.options = options;
  }

  async dispatch(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ): Promise<void> {
    const trustedE2E = context?.trustedE2E === true;
    const dispatchContext =
      context ??
      (message.app_connection_id
        ? {
            appConnectionId: message.app_connection_id,
            trustedE2E: false,
          }
        : undefined);

    switch (message.type) {
      case "auth.verify":
        this.options.security.handleAuthVerify(
          message as MessageEnvelope<AuthVerifyPayload>,
        );
        break;
      case "e2e.handshake.init":
        this.options.security.handleE2EHandshakeInit(
          message as MessageEnvelope<E2EHandshakeInitPayload>,
        );
        break;
      case "e2e.ready":
        this.options.security.handleE2EReady(
          message as MessageEnvelope<E2EReadyPayload>,
        );
        break;
      case "e2e.message":
        await this.options.security.handleE2EMessage(
          message as MessageEnvelope<E2EMessagePayload>,
        );
        break;
      case "app.connection.heartbeat":
        this.options.security.handleConnectionHeartbeat(
          message as MessageEnvelope<AppConnectionHeartbeatPayload>,
          dispatchContext,
          trustedE2E,
        );
        break;
      case "app.connection.goodbye":
        this.options.security.handleConnectionGoodbye(
          message as MessageEnvelope<AppConnectionGoodbyePayload>,
          dispatchContext,
          trustedE2E,
        );
        break;
      case "session.list":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.options.sessionRequests.handleList(message, dispatchContext);
        break;
      case "session.create":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.options.sessionRequests.handleCreate(
          message as MessageEnvelope<SessionCreatePayload>,
          dispatchContext,
        );
        break;
      case "session.close":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        if (message.session_id) {
          await this.options.terminalStreamPusher.stop(message.session_id);
        }
        await this.options.sessionRequests.handleClose(
          message,
          dispatchContext,
        );
        break;
      case "session.rename":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.options.sessionRequests.handleRename(
          message as MessageEnvelope<SessionRenamePayload>,
          dispatchContext,
        );
        break;
      case "session.kill_terminal":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        if (message.session_id) {
          await this.options.terminalStreamPusher.stop(message.session_id);
        }
        await this.options.sessionRequests.handleKillTerminal(
          message,
          dispatchContext,
        );
        break;
      case "workspace.list":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.options.resourceRequests.handleWorkspaceList(
          message,
          dispatchContext,
        );
        break;
      case "files.list":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.options.resourceRequests.handleFilesList(
          message as MessageEnvelope<FilesListRequestPayload>,
          dispatchContext,
        );
        break;
      case "files.read":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.options.resourceRequests.handleFilesRead(
          message as MessageEnvelope<FilesReadRequestPayload>,
          dispatchContext,
        );
        break;
      case "files.write":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.options.resourceRequests.handleFilesWrite(
          message as MessageEnvelope<FilesWriteRequestPayload>,
          dispatchContext,
        );
        break;
      case "git.status":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.options.resourceRequests.handleGitStatus(
          message as MessageEnvelope<GitStatusRequestPayload>,
          dispatchContext,
        );
        break;
      case "git.diff":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.options.resourceRequests.handleGitDiff(
          message as MessageEnvelope<GitDiffRequestPayload>,
          dispatchContext,
        );
        break;
      case "terminal.input":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.options.terminalRequests.handleInput(
          message as MessageEnvelope<TerminalInputPayload>,
        );
        break;
      case "terminal.resize":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.options.terminalRequests.handleResize(
          message as MessageEnvelope<TerminalResizePayload>,
        );
        break;
      case "session.attach":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.options.sessionRequests.handleAttach(
          message,
          dispatchContext,
        );
        break;
      case "terminal.snapshot":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.options.terminalRequests.handleSnapshot(
          message,
          dispatchContext,
        );
        break;
      case "terminal.stream.start":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.options.terminalRequests.handleStreamStart(
          message as MessageEnvelope<TerminalStreamStartPayload>,
          dispatchContext,
        );
        break;
      case "terminal.stream.stop":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.options.terminalRequests.handleStreamStop(
          message as MessageEnvelope<TerminalStreamStopPayload>,
          dispatchContext,
        );
        break;
      case "agent.message.list":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        this.options.inbox.handleMessageList(
          message as MessageEnvelope<AgentMessageListRequestPayload>,
          dispatchContext,
        );
        break;
      case "agent.message.read":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        this.options.inbox.handleMessageRead(
          message as MessageEnvelope<AgentMessageReadRequestPayload>,
          dispatchContext,
        );
        break;
      case "agent.message.ack":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        this.options.inbox.handleMessageAck(
          message as MessageEnvelope<AgentMessageAckPayload>,
          dispatchContext,
        );
        break;
      case "agent.message.delivered":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        this.options.inbox.handleMessageDelivered(
          message as MessageEnvelope<AgentMessageDeliveredPayload>,
          dispatchContext,
        );
        break;
      case "agent.notification.settings.get":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        this.options.inbox.handleNotificationSettingsGet(
          message,
          dispatchContext,
        );
        break;
      case "agent.notification.settings.set":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        this.options.inbox.handleNotificationSettingsSet(
          message as MessageEnvelope<AgentNotificationSettingsPayload>,
          dispatchContext,
        );
        break;
      case "tunnel.upgrade.propose": {
        const upgradeMessage =
          message as MessageEnvelope<TunnelUpgradeProposePayload>;
        const payload = upgradeMessage.payload;
        if (
          this.options.config.businessSecurityMode === "e2e_required" &&
          !trustedE2E &&
          !this.options.security.hasReadyE2EPeer(payload.app_connection_id)
        ) {
          this.options.security.rejectPlaintextBusiness(message, trustedE2E);
          return;
        }
        if (
          !this.options.security.recordInboundBusinessForConnection(
            message,
            payload.app_connection_id,
            trustedE2E,
            { skipPlaintextReject: true },
          )
        ) {
          return;
        }
        await this.options.tunnelUpgrade.handlePropose(upgradeMessage);
        break;
      }
      case "tunnel.upgrade.offer":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.options.tunnelUpgrade.handleOffer(
          message as MessageEnvelope<TunnelUpgradeOfferPayload>,
        );
        break;
      case "tunnel.upgrade.answer":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.options.tunnelUpgrade.handleAnswer(
          message as MessageEnvelope<TunnelUpgradeAnswerPayload>,
        );
        break;
      case "tunnel.upgrade.candidate":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        await this.options.tunnelUpgrade.handleCandidate(
          message as MessageEnvelope<TunnelUpgradeCandidatePayload>,
        );
        break;
      case "tunnel.upgrade.committed":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        this.options.tunnelUpgrade.handleCommitted(
          message as MessageEnvelope<TunnelUpgradeCommittedPayload>,
        );
        break;
      case "tunnel.upgrade.downgrade":
        if (!this.recordInboundBusiness(message, dispatchContext, trustedE2E)) {
          return;
        }
        this.options.tunnelUpgrade.handleDowngrade(
          message as MessageEnvelope<TunnelUpgradeDowngradePayload>,
        );
        break;
      default:
        this.options.logger.debug("ignored relay message", {
          message_type: message.type,
        });
    }
  }

  private recordInboundBusiness(
    message: MessageEnvelope,
    context: AgentDispatchContext | undefined,
    trustedE2E: boolean,
  ): boolean {
    return this.options.security.recordInboundBusiness(
      message,
      context,
      trustedE2E,
    );
  }
}
