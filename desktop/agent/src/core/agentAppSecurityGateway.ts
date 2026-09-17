import {
  E2E_SUPPORT_V2,
  PROTOCOL_SUPPORT_V2,
  SIGNATURE_DOMAINS,
  agentAuthOkSignatureFields,
  appAuthSignatureFields,
  createMessage,
  identityMatchesPublicKey,
  innerToMessage,
  isE2EBusinessMessage,
  messageToInner,
  parseMessageEnvelope,
  signIdentityFields,
  verifyIdentityFields,
  type AgentAppMessage,
  type AppAuthorizationScope,
  type AppClientPlatform,
  type AppConnectionGoodbyePayload,
  type AppConnectionHeartbeatPayload,
  type AppConnectionObservation,
  type AuthFailedPayload,
  type AuthOkPayload,
  type AuthPendingPayload,
  type AuthVerifyPayload,
  type E2EHandshakeInitPayload,
  type E2EMessagePayload,
  type E2EReadyPayload,
  type E2EFailureReason,
  type MessageEnvelope,
  type P2pChannelKind,
  type ProtocolErrorPayload,
  type RelayAppDeliverPayload,
  type RelayAppDeliveryMessage,
} from "@omni-work/protocol-ts";
import {
  E2EError,
  acceptInitiatorHandshake,
  type E2ESession,
} from "@omni-work/e2e-noise";
import type { AgentConfig } from "../config/config.ts";
import type {
  TrustedAppRecord,
  TrustedAppStore,
} from "../config/trustedAppStore.ts";
import type { Logger } from "../telemetry/logger.ts";
import type { AgentSessionTransport } from "../transport/index.ts";
import { AuthReplayCache } from "./authReplayCache.ts";
import type { AppConnectionRegistry } from "./appConnectionRegistry.ts";
import type { AgentDispatchContext } from "./agentRuntimeTypes.ts";

interface AppE2EPeer {
  appConnectionId: string;
  session: E2ESession;
  ready: boolean;
}

interface AgentAppSecurityGatewayOptions {
  config: AgentConfig;
  logger: Logger;
  appConnections: AppConnectionRegistry;
  trustedApps: TrustedAppStore;
  getTransport(): AgentSessionTransport | null;
  getAgentConnectionId(): string | null;
  dispatchMessage(
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ): Promise<void>;
  onSupersededConnection(appConnectionId: string): void;
}

export interface PendingPairingRequest {
  requestId: string;
  appId: string;
  appPublicKey: string;
  appInfo: AuthVerifyPayload["app_info"];
  appName: string | null;
  deviceName: string | null;
  platform: AppClientPlatform | null;
  os: string | null;
  osVersion: string | null;
  remoteIp: string | null;
  ipSource:
    | NonNullable<AppConnectionObservation["network"]>["ip_source"]
    | null;
  requestedScopes: AppAuthorizationScope[];
  connectionId: string;
  createdAt: string;
  expiresAt: string;
}

export class AgentAppSecurityGateway {
  private readonly config: AgentConfig;
  private readonly logger: Logger;
  private readonly appConnections: AppConnectionRegistry;
  private readonly trustedApps: TrustedAppStore;
  private readonly getTransport: () => AgentSessionTransport | null;
  private readonly getAgentConnectionId: () => string | null;
  private readonly dispatchMessage: (
    message: MessageEnvelope,
    context?: AgentDispatchContext,
  ) => Promise<void>;
  private readonly onSupersededConnection: (appConnectionId: string) => void;
  private readonly e2ePeers = new Map<string, AppE2EPeer>();
  private readonly appIdByConnectionId = new Map<string, string>();
  private readonly authReplayCache = new AuthReplayCache();
  private readonly pendingPairings = new Map<
    string,
    {
      request: PendingPairingRequest;
      message: MessageEnvelope<AuthVerifyPayload>;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(options: AgentAppSecurityGatewayOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.appConnections = options.appConnections;
    this.trustedApps = options.trustedApps;
    this.getTransport = options.getTransport;
    this.getAgentConnectionId = options.getAgentConnectionId;
    this.dispatchMessage = options.dispatchMessage;
    this.onSupersededConnection = options.onSupersededConnection;
  }

  handleAuthVerify(message: MessageEnvelope<AuthVerifyPayload>): void {
    const { payload } = message;
    const authNonceKey = `${payload.app_id}|${payload.nonce}`;
    if (this.authReplayCache.has(authNonceKey)) {
      this.logger.warn("rejected replayed auth nonce");
      this.sendAuthFailure(payload.connection_id, "malformed_proof");
      return;
    }

    const agentConnectionId = this.getAgentConnectionId();
    if (!agentConnectionId) {
      this.sendAuthFailure(payload.connection_id, "agent_restarted");
      return;
    }
    if (
      payload.agent_connection_id !== agentConnectionId ||
      message.app_connection_id !== payload.connection_id ||
      payload.device_id !== this.config.deviceId ||
      payload.agent_public_key !== this.config.identity.publicKey ||
      !identityMatchesPublicKey("app", payload.app_id, payload.app_public_key)
    ) {
      this.sendAuthFailure(payload.connection_id, "identity_mismatch");
      return;
    }
    if (Math.abs(Date.now() - payload.timestamp) > 60_000) {
      this.sendAuthFailure(payload.connection_id, "malformed_proof");
      return;
    }
    const { signature, observations: _observations, ...unsigned } = payload;
    if (
      !verifyIdentityFields(
        payload.app_public_key,
        SIGNATURE_DOMAINS.appAuth,
        appAuthSignatureFields(unsigned),
        signature,
      )
    ) {
      this.sendAuthFailure(payload.connection_id, "invalid_signature");
      return;
    }

    const trusted = this.trustedApps.get(payload.app_id);
    if (trusted?.status === "active") {
      if (trusted.publicKey !== payload.app_public_key) {
        this.sendAuthFailure(payload.connection_id, "identity_mismatch");
        return;
      }
      this.authorizeApp(message, trusted);
      return;
    }
    if (this.config.appAuthorizationMode === "automatic") {
      this.authorizeApp(message, this.trustApp(payload));
      return;
    }

    const requestId = `pair_${payload.app_id}`;
    const existing = this.pendingPairings.get(requestId);
    if (existing) {
      clearTimeout(existing.timer);
    }
    const expiresAt = Date.now() + 2 * 60_000;
    const details = pendingPairingDetails(payload);
    const request: PendingPairingRequest = {
      requestId,
      appId: payload.app_id,
      appPublicKey: payload.app_public_key,
      appInfo: payload.app_info,
      ...details,
      requestedScopes: payload.requested_scopes,
      connectionId: payload.connection_id,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    };
    const timer = setTimeout(() => {
      const pending = this.pendingPairings.get(requestId);
      if (!pending) {
        return;
      }
      this.pendingPairings.delete(requestId);
      this.sendAuthFailure(payload.connection_id, "approval_timeout");
    }, 2 * 60_000);
    timer.unref?.();
    this.pendingPairings.set(requestId, { request, message, timer });
    this.send(
      createMessage<AuthPendingPayload>(
        "auth.pending",
        {
          connection_id: payload.connection_id,
          request_id: requestId,
          expires_at: request.expiresAt,
        },
        {
          device_id: this.config.deviceId,
          app_connection_id: payload.connection_id,
        },
      ),
    );
  }

  listPendingPairings(): PendingPairingRequest[] {
    return [...this.pendingPairings.values()]
      .map(({ request }) => structuredClone(request))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  listTrustedApps(): TrustedAppRecord[] {
    return this.trustedApps.list();
  }

  approvePairing(requestId: string): boolean {
    const pending = this.pendingPairings.get(requestId);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timer);
    this.pendingPairings.delete(requestId);
    if (Date.parse(pending.request.expiresAt) <= Date.now()) {
      this.sendAuthFailure(
        pending.message.payload.connection_id,
        "approval_timeout",
      );
      return false;
    }
    const { payload } = pending.message;
    const trusted = this.trustApp(payload);
    this.authorizeApp(pending.message, trusted);
    return true;
  }

  rejectPairing(requestId: string): boolean {
    const pending = this.pendingPairings.get(requestId);
    if (!pending) {
      return false;
    }
    clearTimeout(pending.timer);
    this.pendingPairings.delete(requestId);
    this.sendAuthFailure(
      pending.message.payload.connection_id,
      "approval_rejected",
    );
    return true;
  }

  revokeApp(appId: string): boolean {
    if (!this.trustedApps.revoke(appId)) {
      return false;
    }
    this.disconnectApp(appId);
    return true;
  }

  removeApp(appId: string): boolean {
    if (!this.trustedApps.remove(appId)) {
      return false;
    }
    for (const [requestId, pending] of this.pendingPairings) {
      if (pending.request.appId !== appId) {
        continue;
      }
      clearTimeout(pending.timer);
      this.pendingPairings.delete(requestId);
      this.sendAuthFailure(pending.request.connectionId, "revoked");
    }
    this.disconnectApp(appId);
    this.appConnections.removeApp(appId);
    return true;
  }

  private disconnectApp(appId: string): void {
    for (const [connectionId, connectedAppId] of this.appIdByConnectionId) {
      if (connectedAppId !== appId) {
        continue;
      }
      this.sendAuthFailure(connectionId, "revoked");
      this.appConnections.markGoodbye(connectionId, {
        sent_at: new Date().toISOString(),
        seq: 0,
        reason: "revoked",
      });
      this.detachSupersededAppConnection(connectionId);
    }
  }

  private authorizeApp(
    message: MessageEnvelope<AuthVerifyPayload>,
    trusted: TrustedAppRecord,
  ): void {
    const agentConnectionId = this.getAgentConnectionId();
    if (!agentConnectionId) {
      this.sendAuthFailure(message.payload.connection_id, "agent_restarted");
      return;
    }
    const payload = message.payload;
    this.authReplayCache.remember(`${payload.app_id}|${payload.nonce}`);
    this.appIdByConnectionId.set(payload.connection_id, payload.app_id);
    const result = this.appConnections.acceptAuthenticatedConnectionDetailed({
      relayConnectionId: payload.connection_id,
      appId: payload.app_id,
      appInfo: payload.app_info,
      observations: payload.observations,
    });
    if (result.previousRelayConnectionId) {
      this.detachSupersededAppConnection(result.previousRelayConnectionId);
    }
    this.trustedApps.markSeen(payload.app_id);

    const unsigned = {
      nonce: payload.nonce,
      device_id: this.config.deviceId,
      agent_public_key: this.config.identity.publicKey,
      app_id: payload.app_id,
      agent_connection_id: agentConnectionId,
      connection_id: payload.connection_id,
      granted_scopes: trusted.scopes,
      timestamp: Date.now(),
    };
    const authOk: AuthOkPayload = {
      ...unsigned,
      signature: signIdentityFields(
        this.config.identity.privateKey,
        SIGNATURE_DOMAINS.agentAuthOk,
        agentAuthOkSignatureFields(unsigned),
      ),
      e2e: this.e2eSupport(),
    };
    this.send(
      createMessage("auth.ok", authOk, {
        device_id: this.config.deviceId,
        app_connection_id: payload.connection_id,
      }),
    );
  }

  private trustApp(payload: AuthVerifyPayload): TrustedAppRecord {
    return this.trustedApps.approve({
      appId: payload.app_id,
      publicKey: payload.app_public_key,
      displayName: payload.app_info.device?.name ?? payload.app_info.app?.name,
      platform: payload.app_info.device?.platform,
      scopes: payload.requested_scopes,
    });
  }

  private sendAuthFailure(
    connectionId: string,
    reason: AuthFailedPayload["reason"],
  ): void {
    this.send(
      createMessage<AuthFailedPayload>(
        "auth.failed",
        {
          reason,
          connection_id: connectionId,
          retry_after_ms: 2000,
        },
        {
          device_id: this.config.deviceId,
          app_connection_id: connectionId,
        },
      ),
    );
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
    const agentConnectionId = this.getAgentConnectionId();
    if (
      !agentConnectionId ||
      message.payload.agent_connection_id !== agentConnectionId
    ) {
      this.logger.warn("rejected e2e handshake for unknown agent connection", {
        expected_agent_connection_id: agentConnectionId,
        received_agent_connection_id: message.payload.agent_connection_id,
      });
      return;
    }
    const trusted = this.trustedApps.get(message.payload.app_id);
    if (
      trusted?.status !== "active" ||
      trusted.publicKey !== message.payload.app_public_key
    ) {
      this.logger.warn("rejected e2e handshake from untrusted App", {
        app_id: message.payload.app_id,
        app_connection_id: message.payload.app_connection_id,
      });
      return;
    }
    try {
      const result = acceptInitiatorHandshake(
        {
          deviceId: this.config.deviceId,
          agentPublicKey: this.config.identity.publicKey,
          agentPrivateKey: this.config.identity.privateKey,
          appId: trusted.appId,
          appPublicKey: trusted.publicKey,
          agentConnectionId,
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
            v: PROTOCOL_SUPPORT_V2.current,
            e2e_version: E2E_SUPPORT_V2.versions[0],
            app_connection_id: message.payload.app_connection_id,
            handshake_id: message.payload.handshake_id,
            reason:
              error instanceof E2EError && error.code === "unsupported_suite"
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
      this.failE2ESession(
        message.payload.app_connection_id,
        "handshake_failed",
      );
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
        error instanceof E2EError &&
        (error.code === "decrypt_failed" || error.code === "replay_detected")
      ) {
        this.failE2ESession(message.payload.app_connection_id, error.code);
      }
    }
  }

  private failE2ESession(
    appConnectionId: string,
    reason: E2EFailureReason,
  ): void {
    this.send(
      createMessage(
        "e2e.failed",
        {
          v: PROTOCOL_SUPPORT_V2.current,
          e2e_version: E2E_SUPPORT_V2.versions[0],
          app_connection_id: appConnectionId,
          reason,
        },
        { device_id: this.config.deviceId },
      ),
    );
    this.appConnections.markGoodbye(appConnectionId, {
      sent_at: new Date().toISOString(),
      seq: 0,
      reason,
    });
    this.detachSupersededAppConnection(appConnectionId);
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
    options: { allowUnencryptedControl?: boolean } = {},
  ): boolean {
    if (
      !options.allowUnencryptedControl &&
      this.rejectUnencryptedBusiness(message, trustedE2E)
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

  rejectUnencryptedBusiness(
    message: MessageEnvelope,
    trustedE2E: boolean,
  ): boolean {
    if (trustedE2E) {
      return false;
    }
    this.logger.warn("rejected unencrypted business message", {
      message_type: message.type,
    });
    if (message.relay_context_id) {
      this.requestRelayAppDelivery(message.relay_context_id, {
        type: "protocol.error",
        session_id: message.session_id,
        surface_id: message.surface_id,
        payload: {
          v: PROTOCOL_SUPPORT_V2.current,
          code: "unencrypted_business_rejected",
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

  e2eSupport(): typeof E2E_SUPPORT_V2 {
    return E2E_SUPPORT_V2;
  }

  clearRelayAppConnectionState(): void {
    for (const pending of this.pendingPairings.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingPairings.clear();
    this.appIdByConnectionId.clear();
    this.e2ePeers.clear();
    this.appConnections.markRelayUnavailable();
  }

  detachSupersededAppConnection(appConnectionId: string): void {
    this.appIdByConnectionId.delete(appConnectionId);
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
    for (const peer of this.e2ePeers.values()) {
      if (peer.ready) {
        this.sendToAppByConnectionId(peer.appConnectionId, message);
      }
    }
  }
}

function pendingPairingDetails(
  payload: AuthVerifyPayload,
): Pick<
  PendingPairingRequest,
  | "appName"
  | "deviceName"
  | "platform"
  | "os"
  | "osVersion"
  | "remoteIp"
  | "ipSource"
> {
  const details: Pick<
    PendingPairingRequest,
    | "appName"
    | "deviceName"
    | "platform"
    | "os"
    | "osVersion"
    | "remoteIp"
    | "ipSource"
  > = {
    appName: payload.app_info.app?.name ?? null,
    deviceName: payload.app_info.device?.name ?? null,
    platform: payload.app_info.device?.platform ?? null,
    os: payload.app_info.device?.os ?? null,
    osVersion: payload.app_info.device?.os_version ?? null,
    remoteIp: null,
    ipSource: null,
  };

  for (const observation of payload.observations ?? []) {
    details.appName ??= observation.app?.name ?? null;
    details.deviceName ??= observation.device?.name ?? null;
    details.platform ??= observation.device?.platform ?? null;
    details.os ??= observation.device?.os ?? null;
    details.osVersion ??= observation.device?.os_version ?? null;
    if (
      observation.source === "relay" &&
      (observation.network?.public_ip || observation.network?.remote_ip)
    ) {
      details.remoteIp =
        observation.network.public_ip ?? observation.network.remote_ip ?? null;
      details.ipSource = observation.network.ip_source ?? null;
    }
  }
  return details;
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
