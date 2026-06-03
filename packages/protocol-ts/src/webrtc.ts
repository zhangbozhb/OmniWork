export type PeerState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export interface IceCandidateInit {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

export type P2pChannelKind = "control" | "input" | "display";

export const P2P_CHANNEL_LABELS: Record<P2pChannelKind, string> = {
  control: "omniwork-control",
  input: "omniwork-input",
  display: "omniwork-display",
};

export const P2P_CHANNEL_KINDS: P2pChannelKind[] = [
  "control",
  "input",
  "display",
];

export function p2pChannelKindFromLabel(label: unknown): P2pChannelKind {
  if (label === P2P_CHANNEL_LABELS.input) return "input";
  if (label === P2P_CHANNEL_LABELS.display) return "display";
  return "control";
}

export interface WebRtcPeerAdapter {
  createOffer(): Promise<string>;
  createAnswer(): Promise<string>;
  setRemoteDescription(sdp: string, type: "offer" | "answer"): Promise<void>;
  addIceCandidate(c: IceCandidateInit): Promise<void>;
  onLocalCandidate(handler: (c: IceCandidateInit) => void): () => void;
  onDataMessage(
    handler: (data: string, channel?: P2pChannelKind) => void,
  ): () => void;
  onStateChange(handler: (state: PeerState) => void): () => void;
  send(data: string, channel?: P2pChannelKind): void;
  /**
   * 返回 DataChannel 的 bufferedAmount（字节）；通道未 open 或无可用数据通道时返回 0。
   * 用于 SessionTransport 周期采样并触发降级。
   */
  getBufferedAmount(channel?: P2pChannelKind): number;
  close(): void;
}
