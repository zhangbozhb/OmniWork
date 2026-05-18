import {
  RelayClient,
  type RelayCloseEvent,
  type WebRtcPeerConnectionFactory,
  type WebRtcPeerConnectionLike,
  DataChannelEnvelopeTransport,
  candidateToInit,
} from "../../../../packages/relay-client/src/index.ts";
import {
  createMessage,
  type AuthChallengePayload,
  type MessageEnvelope,
  type TunnelIceCandidatePayload,
  type TunnelMobileJoinPayload,
  type TunnelSessionDescriptionPayload,
  type TunnelSessionFailedPayload,
} from "../../../../packages/protocol-ts/src/index.ts";
import type { PairingConfig } from "../../features/auth/types";
import { createKeyProof } from "../../features/auth/keyProof";
import { createPeerConnectionFactory } from "../../platform/webrtc/createPeerConnection";

export interface AppWebRtcTunnelSessionOptions {
  signalingUrl?: string;
  peerConnectionFactory?: WebRtcPeerConnectionFactory;
}

export class AppWebRtcTunnelSession {
  private readonly signaling: RelayClient;
  private readonly peerConnectionFactory: WebRtcPeerConnectionFactory;
  private readonly messageHandlers = new Set<
    (message: MessageEnvelope) => void
  >();
  private readonly closeHandlers = new Set<(event: RelayCloseEvent) => void>();
  private peer: WebRtcPeerConnectionLike | null = null;
  private dataTransport: DataChannelEnvelopeTransport | null = null;
  private sessionId: string | null = null;

  constructor(
    private readonly pairing: PairingConfig,
    options: AppWebRtcTunnelSessionOptions = {},
  ) {
    const signalingUrl =
      options.signalingUrl ?? toTunnelMobileUrl(pairing.relayUrl);
    this.signaling = new RelayClient({
      url: signalingUrl,
    });
    this.peerConnectionFactory =
      options.peerConnectionFactory ?? createDefaultPeerConnectionFactory();
  }

  async connect(): Promise<void> {
    const peer = this.peerConnectionFactory();
    this.peer = peer;

    peer.onicecandidate = (event) => {
      if (!event.candidate || !this.sessionId) {
        return;
      }
      const candidate = candidateToInit(event.candidate);
      this.signaling.send(
        createMessage<TunnelIceCandidatePayload>(
          "tunnel.session.candidate",
          {
            session_id: this.sessionId,
            device_id: this.pairing.deviceId,
            candidate: candidate.candidate,
            sdp_mid: candidate.sdpMid,
            sdp_m_line_index: candidate.sdpMLineIndex,
          },
          { device_id: this.pairing.deviceId, session_id: this.sessionId },
        ),
      );
    };
    peer.ondatachannel = (event) => {
      const transport = new DataChannelEnvelopeTransport({
        channel: event.channel,
      });
      this.dataTransport = transport;
      transport.onMessage((message) => {
        this.handleDataMessage(message).catch(() => {
          // Screen layers own user-visible error reporting.
        });
        for (const handler of this.messageHandlers) {
          handler(message);
        }
      });
      transport.onClose((reason) => {
        for (const handler of this.closeHandlers) {
          handler({ reason });
        }
      });
      transport.onOpen(() => {
        transport.send(
          createMessage(
            "mobile.connect",
            {
              device_id: this.pairing.deviceId,
              key_id: this.pairing.keyId ?? "unknown",
            },
            { device_id: this.pairing.deviceId },
          ),
        );
      });
    };

    this.signaling.onMessage((message) => {
      this.handleSignalMessage(message).catch(() => {
        // Screen layers own user-visible error reporting.
      });
    });
    this.signaling.onClose((event) => {
      for (const handler of this.closeHandlers) {
        handler(event);
      }
    });

    await this.signaling.connect();
    this.signaling.send(
      createMessage<TunnelMobileJoinPayload>(
        "tunnel.mobile.join",
        {
          device_id: this.pairing.deviceId,
          key_id: this.pairing.keyId ?? "unknown",
          transport: "webrtc",
        },
        { device_id: this.pairing.deviceId },
      ),
    );
  }

  onMessage(handler: (message: MessageEnvelope) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: (event: RelayCloseEvent) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  send(message: MessageEnvelope): void {
    if (!this.dataTransport) {
      throw new Error("WebRTC data channel is not ready");
    }

    this.dataTransport.send(message);
  }

  close(): void {
    if (this.sessionId) {
      this.signaling.send(
        createMessage(
          "tunnel.session.close",
          {
            session_id: this.sessionId,
            device_id: this.pairing.deviceId,
            reason: "app closing",
          },
          { device_id: this.pairing.deviceId, session_id: this.sessionId },
        ),
      );
    }
    this.dataTransport?.close();
    this.peer?.close();
    this.signaling.close();
  }

  private async handleSignalMessage(message: MessageEnvelope): Promise<void> {
    if (message.type === "tunnel.session.offer") {
      await this.handleOffer(
        message as MessageEnvelope<TunnelSessionDescriptionPayload>,
      );
      return;
    }

    if (message.type === "tunnel.session.candidate") {
      await this.handleCandidate(
        message as MessageEnvelope<TunnelIceCandidatePayload>,
      );
      return;
    }

    if (message.type === "tunnel.session.failed") {
      const payload = message.payload as TunnelSessionFailedPayload;
      throw new Error(
        payload.message ?? `WebRTC tunnel failed: ${payload.reason}`,
      );
    }
  }

  private async handleOffer(
    message: MessageEnvelope<TunnelSessionDescriptionPayload>,
  ): Promise<void> {
    if (!this.peer) {
      return;
    }

    this.sessionId = message.payload.session_id;
    await this.peer.setRemoteDescription({
      type: "offer",
      sdp: message.payload.sdp,
    });

    const answer = await this.peer.createAnswer();
    await this.peer.setLocalDescription(answer);
    const local = this.peer.localDescription ?? answer;

    this.signaling.send(
      createMessage<TunnelSessionDescriptionPayload>(
        "tunnel.session.answer",
        {
          session_id: message.payload.session_id,
          device_id: this.pairing.deviceId,
          sdp: local.sdp ?? "",
          sdp_type: "answer",
        },
        {
          device_id: this.pairing.deviceId,
          session_id: message.payload.session_id,
        },
      ),
    );
  }

  private async handleCandidate(
    message: MessageEnvelope<TunnelIceCandidatePayload>,
  ): Promise<void> {
    await this.peer?.addIceCandidate({
      candidate: message.payload.candidate,
      sdpMid: message.payload.sdp_mid,
      sdpMLineIndex: message.payload.sdp_m_line_index,
    });
  }

  private async handleDataMessage(message: MessageEnvelope): Promise<void> {
    if (message.type !== "auth.challenge") {
      return;
    }

    const challenge = message.payload as AuthChallengePayload;
    const proof = await createKeyProof(this.pairing.key, challenge.nonce);
    this.send(
      createMessage(
        "auth.proof",
        {
          key_id: challenge.key_id,
          nonce: challenge.nonce,
          proof,
        },
        { device_id: this.pairing.deviceId },
      ),
    );
  }
}

function createDefaultPeerConnectionFactory(): WebRtcPeerConnectionFactory {
  return createPeerConnectionFactory();
}

function toTunnelMobileUrl(relayUrl: string): string {
  const withoutQuery = relayUrl.trim().split("#", 1)[0].split("?", 1)[0];
  const withoutTrailingSlash = withoutQuery.replace(/\/+$/, "");
  const baseUrl = withoutTrailingSlash.replace(
    /\/(?:agent|mobile|tunnel\/mobile)$/,
    "",
  );
  return `${baseUrl}/tunnel/mobile`;
}
