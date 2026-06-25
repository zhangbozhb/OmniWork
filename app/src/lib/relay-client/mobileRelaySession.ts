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
import { createSha256Hex } from "../../features/auth/hmacSha256.ts";
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
    os?: string;
    osVersion?: string;
    privateNetworkHash?: string;
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
  private appInfoCache: AppInfoPayload | null = null;
  private appInfoPromise: Promise<AppInfoPayload> | null = null;

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
    const appInfo = await this.appInfo();
    this.client.send(
      createMessage(
        "mobile.connect",
        {
          v: PROTOCOL_SUPPORT_V1.current,
          device_id: this.pairing.deviceId,
          key_id: this.pairing.keyId ?? "unknown",
          app_info: appInfo,
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
    const appInfo = await this.appInfo();
    const proof = await createKeyProof(
      this.pairing.key,
      challenge.nonce,
      appInfo,
    );
    this.client.send(
      createMessage(
        "auth.proof",
        {
          key_id: challenge.key_id,
          nonce: challenge.nonce,
          app_info: appInfo,
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

  private async appInfo(): Promise<AppInfoPayload> {
    if (this.appInfoCache) {
      return this.appInfoCache;
    }
    if (!this.appInfoPromise) {
      this.appInfoPromise = collectAppPrivateNetworkHash().then(
        (privateNetworkHash) =>
          createAppInfo(this.appInstanceId, this.appRuntimeId, {
            ...this.options.appMetadata,
            privateNetworkHash:
              this.options.appMetadata?.privateNetworkHash ??
              privateNetworkHash,
          }),
      );
    }
    this.appInfoCache = await this.appInfoPromise;
    return this.appInfoCache;
  }
}

function createRuntimeId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 12);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

async function collectAppPrivateIps(timeoutMs = 700): Promise<string[]> {
  const RTCPeerConnectionCtor = loadRTCPeerConnection();
  if (!RTCPeerConnectionCtor) {
    return [];
  }
  const ips = new Set<string>();
  let pc: any;
  try {
    pc = new RTCPeerConnectionCtor({ iceServers: [] });
    pc.createDataChannel?.("omniwork-ip-probe");
    pc.onicecandidate = (event: { candidate?: { candidate?: string } }) => {
      addCandidatePrivateIp(ips, event.candidate?.candidate);
    };
    const offer = await pc.createOffer();
    addCandidatePrivateIp(ips, offer?.sdp);
    await pc.setLocalDescription(offer);
    addCandidatePrivateIp(ips, pc.localDescription?.sdp);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timer);
          resolve();
        }
      };
    });
    addCandidatePrivateIp(ips, pc.localDescription?.sdp);
  } catch {
    return [];
  } finally {
    try {
      pc?.close?.();
    } catch {
      /* ignore */
    }
  }
  return [...ips];
}

async function collectAppPrivateNetworkHash(): Promise<string | undefined> {
  const ips = await collectAppPrivateIps();
  return createPrivateNetworkHash(ips);
}

export function createPrivateNetworkHash(ips: string[]): string | undefined {
  const input = ips.sort().join(",");
  return input ? createSha256Hex(input) : undefined;
}

function loadRTCPeerConnection(): any | null {
  const globalPeerConnection = (
    globalThis as unknown as { RTCPeerConnection?: unknown }
  ).RTCPeerConnection;
  if (globalPeerConnection) {
    return globalPeerConnection;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("react-native-webrtc") as {
      RTCPeerConnection?: unknown;
    };
    return mod.RTCPeerConnection ?? null;
  } catch {
    return null;
  }
}

function addCandidatePrivateIp(ips: Set<string>, value: string | undefined) {
  if (!value) {
    return;
  }
  for (const line of value.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const typIndex = parts.indexOf("typ");
    if (typIndex === -1 || parts[typIndex + 1] !== "host") {
      continue;
    }
    const candidateIndex = parts.findIndex((part) =>
      part.startsWith("candidate:"),
    );
    const address = candidateIndex >= 0 ? parts[candidateIndex + 4] : undefined;
    if (address && isPrivateIp(address)) {
      ips.add(address);
    }
  }
}

function isPrivateIp(value: string): boolean {
  if (value.endsWith(".local")) {
    return false;
  }
  if (isIpv6Address(value)) {
    return isPrivateIpv6(value);
  }
  if (!isIpv4Address(value)) {
    return false;
  }
  const [a = 0, b = 0] = value.split(".").map((part) => Number(part));
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function isIpv4Address(value: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    return false;
  }
  return value.split(".").every((part) => {
    const octet = Number(part);
    return Number.isInteger(octet) && octet >= 0 && octet <= 255;
  });
}

function isIpv6Address(value: string): boolean {
  return value.includes(":");
}

function isPrivateIpv6(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  );
}
