import type { MessageEnvelope } from "../../protocol-ts/src/index.ts";

export interface WebRtcSessionDescriptionInit {
  type: "offer" | "answer" | "pranswer" | "rollback";
  sdp?: string;
}

export interface WebRtcIceCandidateInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

export interface WebRtcDataChannelLike {
  readyState: "connecting" | "open" | "closing" | "closed";
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface WebRtcPeerConnectionLike {
  localDescription: WebRtcSessionDescriptionInit | null;
  onicecandidate:
    | ((event: { candidate: WebRtcIceCandidateLike | null }) => void)
    | null;
  ondatachannel:
    | ((event: { channel: WebRtcDataChannelLike }) => void)
    | null;
  onconnectionstatechange: (() => void) | null;
  connectionState?: string;
  createDataChannel?(label: string): WebRtcDataChannelLike;
  createOffer?(): Promise<WebRtcSessionDescriptionInit>;
  createAnswer(): Promise<WebRtcSessionDescriptionInit>;
  setLocalDescription(description: WebRtcSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: WebRtcSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: WebRtcIceCandidateInit): Promise<void>;
  close(): void;
  getStats?(): Promise<unknown>;
}

export interface WebRtcIceCandidateLike {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  toJSON?(): WebRtcIceCandidateInit;
}

export type WebRtcPeerConnectionFactory = () => WebRtcPeerConnectionLike;

export interface DataChannelTransportOptions {
  channel: WebRtcDataChannelLike;
}

export type TunnelMessageHandler = (message: MessageEnvelope) => void;
export type TunnelCloseHandler = (reason?: string) => void;

export class DataChannelEnvelopeTransport {
  private readonly channel: WebRtcDataChannelLike;
  private readonly messageHandlers = new Set<TunnelMessageHandler>();
  private readonly closeHandlers = new Set<TunnelCloseHandler>();

  constructor(options: DataChannelTransportOptions) {
    this.channel = options.channel;
    this.channel.onmessage = (event) => this.handleMessage(event.data);
    this.channel.onclose = () => this.handleClose("data channel closed");
    this.channel.onerror = () => this.handleClose("data channel error");
  }

  onOpen(handler: () => void): void {
    if (this.channel.readyState === "open") {
      handler();
      return;
    }

    const previous = this.channel.onopen;
    this.channel.onopen = () => {
      previous?.();
      handler();
    };
  }

  onMessage(handler: TunnelMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: TunnelCloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  send(message: MessageEnvelope): void {
    if (this.channel.readyState !== "open") {
      throw new Error("WebRTC data channel is not open");
    }

    this.channel.send(JSON.stringify(message));
  }

  close(): void {
    this.channel.close();
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") {
      return;
    }

    const message = JSON.parse(raw) as MessageEnvelope;
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  private handleClose(reason: string): void {
    for (const handler of this.closeHandlers) {
      handler(reason);
    }
  }
}

export function candidateToInit(
  candidate: WebRtcIceCandidateLike,
): WebRtcIceCandidateInit {
  if (candidate.toJSON) {
    return candidate.toJSON();
  }

  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
  };
}
