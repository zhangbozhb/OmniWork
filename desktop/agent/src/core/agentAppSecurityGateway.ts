import {
  E2E_SUPPORT_V1,
  PROTOCOL_SUPPORT_V1,
  createMessage,
  innerToMessage,
  isE2EBusinessMessage,
  messageToInner,
  parseMessageEnvelope,
  type AgentAppMessage,
  type AppConnectionGoodbyePayload,
  type AppConnectionHeartbeatPayload,
  type AuthVerifyPayload,
  type E2EHandshakeInitPayload,
  type E2EMessagePayload,
  type E2EReadyPayload,
  type MessageEnvelope,
  type P2pChannelKind,
  type ProtocolErrorPayload,
  type RelayAppDeliverPayload,
  type RelayAppDeliveryMessage,
} from "@omniwork/protocol-ts";
import {
  E2ENoiseError,
  acceptInitiatorHandshake,
  type E2ENoiseSession,
} from "@omniwork/e2e-noise";
import type { AgentConfig } from "../config/config.ts";
import { verifyProof, type SessionKeyRecord } from "../auth-key/authKey.ts";
import type { Logger } from "../telemetry/logger.ts";
import type { AgentSessionTransport } from "../transport/index.ts";
import { AuthReplayCache } from "./authReplayCache.ts";
import type { AppConnectionRegistry } from "./appConnectionRegistry.ts";
import type { AgentDispatchContext } from "./agentRuntimeTypes.ts";

interface AppE2EPeer {
  appConnectionId: string;
  session: E2ENoiseSession;
  ready: boolean;
}

interface AgentAppSecurityGatewayOptions {
  config: AgentConfig;
  logger: Logger;
  appConnections: AppConnectionRegistry;
  getTransport(): AgentSessionTransport | null;
  getKeyRecord(): SessionKeyRecord;
  dispatchMessage(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ): Promise<void>;
  onSupersededConnection(appConnectionId: string): void;
}

export class AgentAppSecurityGateway {
  private readonly config: AgentConfig;
  private readonly logger: Logger;
  private readonly appConnections: AppConnectionRegistry;
  private readonly getTransport: () => AgentSessionTransport | null;
  private readonly getKeyRecord: () => SessionKeyRecord;
  private readonly dispatchMessage: (
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ) => Promise<void>;
  private readonly onSupersededConnection: (appConnectionId: string) => void;
  private readonly e2ePeers = new Map<string, AppE2EPeer>();
  private readonly authenticatedAppConnectionIds = new Set<string>();
  private readonly authReplayCache = new AuthReplayCache();

  constructor(options: AgentAppSecurityGatewayOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.appConnections = options.appConnections;
    this.getTransport = options.getTransport;
    this.getKeyRecord = options.getKeyRecord;
    this.dispatchMessage = options.dispatchMessage;
    this.onSupersededConnection = options.onSupersededConnection;
  }

  handleAuthVerify(message: MessageEnvelope<AuthVerifyPayload>): void {
    const keyRecord = this.getKeyRecord();
    const authNonceKey = `${message.payload.key_id}:${message.payload.nonce}`;
    if (this.authReplayCache.has(authNonceKey)) {
      this.logger.warn("rejected replayed auth nonce", {
        key_id: message.payload.key_id,
      });
      this.send(
        createMessage(
          "auth.failed",
          {
            reason: "malformed_proof",
            connection_id: message.payload.connection_id,
            retry_after_ms: 2000,
          },
          { device_id: this.config.deviceId },
        ),
      );
      return;
    }

    const valid =
      message.payload.key_id === keyRecord.key_id &&
      verifyProof(
        keyRecord.key,
        message.payload.nonce,
        message.payload.app_info,
        message.payload.proof,
      );

    if (valid) {
      this.authReplayCache.remember(authNonceKey);
      if (message.payload.connection_id) {
        this.authenticatedAppConnectionIds.add(message.payload.connection_id);
        const result =
          this.appConnections.acceptAuthenticatedConnectionDetailed({
            relayConnectionId: message.payload.connection_id,
            keyId: keyRecord.key_id,
            appInfo: message.payload.app_info,
            observations: message.payload.observations,
          });
        if (result.previousRelayConnectionId) {
          this.detachSupersededAppConnection(result.previousRelayConnectionId);
        }
      }
      this.send(
        createMessage(
          "auth.ok",
          {
            agent_instance_id: keyRecord.agent_instance_id,
            connection_id: message.payload.connection_id,
            business_security_mode: this.config.businessSecurityMode,
            e2e: this.e2eSupport(),
          },
          { device_id: this.config.deviceId },
        ),
      );
    } else {
      this.send(
        createMessage(
          "auth.failed",
          {
            reason: "key_mismatch",
            connection_id: message.payload.connection_id,
            retry_after_ms: 2000,
          },
          { device_id: this.config.deviceId },
        ),
      );
    }
  }

  handleConnectionHeartbeat(
    message: MessageEnvelope<AppConnectionHeartbeatPayload>,
    context: AgentDispatchContext | undefined,
    trustedE2E: boolean,
  ): void {
    if (!context) {
      return;
    }
    if (!this.recordInboundBusiness(message, context, trustedE2E)) {
      return;
    }
    this.appConnections.acceptHeartbeat(
      context.appConnectionId,
      message.payload,
    );
  }

  handleConnectionGoodbye(
    message: MessageEnvelope<AppConnectionGoodbyePayload>,
    context: AgentDispatchContext | undefined,
    trustedE2E: boolean,
  ): void {
    if (!context) {
      return;
    }
    if (!this.recordInboundBusiness(message, context, trustedE2E)) {
      return;
    }
    this.appConnections.markGoodbye(context.appConnectionId, message.payload);
  }

  handleE2EHandshakeInit(
    message: MessageEnvelope<E2EHandshakeInitPayload>,
  ): void {
    if (
      !this.appConnections.hasAuthenticatedConnection(
        message.payload.app_connection_id,
      )
    ) {
      this.logger.warn("rejected e2e handshake before authenticated tracking", {
        app_connection_id: message.payload.app_connection_id,
      });
      return;
    }
    const keyRecord = this.getKeyRecord();
    try {
      const result = acceptInitiatorHandshake(
        {
          pairingKey: keyRecord.key,
          deviceId: this.config.deviceId,
          keyId: keyRecord.key_id,
          agentInstanceId: keyRecord.agent_instance_id,
          appConnectionId: message.payload.app_connection_id,
          handshakeId: message.payload.handshake_id,
        },
        message.payload,
      );
      const peer: AppE2EPeer = {
        appConnectionId: message.payload.app_connection_id,
        session: result.session,
        ready: false,
      };
      this.e2ePeers.set(peer.appConnectionId, peer);
      this.send(
        createMessage("e2e.handshake.reply", result.reply, {
          device_id: this.config.deviceId,
        }),
      );
      this.send(
        createMessage("e2e.ready", result.session.readyPayload(), {
          device_id: this.config.deviceId,
        }),
      );
      this.logger.info("e2e handshake accepted", {
        handshake_id: result.reply.handshake_id,
        e2e_session_id: result.session.sessionId,
      });
    } catch (error) {
      this.e2ePeers.delete(message.payload.app_connection_id);
      this.logger.warn("e2e handshake failed", { error: String(error) });
      this.send(
        createMessage(
          "e2e.failed",
          {
            v: PROTOCOL_SUPPORT_V1.current,
            e2e_version: E2E_SUPPORT_V1.versions[0],
            app_connection_id: message.payload.app_connection_id,
            handshake_id: message.payload.handshake_id,
            reason:
              error instanceof E2ENoiseError &&
              error.code === "unsupported_suite"
                ? "unsupported_suite"
                : "handshake_failed",
          },
          { device_id: this.config.deviceId },
        ),
      );
    }
  }

  handleE2EReady(message: MessageEnvelope<E2EReadyPayload>): void {
    const peer = this.e2ePeers.get(message.payload.app_connection_id);
    if (!peer) {
      this.logger.warn("e2e ready without active session", {
        app_connection_id: message.payload.app_connection_id,
        handshake_id: message.payload.handshake_id,
      });
      return;
    }
    if (
      message.payload.handshake_id !== peer.session.handshakeId ||
      message.payload.transcript_hash !== peer.session.transcriptHash
    ) {
      this.logger.warn("e2e ready transcript mismatch", {
        app_connection_id: message.payload.app_connection_id,
        handshake_id: message.payload.handshake_id,
      });
      this.e2ePeers.delete(message.payload.app_connection_id);
      return;
    }
    peer.ready = true;
    this.appConnections.markE2EReady(message.payload.app_connection_id);
    this.logger.info("e2e ready confirmed", {
      app_connection_id: message.payload.app_connection_id,
      handshake_id: message.payload.handshake_id,
      e2e_session_id: peer.session.sessionId,
    });
  }

  async handleE2EMessage(
    message: MessageEnvelope<E2EMessagePayload>,
  ): Promise<void> {
    const peer = this.e2ePeers.get(message.payload.app_connection_id);
    if (!peer?.ready) {
      this.logger.warn("e2e message without active session", {
        app_connection_id: message.payload.app_connection_id,
        e2e_session_id: message.payload.e2e_session_id,
      });
      return;
    }
    try {
      const inner = peer.session.decrypt(message.payload);
      const decoded = parseMessageEnvelope(
        innerToMessage(inner, this.config.deviceId),
      );
      if (!decoded) {
        this.logger.warn("rejected invalid e2e business message", {
          app_connection_id: message.payload.app_connection_id,
        });
        return;
      }
      this.appConnections.markE2EReady(message.payload.app_connection_id);
      await this.dispatchMessage(decoded, {
        appConnectionId: message.payload.app_connection_id,
        trustedE2E: true,
      });
    } catch (error) {
      this.logger.warn("failed to decrypt e2e message", {
        error: String(error),
      });
      if (
        error instanceof E2ENoiseError &&
        (error.code === "decrypt_failed" || error.code === "replay_detected")
      ) {
        this.e2ePeers.delete(message.payload.app_connection_id);
      }
    }
  }

  recordInboundBusiness(
    message: MessageEnvelope,
    context: AgentDispatchContext | undefined,
    trustedE2E: boolean,
  ): boolean {
    return this.recordInboundBusinessForConnection(
      message,
      context?.appConnectionId ?? appConnectionIdFromMessage(message),
      trustedE2E,
    );
  }

  recordInboundBusinessForConnection(
    message: MessageEnvelope,
    appConnectionId: string | undefined,
    trustedE2E: boolean,
    options: { skipPlaintextReject?: boolean } = {},
  ): boolean {
    if (
      !options.skipPlaintextReject &&
      this.rejectPlaintextBusiness(message, trustedE2E)
    ) {
      return false;
    }
    if (!appConnectionId) {
      this.logger.warn("rejected business message without app connection", {
        message_type: message.type,
      });
      return false;
    }
    if (!this.appConnections.hasAuthenticatedConnection(appConnectionId)) {
      this.logger.warn(
        "rejected business message before authenticated tracking",
        {
          app_connection_id: appConnectionId,
          message_type: message.type,
        },
      );
      return false;
    }
    this.appConnections.recordMessage(
      appConnectionId,
      "in",
      trustedE2E,
      estimateEnvelopeBytes(message),
    );
    return true;
  }

  rejectPlaintextBusiness(
    message: MessageEnvelope,
    trustedE2E: boolean,
  ): boolean {
    if (
      trustedE2E ||
      this.config.businessSecurityMode === "plaintext_allowed"
    ) {
      return false;
    }
    this.logger.warn("rejected plaintext business message", {
      message_type: message.type,
    });
    if (message.relay_context_id) {
      this.requestRelayAppDelivery(message.relay_context_id, {
        type: "protocol.error",
        session_id: message.session_id,
        surface_id: message.surface_id,
        payload: {
          v: PROTOCOL_SUPPORT_V1.current,
          code: "plaintext_business_rejected",
          detail: `Message type "${message.type}" must be sent inside e2e.message.`,
          retryable: false,
        } satisfies ProtocolErrorPayload,
      });
    }
    return true;
  }

  send(message: MessageEnvelope): void {
    const transport = this.getTransport();
    if (!transport) {
      this.logger.warn("cannot send without transport", {
        message_type: message.type,
      });
      return;
    }

    if (isE2EBusinessMessage(message.type)) {
      this.broadcastToReadyApps(message);
      return;
    }

    transport.send(message);
  }

  sendToApp(
    context: AgentDispatchContext | undefined,
    message: MessageEnvelope,
  ): void {
    if (!context) {
      this.logger.warn("dropped app-scoped message without context", {
        message_type: message.type,
      });
      return;
    }
    this.sendToAppByConnectionId(context.appConnectionId, message);
  }

  sendToAppByConnectionId(
    appConnectionId: string,
    message: MessageEnvelope,
    channel?: P2pChannelKind,
    options: { strictBypass?: boolean } = {},
  ): void {
    const transport = this.getTransport();
    if (!transport) {
      this.logger.warn("cannot send without transport", {
        message_type: message.type,
      });
      return;
    }
    if (!this.appConnections.hasAuthenticatedConnection(appConnectionId)) {
      this.logger.warn(
        "dropped app-scoped message before authenticated tracking",
        {
          app_connection_id: appConnectionId,
          message_type: message.type,
        },
      );
      return;
    }
    const peer = this.e2ePeers.get(appConnectionId);
    if (this.config.businessSecurityMode === "plaintext_allowed") {
      this.appConnections.recordMessage(
        appConnectionId,
        "out",
        false,
        estimateEnvelopeBytes(message),
      );
      transport.send(
        {
          ...message,
          app_connection_id: appConnectionId,
        },
        channel,
        options,
      );
      return;
    }
    if (!peer?.ready) {
      this.logger.warn("dropped business message without ready app e2e peer", {
        app_connection_id: appConnectionId,
        message_type: message.type,
      });
      return;
    }
    const encrypted = peer.session.encrypt(messageToInner(message));
    this.appConnections.recordMessage(
      appConnectionId,
      "out",
      true,
      estimateEnvelopeBytes(message),
    );
    transport.send(
      createMessage("e2e.message", encrypted.payload, {
        device_id: this.config.deviceId,
      }),
      channel,
      options,
    );
  }

  broadcastAgentMessage(message: AgentAppMessage): void {
    this.send(
      createMessage("agent.message", message, {
        device_id: this.config.deviceId,
        session_id: message.session_id,
        surface_id: message.surface_id,
      }),
    );
  }

  hasReadyE2EPeer(appConnectionId: string): boolean {
    return this.e2ePeers.get(appConnectionId)?.ready === true;
  }

  e2eSupport(): typeof E2E_SUPPORT_V1 {
    return {
      ...E2E_SUPPORT_V1,
      required: this.config.businessSecurityMode === "e2e_required",
    };
  }

  clearRelayAppConnectionState(): void {
    this.authenticatedAppConnectionIds.clear();
    this.e2ePeers.clear();
    this.appConnections.markRelayUnavailable();
  }

  detachSupersededAppConnection(appConnectionId: string): void {
    this.authenticatedAppConnectionIds.delete(appConnectionId);
    this.e2ePeers.delete(appConnectionId);
    this.onSupersededConnection(appConnectionId);
    this.logger.info("superseded app connection detached", {
      app_connection_id: appConnectionId,
    });
  }

  private requestRelayAppDelivery(
    relayContextId: string,
    message: RelayAppDeliveryMessage,
  ): void {
    const transport = this.getTransport();
    if (!transport) {
      this.logger.warn("cannot request relay app delivery without transport", {
        relay_context_id: relayContextId,
        message_type: message.type,
      });
      return;
    }
    transport.send(
      createMessage<RelayAppDeliverPayload>(
        "relay.app.deliver",
        {
          relay_context_id: relayContextId,
          message,
        },
        { device_id: this.config.deviceId },
      ),
    );
  }

  private broadcastToReadyApps(message: MessageEnvelope): void {
    if (this.config.businessSecurityMode === "plaintext_allowed") {
      for (const appConnectionId of this.authenticatedAppConnectionIds) {
        this.sendToAppByConnectionId(appConnectionId, message);
      }
      return;
    }
    for (const peer of this.e2ePeers.values()) {
      if (peer.ready) {
        this.sendToAppByConnectionId(peer.appConnectionId, message);
      }
    }
  }
}

function appConnectionIdFromMessage(
  message: MessageEnvelope,
): string | undefined {
  const payload = message.payload as { app_connection_id?: unknown };
  return typeof payload.app_connection_id === "string"
    ? payload.app_connection_id
    : undefined;
}

function estimateEnvelopeBytes(message: MessageEnvelope): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}
