import assert from "node:assert/strict";
import test from "node:test";

import {
  type IceCandidateInit,
  type PeerState,
  type WebRtcPeerAdapter,
} from "@omni-work/protocol-ts";
import { UpgradeCoordinator } from "../src/lib/transport/upgradeCoordinator.ts";

class MockPeer implements WebRtcPeerAdapter {
  private readonly stateHandlers = new Set<(state: PeerState) => void>();
  closed = false;

  async createOffer(): Promise<string> {
    return "offer";
  }

  async createAnswer(): Promise<string> {
    return "answer";
  }

  async setRemoteDescription(): Promise<void> {
    // no-op
  }

  async addIceCandidate(_c: IceCandidateInit): Promise<void> {
    // no-op
  }

  onLocalCandidate(): () => void {
    return () => {};
  }

  onDataMessage(): () => void {
    return () => {};
  }

  onStateChange(handler: (state: PeerState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  send(): void {
    // no-op
  }

  getBufferedAmount(): number {
    return 0;
  }

  close(): void {
    this.closed = true;
    for (const handler of this.stateHandlers) {
      handler("closed");
    }
  }
}

test("downgrade is best-effort when relay control socket is already closed", async () => {
  const pathChanges: string[] = [];
  const coordinator = new UpgradeCoordinator({
    role: "offerer",
    deviceId: "mac_test",
    peerFactory: () => new MockPeer(),
    sendControl: () => {
      throw new Error("Relay socket is not open");
    },
    onSwitchPath: (path) => pathChanges.push(path),
    timeoutMs: 1_000,
  });

  await assert.doesNotReject(
    coordinator.propose({
      upgrade_id: "upgrade_1",
      app_connection_id: "conn_app_1",
      ice_servers: [],
      role: "offerer",
    }),
  );
  assert.doesNotThrow(() => coordinator.downgrade("client_closing"));
  assert.equal(coordinator.getState(), "idle");
  assert.deepEqual(pathChanges, ["relay"]);
});

test("cancelled peer creation cannot resurrect a P2P negotiation", async () => {
  const peer = new MockPeer();
  let resolvePeer!: (peer: WebRtcPeerAdapter) => void;
  const pendingPeer = new Promise<WebRtcPeerAdapter>((resolve) => {
    resolvePeer = resolve;
  });
  const sent: string[] = [];
  const coordinator = new UpgradeCoordinator({
    role: "offerer",
    deviceId: "mac_test",
    peerFactory: () => pendingPeer,
    sendControl: (message) => sent.push(message.type),
    onSwitchPath: () => assert.fail("cancelled upgrade changed path"),
  });
  const proposing = coordinator.propose({
    upgrade_id: "cancelled_upgrade",
    app_connection_id: "conn_app_1",
    ice_servers: [],
    role: "offerer",
  });
  coordinator.prepareForReconnect("closed", false);
  resolvePeer(peer);
  await proposing;
  assert.equal(coordinator.getState(), "idle");
  assert.equal(coordinator.getPeer(), null);
  assert.equal(peer.closed, true);
  assert.deepEqual(sent, []);
});
