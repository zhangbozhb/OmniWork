import type { MessageEnvelope } from "./index.ts";
import type { P2pChannelKind } from "./webrtc.ts";

export type TransportPath = "relay" | "p2p";

export interface SessionTransport {
  send(envelope: MessageEnvelope, channel?: P2pChannelKind): void;
  onMessage(handler: (envelope: MessageEnvelope) => void): () => void;
  onPathChange(handler: (path: TransportPath) => void): () => void;
  getCurrentPath(): TransportPath;
  close(reason: string): void;
}
