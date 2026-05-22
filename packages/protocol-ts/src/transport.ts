import type { MessageEnvelope } from "./index.ts";

export type TransportPath = "relay" | "p2p";

export interface SessionTransport {
  send(envelope: MessageEnvelope): void;
  onMessage(handler: (envelope: MessageEnvelope) => void): () => void;
  onPathChange(handler: (path: TransportPath) => void): () => void;
  getCurrentPath(): TransportPath;
  close(reason: string): void;
}
