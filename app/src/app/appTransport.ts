import {
  Platform,
} from "react-native";
import {
  createMessage,
  TERMINAL_STREAM_CAPABILITY_V1,
  type AppClientPlatform,
  type AppNetworkChangedPayload,
  type MessageEnvelope,
  type TransportPreference,
  type TunnelUpgradeAnswerPayload,
  type TunnelUpgradeCandidatePayload,
  type TunnelUpgradeCommittedPayload,
  type TunnelUpgradeDowngradePayload,
  type TunnelUpgradeOfferPayload,
  type TunnelUpgradeProposePayload,
} from "@omniwork/protocol-ts";
import type { PairingConfig } from "../features/auth/types";
import { MobileRelaySession } from "../lib/relay-client/mobileRelaySession";
import { MobileRelayPath, MobileSessionTransport } from "../lib/transport";
import { UpgradeCoordinator } from "../lib/transport/upgradeCoordinator";
import { createMobileWebRtcPeerAdapter } from "../lib/transport/webRtcPeerAdapter";
import type { AppSessionTransport, NetworkChangeDetails } from "./appTypes";
import { appConfig } from "./appConfig";

export function createAppSessionTransport(
  pairing: PairingConfig,
  transportPreference: TransportPreference,
  options: { onForceClose?: (reason: string) => void } = {},
): AppSessionTransport {
  const session = new MobileRelaySession(pairing, {
    transportPreference,
    appMetadata: {
      name: appConfig.appName,
      platform: currentAppPlatform(),
      version: appConfig.appVersion,
      capabilities: [
        ...(appConfig.terminal.streamEnabled
          ? [TERMINAL_STREAM_CAPABILITY_V1]
          : []),
        "agent.message.inbox.sqlite",
      ],
    },
  });
  const relayPath = new MobileRelayPath(session);
  const strictP2p = transportPreference === "prefer_p2p";
  const onForceClose = options.onForceClose;
  const transport = new MobileSessionTransport(relayPath, {
    strictP2p,
    onForceClose,
  });
  const logTransport =
    typeof process !== "undefined" &&
    process.env?.OMNIWORK_LOG_TRANSPORT === "1";

  const coordinator = new UpgradeCoordinator({
    role: "offerer",
    deviceId: pairing.deviceId,
    peerFactory: (opts) => {
      if (transportPreference === "relay_only") {
        console.info("[omniwork-app] upgrade refused by transport_preference", {
          preference: transportPreference,
        });
        return null;
      }
      return createMobileWebRtcPeerAdapter({
        iceServers: opts.iceServers,
        role: opts.role,
      });
    },
    sendControl: (envelope) => session.send(envelope),
    onSwitchPath: (path) => {
      session.setConnectionPath(path);
      if (path === "p2p") {
        const peer = coordinator.getPeer();
        const upgradeId = coordinator.getUpgradeId();
        if (peer) {
          transport.attachP2pPeer(peer, {
            upgradeId: upgradeId ?? undefined,
            onDowngrade: (reason) => coordinator.downgrade(reason),
          });
        }
      }
      void transport.switchPath(path);
    },
    onForceClose: (reason) => {
      transport.forceClose(reason);
    },
  });

  transport.onEvent((event) => {
    switch (event.type) {
      case "path_change":
        session.setConnectionPath(event.to);
        console.info("[omniwork-app] transport path changed", {
          from: event.from,
          to: event.to,
        });
        break;
      case "ping_timeout":
        console.warn("[omniwork-app] transport ping timeout", {
          seq: event.seq,
          count: event.count,
        });
        break;
      case "pong_received":
        if (logTransport) {
          console.info("[omniwork-app] transport pong received", {
            seq: event.seq,
            rtt_ms: event.rtt_ms,
          });
        }
        break;
      case "downgrade":
        console.warn("[omniwork-app] transport downgrade", {
          reason: event.reason,
        });
        break;
      case "force_close":
        console.warn("[omniwork-app] strict_p2p force_close", {
          reason: event.reason,
        });
        break;
      case "strict_send_blocked":
        console.warn("[omniwork-app] strict_p2p send blocked", {
          envelope_type: event.envelope_type,
        });
        break;
      case "background_pause":
        console.info("[omniwork-app] strict_p2p background pause");
        break;
      case "background_resume":
        console.info("[omniwork-app] strict_p2p background resume");
        break;
    }
  });

  coordinator.onEvent((event) => {
    switch (event.type) {
      case "propose":
        console.info("[omniwork-app] upgrade propose", {
          upgrade_id: event.upgrade_id,
          role: event.role,
        });
        break;
      case "upgrade_success":
        console.info("[omniwork-app] upgrade success", {
          upgrade_id: event.upgrade_id,
        });
        break;
      case "upgrade_failed":
        console.warn("[omniwork-app] upgrade failed", {
          upgrade_id: event.upgrade_id,
          reason: event.reason,
        });
        break;
    }
  });

  return {
    connect: () => session.connect(),
    onMessage: (handler) => transport.onMessage(handler),
    onClose: (handler) => relayPath.onClose(handler),
    send: (message) => transport.send(message),
    onBusinessReady: (handler) => session.onBusinessReady(handler),
    close: () => {
      if (transport.getCurrentPath() === "p2p") {
        coordinator.downgrade("client_closing");
      }
      transport.close("client closing");
      session.close();
    },
    getCurrentPath: () => transport.getCurrentPath(),
    getAppConnectionId: () => session.getAppConnectionId(),
    onPathChange: (handler) => transport.onPathChange(handler),
    forceDowngrade: (reason) => {
      transport.forceDowngrade(reason);
      coordinator.downgrade(reason);
    },
    forceClose: (reason) => transport.forceClose(reason),
    handleUpgradeMessage: (message) => {
      const appConnectionId = session.getAppConnectionId();
      const payloadAppConnectionId = (
        message.payload as { app_connection_id?: string }
      ).app_connection_id;
      if (!appConnectionId || payloadAppConnectionId !== appConnectionId) {
        return;
      }
      switch (message.type) {
        case "tunnel.upgrade.propose":
          void coordinator.propose(
            (message as MessageEnvelope<TunnelUpgradeProposePayload>).payload,
          );
          break;
        case "tunnel.upgrade.offer":
          void coordinator.handleOffer(
            (message as MessageEnvelope<TunnelUpgradeOfferPayload>).payload,
          );
          break;
        case "tunnel.upgrade.answer":
          void coordinator.handleAnswer(
            (message as MessageEnvelope<TunnelUpgradeAnswerPayload>).payload,
          );
          break;
        case "tunnel.upgrade.candidate":
          void coordinator.handleCandidate(
            (message as MessageEnvelope<TunnelUpgradeCandidatePayload>).payload,
          );
          break;
        case "tunnel.upgrade.committed":
          coordinator.handleCommitted(
            (message as MessageEnvelope<TunnelUpgradeCommittedPayload>).payload,
          );
          break;
        case "tunnel.upgrade.downgrade": {
          const reason = (
            message as MessageEnvelope<TunnelUpgradeDowngradePayload>
          ).payload.reason;
          if (
            reason.startsWith("strict_unavailable") &&
            transport.isStrictP2p()
          ) {
            transport.forceClose(reason);
            break;
          }
          coordinator.downgrade(reason);
          break;
        }
        default:
          break;
      }
    },
    pauseForBackground: () => transport.pauseForBackground(),
    resumeForForeground: () => transport.resumeForForeground(),
    requestP2pReconnect: (reason, details = {}) => {
      const appConnectionId = session.getAppConnectionId();
      if (!appConnectionId) {
        return;
      }
      coordinator.prepareForReconnect(reason);
      transport.prepareForReconnect(reason);
      try {
        session.send(
          createMessage<AppNetworkChangedPayload>(
            "app.network.changed",
            {
              app_connection_id: appConnectionId,
              reason,
              network_type: details.networkType,
              is_connected: details.isConnected,
              is_internet_reachable: details.isInternetReachable,
            },
            { device_id: pairing.deviceId },
          ),
        );
      } catch (error) {
        console.warn("[omniwork-app] network change control send failed", {
          reason,
          error: (error as Error)?.message,
        });
      }
    },
    isStrictP2p: () => transport.isStrictP2p(),
  };
}

function currentAppPlatform(): AppClientPlatform {
  switch (Platform.OS) {
    case "ios":
    case "android":
    case "web":
      return Platform.OS;
    default:
      return "desktop";
  }
}

export function subscribeNetworkChanges(
  handler: (event: NetworkChangeDetails) => void,
): () => void {
  const maybeWindow =
    typeof window === "undefined"
      ? null
      : (window as Window & {
          addEventListener?: Window["addEventListener"];
          removeEventListener?: Window["removeEventListener"];
        });
  const maybeNavigator =
    typeof navigator === "undefined"
      ? null
      : (navigator as Navigator & {
          connection?: {
            type?: string;
            effectiveType?: string;
            addEventListener?: (type: "change", listener: () => void) => void;
            removeEventListener?: (
              type: "change",
              listener: () => void,
            ) => void;
          };
        });

  const emit = () => {
    handler({
      networkType:
        maybeNavigator?.connection?.type ??
        maybeNavigator?.connection?.effectiveType,
      isConnected: maybeNavigator?.onLine,
    });
  };

  maybeWindow?.addEventListener?.("online", emit);
  maybeWindow?.addEventListener?.("offline", emit);
  maybeNavigator?.connection?.addEventListener?.("change", emit);

  return () => {
    maybeWindow?.removeEventListener?.("online", emit);
    maybeWindow?.removeEventListener?.("offline", emit);
    maybeNavigator?.connection?.removeEventListener?.("change", emit);
  };
}
