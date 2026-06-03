import assert from "node:assert/strict";
import test from "node:test";

import {
  createMessage,
  type MessageEnvelope,
  type P2pChannelKind,
  type PeerState,
  type WebRtcPeerAdapter,
} from "../../packages/protocol-ts/src/index.ts";
import { MobileSessionTransport } from "../src/lib/transport/sessionTransport.ts";

type MessageHandler = (envelope: MessageEnvelope) => void;

class MockRelayPath {
  public readonly sent: MessageEnvelope[] = [];
  private businessReadyHandler: (() => void) | null = null;

  send(envelope: MessageEnvelope): void {
    this.sent.push(envelope);
  }

  encodeForP2p(envelope: MessageEnvelope): MessageEnvelope | null {
    if (envelope.type === "workspace.list") {
      return null;
    }
    return envelope;
  }

  receiveFromP2p(): void {
    // no-op
  }

  onMessage(_handler: MessageHandler): () => void {
    return () => {};
  }

  onClose(): () => void {
    return () => {};
  }

  onBusinessReady(handler: () => void): () => void {
    this.businessReadyHandler = handler;
    return () => {
      this.businessReadyHandler = null;
    };
  }

  emitBusinessReady(): void {
    this.businessReadyHandler?.();
  }
}

class MockPeer implements WebRtcPeerAdapter {
  public readonly sent: Array<{ data: string; channel?: P2pChannelKind }> = [];

  async createOffer(): Promise<string> {
    return "offer";
  }

  async createAnswer(): Promise<string> {
    return "answer";
  }

  async setRemoteDescription(): Promise<void> {
    // no-op
  }

  async addIceCandidate(): Promise<void> {
    // no-op
  }

  onLocalCandidate(): () => void {
    return () => {};
  }

  onDataMessage(): () => void {
    return () => {};
  }

  onStateChange(): () => void {
    return () => {};
  }

  send(data: string, channel?: P2pChannelKind): void {
    this.sent.push({ data, channel });
  }

  getBufferedAmount(): number {
    return 0;
  }

  close(): void {
    // no-op
  }
}

async function waitForSwitchPath(
  transport: MobileSessionTransport,
): Promise<void> {
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    await transport.switchPath("p2p");
  } finally {
    clearTimeout(keepAlive);
  }
}

test("strict P2P preserves initial workspace refresh until E2E business layer is ready", async () => {
  const relayPath = new MockRelayPath();
  const peer = new MockPeer();
  const transport = new MobileSessionTransport(relayPath as never, {
    strictP2p: true,
  });
  const workspaceList = createMessage("workspace.list", {}, {
    device_id: "mac_test",
  });

  transport.send(workspaceList);
  transport.attachP2pPeer(peer);
  await waitForSwitchPath(transport);

  assert.equal(peer.sent.length, 0);

  relayPath.encodeForP2p = (envelope: MessageEnvelope) =>
    createMessage("e2e.message", { seq: 1, ciphertext: "cipher" }, {
      device_id: "mac_test",
      id: envelope.id,
    });
  relayPath.emitBusinessReady();

  assert.equal(peer.sent.length, 1);
  assert.equal(peer.sent[0]?.channel, "control");
});
