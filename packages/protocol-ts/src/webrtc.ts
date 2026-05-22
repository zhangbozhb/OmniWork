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

export interface WebRtcPeerAdapter {
  createOffer(): Promise<string>;
  createAnswer(): Promise<string>;
  setRemoteDescription(sdp: string, type: "offer" | "answer"): Promise<void>;
  addIceCandidate(c: IceCandidateInit): Promise<void>;
  onLocalCandidate(handler: (c: IceCandidateInit) => void): () => void;
  onDataMessage(handler: (data: string) => void): () => void;
  onStateChange(handler: (state: PeerState) => void): () => void;
  send(data: string): void;
  /**
   * 返回 DataChannel 的 bufferedAmount（字节）；通道未 open 或无可用数据通道时返回 0。
   * 用于 SessionTransport 周期采样并触发降级。
   */
  getBufferedAmount(): number;
  close(): void;
}
