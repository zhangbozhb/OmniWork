import {
  RelayClient,
  type RelayCloseEvent,
} from "../../../../packages/relay-client/src/index.ts";
import {
  E2E_SUPPORT_V1,
  PROTOCOL_SUPPORT_V1,
  createMessage,
  type AuthChallengePayload,
  type MessageEnvelope,
  type TransportPreference,
} from "../../../../packages/protocol-ts/src/index.ts";
import type { PairingConfig } from "../../features/auth/types";
import { createKeyProof } from "../../features/auth/keyProof";

export interface MobileRelaySessionOptions {
  /**
   * App 端在 mobile.connect 中向 Relay 声明的传输偏好；缺省由 Relay 视为 "auto"。
   * 详见 docs/relay-architecture.md "传输偏好可控"小节。
   */
  transportPreference?: TransportPreference;
}

export class MobileRelaySession {
  private readonly client: RelayClient;
  private readonly options: MobileRelaySessionOptions;

  constructor(
    private readonly pairing: PairingConfig,
    options: MobileRelaySessionOptions = {},
  ) {
    this.client = new RelayClient({ url: pairing.relayUrl });
    this.options = options;
  }

  async connect(): Promise<void> {
    this.client.onMessage((message) => {
      this.handleMessage(message).catch(() => {
        // The screen layer owns user-visible error reporting.
      });
    });
    await this.client.connect();
    this.client.send(
      createMessage(
        "mobile.connect",
        {
          v: PROTOCOL_SUPPORT_V1.current,
          device_id: this.pairing.deviceId,
          key_id: this.pairing.keyId ?? "unknown",
          protocol: PROTOCOL_SUPPORT_V1,
          e2e: E2E_SUPPORT_V1,
          ...(this.options.transportPreference
            ? { transport_preference: this.options.transportPreference }
            : {}),
        },
        { device_id: this.pairing.deviceId },
      ),
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
      createMessage(
        "auth.proof",
        {
          key_id: challenge.key_id,
          nonce: challenge.nonce,
          proof,
        },
        { device_id: this.pairing.deviceId },
      ),
    );
  }
}
