import { RelayClient, type RelayCloseEvent } from "@omniwork/relay-client";
import {
  E2E_SUPPORT_V1,
  PROTOCOL_SUPPORT_V1,
  createMessage,
  innerToMessage,
  isE2EBusinessMessage,
  messageToInner,
  parseMessageEnvelope,
  type AppConnectionGoodbyePayload,
  type AppConnectionHeartbeatPayload,
  type AuthChallengePayload,
  type AuthOkPayload,
  type BusinessSecurityMode,
  type E2EHandshakeReplyPayload,
  type E2EMessagePayload,
  type E2EReadyPayload,
  type AppInfoPayload,
  type AppClientPlatform,
  type MessageEnvelope,
  type TransportPath,
  type TransportPreference,
} from "@omniwork/protocol-ts";
import {
  E2ENoiseError,
  createInitiatorHandshake,
  type E2ENoiseSession,
  type InitiatorHandshakeState,
} from "@omniwork/e2e-noise";
import type { PairingConfig } from "../../features/auth/types";
import { createKeyProof } from "../../features/auth/keyProof.ts";
import { createAppInfo } from "../../app/appMetadata.ts";

export interface MobileRelaySessionOptions {
  /**
   * App 端在 mobile.connect 中向 Relay 声明的传输偏好；缺省由 Relay 视为 "auto"。
   * 详见 docs/relay-architecture.md "传输偏好可控"小节。
   */
  transportPreference?: TransportPreference;
  appMetadata?: {
    name?: string;
    platform?: AppClientPlatform;
    version?: string;
    deviceName?: string;
    capabilities?: string[];
  };
}

export class MobileRelaySession {
  private readonly client: RelayClient;
  private readonly pairing: PairingConfig;
  private readonly options: MobileRelaySessionOptions;
  private readonly handlers = new Set<(message: MessageEnvelope) => void>();
  private readonly businessReadyHandlers = new Set<() => void>();
  private e2eHandshake: InitiatorHandshakeState | null = null;
  private e2eSession: E2ENoiseSession | null = null;
  private e2ePeerReady = false;
  private businessSecurityMode: BusinessSecurityMode = "e2e_required";
  private plaintextReady = false;
  private pendingKeyId: string | null = null;
  private appConnectionId: string | null = null;
  private readonly appInstanceId: string;
  private readonly appRuntimeId = createRuntimeId("runtime");
  private connectionHeartbeatSeq = 0;
  private connectionHeartbeatMs = 10000;
  private connectionHeartbeatTimer: ReturnType<typeof setInterval> | null =
    null;
  private currentPath: TransportPath | "unknown" = "relay";
  private pendingBusinessMessages: MessageEnvelope[] = [];

  constructor(pairing: PairingConfig, options: MobileRelaySessionOptions = {}) {
    this.pairing = pairing;
    this.appInstanceId = pairing.appInstanceId ?? createRuntimeId("app");
    this.client = new RelayClient({ url: pairing.relayUrl });
    this.options = options;
  }

  async connect(): Promise<void> {
    this.client.onMessage((message) => {
      this.handleMessage(message).catch(() => {
        // The screen layer owns user-visible error reporting.
      });
    });
    await this.client.connect();
    this.client.send(
      createMessage(
        "mobile.connect",
        {
          v: PROTOCOL_SUPPORT_V1.current,
          device_id: this.pairing.deviceId,
          key_id: this.pairing.keyId ?? "unknown",
          app_info: this.appInfo(),
          protocol: PROTOCOL_SUPPORT_V1,
          e2e: E2E_SUPPORT_V1,
          ...(this.options.transportPreference
            ? { transport_preference: this.options.transportPreference }
            : {}),
        },
        { device_id: this.pairing.deviceId },
      ),
    );
  }

  onMessage(handler: (message: MessageEnvelope) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onClose(handler: (event: RelayCloseEvent) => void): () => void {
    return this.client.onClose(handler);
  }

  onBusinessReady(handler: () => void): () => void {
    this.businessReadyHandlers.add(handler);
    return () => this.businessReadyHandlers.delete(handler);
  }

  send(message: MessageEnvelope): void {
    const encoded = this.encodeOutgoingMessage(message, {
      queueIfNotReady: true,
    });
    if (!encoded) {
      return;
    }
    this.client.send(encoded);
  }

  encodeForP2p(message: MessageEnvelope): MessageEnvelope | null {
    return this.encodeOutgoingMessage(message, { queueIfNotReady: false });
  }

  receiveFromP2p(message: MessageEnvelope): void {
    this.handleMessage(message).catch(() => {
      // The screen layer owns user-visible error reporting.
    });
  }

  private encodeOutgoingMessage(
    message: MessageEnvelope,
    options: { queueIfNotReady: boolean },
  ): MessageEnvelope | null {
    if (isE2EBusinessMessage(message.type)) {
      if (this.businessSecurityMode === "plaintext_allowed") {
        if (!this.plaintextReady) {
          if (options.queueIfNotReady) {
            this.pendingBusinessMessages.push(message);
          }
          return null;
        }
        return message;
      }
      if (!this.e2eSession || !this.e2ePeerReady) {
        if (options.queueIfNotReady) {
          this.pendingBusinessMessages.push(message);
        }
        return null;
      }
      return createMessage(
        "e2e.message",
        this.e2eSession.encrypt(messageToInner(message)).payload,
        {
          device_id: this.pairing.deviceId,
        },
      );
    }
    return message;
  }

  close(): void {
    this.sendConnectionGoodbye("client_closing");
    this.stopConnectionHeartbeat();
    this.client.close();
  }

  getAppConnectionId(): string | null {
    return this.appConnectionId;
  }

  setConnectionPath(path: TransportPath): void {
    this.currentPath = path;
  }

  private async handleMessage(message: MessageEnvelope): Promise<void> {
    switch (message.type) {
      case "auth.challenge":
        await this.handleAuthChallenge(message.payload as AuthChallengePayload);
        return;
      case "auth.ok":
        this.handleAuthOk(message.payload as AuthOkPayload);
        this.dispatch(message);
        return;
      case "e2e.handshake.reply":
        this.handleE2EHandshakeReply(
          message.payload as E2EHandshakeReplyPayload,
        );
        return;
      case "e2e.ready":
        this.handleE2EReady(message.payload as E2EReadyPayload);
        return;
      case "e2e.message":
        this.handleE2EMessage(message.payload as E2EMessagePayload);
        return;
      case "tunnel.upgrade.propose":
        this.dispatchRelayUpgradeControl(message);
        return;
      case "tunnel.upgrade.downgrade":
        this.dispatchRelayUpgradeControl(message);
        return;
      default:
        if (
          isE2EBusinessMessage(message.type) &&
          this.businessSecurityMode === "e2e_required"
        ) {
          return;
        }
        this.dispatch(message);
    }
  }

  private async handleAuthChallenge(
    challenge: AuthChallengePayload,
  ): Promise<void> {
    this.pendingKeyId = challenge.key_id;
    const proof = await createKeyProof(
      this.pairing.key,
      challenge.nonce,
      this.appInfo(),
    );
    this.client.send(
      createMessage(
        "auth.proof",
        {
          key_id: challenge.key_id,
          nonce: challenge.nonce,
          app_info: this.appInfo(),
          proof,
        },
        { device_id: this.pairing.deviceId },
      ),
    );
  }

  private handleAuthOk(payload: AuthOkPayload): void {
    const keyId = this.pendingKeyId ?? this.pairing.keyId ?? "unknown";
    if (!payload.connection_id) {
      return;
    }
    this.appConnectionId = payload.connection_id;
    this.businessSecurityMode =
      payload.business_security_mode ?? "e2e_required";
    if (this.businessSecurityMode === "plaintext_allowed") {
      this.plaintextReady = true;
      this.startConnectionHeartbeat();
      this.dispatchBusinessReady();
      this.flushPendingBusinessMessages();
      return;
    }
    this.e2eHandshake = createInitiatorHandshake({
      pairingKey: this.pairing.key,
      deviceId: this.pairing.deviceId,
      keyId,
      agentInstanceId: payload.agent_instance_id,
      appConnectionId: payload.connection_id,
    });
    this.client.send(
      createMessage("e2e.handshake.init", this.e2eHandshake.init, {
        device_id: this.pairing.deviceId,
      }),
    );
  }

  private handleE2EHandshakeReply(payload: E2EHandshakeReplyPayload): void {
    if (!this.e2eHandshake) {
      return;
    }
    this.e2eSession = this.e2eHandshake.complete(payload);
    this.e2eHandshake = null;
    this.client.send(
      createMessage("e2e.ready", this.e2eSession.readyPayload(), {
        device_id: this.pairing.deviceId,
      }),
    );
  }

  private handleE2EReady(payload: E2EReadyPayload): void {
    if (
      !this.e2eSession ||
      payload.app_connection_id !== this.appConnectionId ||
      payload.handshake_id !== this.e2eSession.handshakeId ||
      payload.transcript_hash !== this.e2eSession.transcriptHash
    ) {
      this.e2eSession = null;
      this.e2ePeerReady = false;
      return;
    }
    this.e2ePeerReady = true;
    this.startConnectionHeartbeat();
    this.dispatchBusinessReady();
    this.flushPendingBusinessMessages();
  }

  private handleE2EMessage(payload: E2EMessagePayload): void {
    if (
      !this.e2eSession ||
      !this.e2ePeerReady ||
      payload.app_connection_id !== this.appConnectionId
    ) {
      return;
    }
    try {
      const message = parseMessageEnvelope(
        innerToMessage(this.e2eSession.decrypt(payload), this.pairing.deviceId),
      );
      if (message) {
        this.dispatch(message);
      }
    } catch (error) {
      if (
        error instanceof E2ENoiseError &&
        (error.code === "decrypt_failed" || error.code === "replay_detected")
      ) {
        this.e2eSession = null;
        this.e2ePeerReady = false;
      }
    }
  }

  private flushPendingBusinessMessages(): void {
    const pending = this.pendingBusinessMessages;
    this.pendingBusinessMessages = [];
    for (const message of pending) {
      this.send(message);
    }
  }

  private dispatchBusinessReady(): void {
    for (const handler of this.businessReadyHandlers) {
      handler();
    }
  }

  private dispatchRelayUpgradeControl(message: MessageEnvelope): void {
    const payload = message.payload as { app_connection_id?: string };
    if (
      this.appConnectionId &&
      payload.app_connection_id === this.appConnectionId
    ) {
      this.dispatch(message);
    }
  }

  private dispatch(message: MessageEnvelope): void {
    for (const handler of this.handlers) {
      handler(message);
    }
  }

  private sendConnectionHeartbeat(): void {
    const payload: AppConnectionHeartbeatPayload = {
      sent_at: new Date().toISOString(),
      seq: this.nextConnectionHeartbeatSeq(),
      current_path: this.currentPath,
    };
    this.sendConnectionLifecycleMessage(
      createMessage("app.connection.heartbeat", payload, {
        device_id: this.pairing.deviceId,
      }),
    );
  }

  private sendConnectionGoodbye(reason: string): void {
    const payload: AppConnectionGoodbyePayload = {
      sent_at: new Date().toISOString(),
      seq: this.nextConnectionHeartbeatSeq(),
      reason,
    };
    this.sendConnectionLifecycleMessage(
      createMessage("app.connection.goodbye", payload, {
        device_id: this.pairing.deviceId,
      }),
    );
  }

  private sendConnectionLifecycleMessage(message: MessageEnvelope): void {
    try {
      this.send(message);
    } catch (error) {
      console.warn("[omniwork-app] connection lifecycle send failed", {
        type: message.type,
        error: (error as Error)?.message,
      });
    }
  }

  private startConnectionHeartbeat(): void {
    this.stopConnectionHeartbeat();
    this.connectionHeartbeatTimer = setInterval(() => {
      this.sendConnectionHeartbeat();
    }, this.connectionHeartbeatMs);
    this.connectionHeartbeatTimer.unref?.();
  }

  private stopConnectionHeartbeat(): void {
    if (this.connectionHeartbeatTimer) {
      clearInterval(this.connectionHeartbeatTimer);
      this.connectionHeartbeatTimer = null;
    }
  }

  private nextConnectionHeartbeatSeq(): number {
    this.connectionHeartbeatSeq += 1;
    return this.connectionHeartbeatSeq;
  }

  private appInfo(): AppInfoPayload {
    return createAppInfo(
      this.appInstanceId,
      this.appRuntimeId,
      this.options.appMetadata,
    );
  }
}

function createRuntimeId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 12);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}
