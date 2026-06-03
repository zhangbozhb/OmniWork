import type { MessageEnvelope } from "../../../../packages/protocol-ts/src/index.ts";
import type { RelayCloseEvent } from "../../../../packages/relay-client/src/index.ts";
import type { MobileRelaySession } from "../relay-client/mobileRelaySession.ts";

export class MobileRelayPath {
  private readonly session: MobileRelaySession;

  constructor(session: MobileRelaySession) {
    this.session = session;
  }

  send(envelope: MessageEnvelope): void {
    this.session.send(envelope);
  }

  encodeForP2p(envelope: MessageEnvelope): MessageEnvelope | null {
    return this.session.encodeForP2p(envelope);
  }

  receiveFromP2p(envelope: MessageEnvelope): void {
    this.session.receiveFromP2p(envelope);
  }

  onMessage(handler: (envelope: MessageEnvelope) => void): () => void {
    return this.session.onMessage(handler);
  }

  onClose(handler: (event: RelayCloseEvent) => void): () => void {
    return this.session.onClose(handler);
  }

  onBusinessReady(handler: () => void): () => void {
    return this.session.onBusinessReady(handler);
  }
}
