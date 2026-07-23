import type { MessageEnvelope } from "@omni-work/protocol-ts";
import type { AgentRelayClient } from "../relay-client/agentRelayClient.ts";

export class AgentRelayPath {
  private readonly client: AgentRelayClient;

  constructor(client: AgentRelayClient) {
    this.client = client;
  }

  send(envelope: MessageEnvelope): void {
    this.client.send(envelope);
  }

  onMessage(handler: (envelope: MessageEnvelope) => void): () => void {
    return this.client.onMessage(handler);
  }
}
