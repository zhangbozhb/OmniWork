import assert from "node:assert/strict";
import test from "node:test";

import {
  type IceCandidateInit,
  type PeerState,
  type WebRtcPeerAdapter,
} from "../../packages/protocol-ts/src/index.ts";
import { UpgradeCoordinator } from "../src/lib/transport/upgradeCoordinator.ts";

class MockPeer implements WebRtcPeerAdapter {
  private readonly stateHandlers = new Set<(state: PeerState) => void>();

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
    // no-op
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
