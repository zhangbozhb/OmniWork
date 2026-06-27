import {
  type MessageEnvelope,
  type P2pChannelKind,
  type TunnelUpgradeAnswerPayload,
  type TunnelUpgradeCandidatePayload,
  type TunnelUpgradeCommittedPayload,
  type TunnelUpgradeDowngradePayload,
  type TunnelUpgradeOfferPayload,
  type TunnelUpgradeProposePayload,
} from "@omniwork/protocol-ts";
import type { Logger } from "../telemetry/logger.ts";
import type { AppConnectionRegistry } from "./appConnectionRegistry.ts";
import type { AgentSessionTransport } from "../transport/index.ts";
import { UpgradeCoordinator } from "../transport/upgradeCoordinator.ts";
import { createAgentWebRtcPeerAdapter } from "../transport/webRtcPeerAdapter.ts";
import type { AgentConfig } from "../config/config.ts";

interface AgentTunnelUpgradeHandlerOptions {
  config: AgentConfig;
  logger: Logger;
  appConnections: AppConnectionRegistry;
  getTransport(): AgentSessionTransport | null;
  sendToAppByConnectionId(
    appConnectionId: string,
    message: MessageEnvelope,
    channel?: P2pChannelKind,
    options?: { strictBypass?: boolean },
  ): void;
}

export class AgentTunnelUpgradeHandler {
  private readonly config: AgentConfig;
  private readonly logger: Logger;
  private readonly appConnections: AppConnectionRegistry;
  private readonly getTransport: () => AgentSessionTransport | null;
  private readonly sendToAppByConnectionId: (
    appConnectionId: string,
    message: MessageEnvelope,
    channel?: P2pChannelKind,
    options?: { strictBypass?: boolean },
  ) => void;
  private readonly coordinators = new Map<string, UpgradeCoordinator>();

  constructor(options: AgentTunnelUpgradeHandlerOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.appConnections = options.appConnections;
    this.getTransport = options.getTransport;
    this.sendToAppByConnectionId = options.sendToAppByConnectionId;
  }

  async handlePropose(
    message: MessageEnvelope<TunnelUpgradeProposePayload>,
  ): Promise<void> {
    const payload = message.payload;
    const transport = this.getTransport();
    if (payload.strict === true) {
      transport?.configureStrictP2pForConnection(
        payload.app_connection_id,
        true,
        (reason) => {
          this.logger.warn("strict_p2p_disconnect", {
            app_connection_id: payload.app_connection_id,
            reason,
          });
        },
      );
    } else {
      transport?.clearStrictP2pForConnection(payload.app_connection_id);
    }
    await this.getUpgradeCoordinator(payload.app_connection_id).propose(
      payload,
    );
  }

  async handleOffer(
    message: MessageEnvelope<TunnelUpgradeOfferPayload>,
  ): Promise<void> {
    const payload = message.payload;
    await this.getUpgradeCoordinator(payload.app_connection_id).handleOffer(
      payload,
    );
  }

  async handleAnswer(
    message: MessageEnvelope<TunnelUpgradeAnswerPayload>,
  ): Promise<void> {
    const payload = message.payload;
    await this.getUpgradeCoordinator(payload.app_connection_id).handleAnswer(
      payload,
    );
  }

  async handleCandidate(
    message: MessageEnvelope<TunnelUpgradeCandidatePayload>,
  ): Promise<void> {
    const payload = message.payload;
    await this.getUpgradeCoordinator(payload.app_connection_id).handleCandidate(
      payload,
    );
  }

  handleCommitted(
    message: MessageEnvelope<TunnelUpgradeCommittedPayload>,
  ): void {
    const payload = message.payload;
    this.getUpgradeCoordinator(payload.app_connection_id).handleCommitted(
      payload,
    );
  }

  handleDowngrade(
    message: MessageEnvelope<TunnelUpgradeDowngradePayload>,
  ): void {
    const payload = message.payload;
    this.getUpgradeCoordinator(payload.app_connection_id).downgrade(
      payload.reason,
    );
  }

  detachConnection(appConnectionId: string): void {
    this.coordinators.get(appConnectionId)?.close();
    this.coordinators.delete(appConnectionId);
    this.getTransport()?.detachP2pPeer(appConnectionId);
  }

  clear(): void {
    for (const coordinator of this.coordinators.values()) {
      coordinator.close();
    }
    this.coordinators.clear();
  }

  private getUpgradeCoordinator(appConnectionId: string): UpgradeCoordinator {
    const existing = this.coordinators.get(appConnectionId);
    if (existing) {
      return existing;
    }
    if (!this.getTransport()) {
      throw new Error("Cannot create upgrade coordinator without transport.");
    }
    const coordinator = new UpgradeCoordinator({
      role: "answerer",
      deviceId: this.config.deviceId,
      peerFactory: (opts) =>
        createAgentWebRtcPeerAdapter({
          iceServers: opts.iceServers,
          role: opts.role,
        }),
      sendControl: (envelope) =>
        this.sendToAppByConnectionId(appConnectionId, envelope, undefined, {
          strictBypass: true,
        }),
      onSwitchPath: (path) => {
        this.appConnections.setPath(appConnectionId, path);
        const transport = this.getTransport();
        if (path === "p2p") {
          const peer = coordinator.getPeer();
          const upgradeId = coordinator.getUpgradeId();
          if (peer) {
            transport?.attachP2pPeer(peer, {
              appConnectionId,
              upgradeId: upgradeId ?? undefined,
              onDowngrade: (reason) => coordinator.downgrade(reason),
            });
          }
        } else {
          transport?.detachP2pPeer(appConnectionId);
        }
        void transport?.switchPathForConnection(appConnectionId, path);
      },
      onForceClose: (reason) => {
        this.getTransport()?.forceCloseConnection(appConnectionId, reason);
      },
    });
    coordinator.onEvent((event) => {
      if (event.type === "propose") {
        this.logger.info("upgrade propose", {
          app_connection_id: appConnectionId,
          upgrade_id: event.upgrade_id,
          role: event.role,
        });
      } else if (event.type === "upgrade_success") {
        this.logger.info("upgrade success", {
          app_connection_id: appConnectionId,
          upgrade_id: event.upgrade_id,
        });
      } else {
        this.logger.warn("upgrade failed", {
          app_connection_id: appConnectionId,
          upgrade_id: event.upgrade_id,
          reason: event.reason,
        });
      }
    });
    this.coordinators.set(appConnectionId, coordinator);
    return coordinator;
  }
}
