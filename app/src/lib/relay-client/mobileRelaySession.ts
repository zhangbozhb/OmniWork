import {
  RelayClient,
  type RelayCloseEvent,
} from "../../../../packages/relay-client/src/index.ts";
import { createMessage, type AuthChallengePayload, type MessageEnvelope } from "../../../../packages/protocol-ts/src/index.ts";
import type { PairingConfig } from "../../features/auth/types";
import { createKeyProof } from "../../features/auth/keyProof";

export class MobileRelaySession {
  private readonly client: RelayClient;

  constructor(private readonly pairing: PairingConfig) {
    this.client = new RelayClient({ url: pairing.relayUrl });
  }

  async connect(): Promise<void> {
    this.client.onMessage((message) => {
      this.handleMessage(message).catch(() => {
        // The screen layer owns user-visible error reporting.
      });
    });
    await this.client.connect();
    this.client.send(
      createMessage("mobile.connect", {
        device_id: this.pairing.deviceId,
        key_id: this.pairing.keyId ?? "unknown",
      }, { device_id: this.pairing.deviceId }),
    );
  }

  onMessage(handler: (message: MessageEnvelope) => void): () => void {
    return this.client.onMessage(handler);
  }

  onClose(handler: (event: RelayCloseEvent) => void): () => void {
    return this.client.onClose(handler);
  }

  send(message: MessageEnvelope): void {
    this.client.send(message);
  }

  close(): void {
    this.client.close();
  }

  private async handleMessage(message: MessageEnvelope): Promise<void> {
    if (message.type !== "auth.challenge") {
      return;
    }

    const challenge = message.payload as AuthChallengePayload;
    const proof = await createKeyProof(this.pairing.key, challenge.nonce);
    this.client.send(
      createMessage("auth.proof", {
        key_id: challenge.key_id,
        nonce: challenge.nonce,
        proof,
      }, { device_id: this.pairing.deviceId }),
    );
  }
}
