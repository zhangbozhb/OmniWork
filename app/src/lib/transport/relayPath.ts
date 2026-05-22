import type { MessageEnvelope } from "../../../../packages/protocol-ts/src/index";
import type { RelayCloseEvent } from "../../../../packages/relay-client/src/index";
import type { MobileRelaySession } from "../relay-client/mobileRelaySession";

export class MobileRelayPath {
  private readonly session: MobileRelaySession;

  constructor(session: MobileRelaySession) {
    this.session = session;
  }

  send(envelope: MessageEnvelope): void {
    this.session.send(envelope);
  }

  onMessage(handler: (envelope: MessageEnvelope) => void): () => void {
    return this.session.onMessage(handler);
  }

  onClose(handler: (event: RelayCloseEvent) => void): () => void {
    return this.session.onClose(handler);
  }
}
