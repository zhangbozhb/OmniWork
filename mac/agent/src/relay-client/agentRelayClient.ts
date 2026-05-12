import { RelayClient } from "../../../../packages/relay-client/src/index.ts";
import type { MessageEnvelope } from "../../../../packages/protocol-ts/src/index.ts";

export class AgentRelayClient {
  private readonly client: RelayClient;

  constructor(url: string) {
    this.client = new RelayClient({ url });
  }

  connect(): Promise<void> {
    return this.client.connect();
  }

  onMessage(handler: (message: MessageEnvelope) => void): () => void {
    return this.client.onMessage(handler);
  }

  send(message: MessageEnvelope): void {
    this.client.send(message);
  }

  close(): void {
    this.client.close();
  }
}
