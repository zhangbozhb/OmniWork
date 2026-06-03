import { strict as assert } from "node:assert";

import {
  type IceCandidateInit,
  type MessageEnvelope,
  type PeerState,
  type TransportPath,
  type WebRtcPeerAdapter,
} from "../../../../packages/protocol-ts/src/index.ts";
import { UpgradeCoordinator } from "../../src/transport/upgradeCoordinator.ts";

class MockPeer implements WebRtcPeerAdapter {
  public lastRemoteSdp: { sdp: string; type: "offer" | "answer" } | null = null;
  public iceCandidates: IceCandidateInit[] = [];
  public sentData: string[] = [];
  public closed = false;
  private candidateHandlers = new Set<(c: IceCandidateInit) => void>();
  private dataHandlers = new Set<(data: string) => void>();
  private stateHandlers = new Set<(state: PeerState) => void>();

  async createOffer(): Promise<string> {
    return "v=0\r\nmock-offer";
  }

  async createAnswer(): Promise<string> {
    return "v=0\r\nmock-answer";
  }

  async setRemoteDescription(
    sdp: string,
    type: "offer" | "answer",
  ): Promise<void> {
    this.lastRemoteSdp = { sdp, type };
  }

  async addIceCandidate(c: IceCandidateInit): Promise<void> {
    this.iceCandidates.push(c);
  }

  onLocalCandidate(handler: (c: IceCandidateInit) => void): () => void {
    this.candidateHandlers.add(handler);
    return () => {
      this.candidateHandlers.delete(handler);
    };
  }

  onDataMessage(handler: (data: string) => void): () => void {
    this.dataHandlers.add(handler);
    return () => {
      this.dataHandlers.delete(handler);
    };
  }

  onStateChange(handler: (state: PeerState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  send(data: string): void {
    this.sentData.push(data);
  }

  getBufferedAmount(): number {
    return 0;
  }

  close(): void {
    this.closed = true;
  }

  emitState(state: PeerState): void {
    for (const handler of this.stateHandlers) {
      handler(state);
    }
  }

  emitLocalCandidate(c: IceCandidateInit): void {
    for (const handler of this.candidateHandlers) {
      handler(c);
    }
  }
}

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];
const UPGRADE_ID = "upgrade-test-1";
const APP_CONNECTION_ID = "conn_app";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// 1. answerer 端：propose -> handleOffer -> handleCommitted -> upgraded
{
  const peer = new MockPeer();
  const sent: MessageEnvelope[] = [];
  const pathChanges: TransportPath[] = [];

  const coordinator = new UpgradeCoordinator({
    role: "answerer",
    deviceId: "device-test",
    peerFactory: () => peer,
    sendControl: (env) => sent.push(env),
    onSwitchPath: (p) => pathChanges.push(p),
    timeoutMs: 1_000,
  });

  await coordinator.propose({
    upgrade_id: UPGRADE_ID,
    app_connection_id: APP_CONNECTION_ID,
    ice_servers: ICE_SERVERS,
    role: "answerer",
  });
  assert.equal(coordinator.getState(), "negotiating");

  await coordinator.handleOffer({
    upgrade_id: UPGRADE_ID,
    app_connection_id: APP_CONNECTION_ID,
    sdp: "remote-offer",
  });
  assert.equal(peer.lastRemoteSdp?.type, "offer");

  // sendControl 中应已包含 answer
  const types = sent.map((m) => m.type);
  assert.ok(types.includes("tunnel.upgrade.answer"), "answer should be sent");

  // 模拟收到对端 candidate
  await coordinator.handleCandidate({
    upgrade_id: UPGRADE_ID,
    app_connection_id: APP_CONNECTION_ID,
    candidate: "candidate:1 1 udp 2122260223 1.1.1.1 1234 typ host",
    sdp_mid: "0",
    sdp_mline_index: 0,
  });
  assert.equal(peer.iceCandidates.length, 1);

  // 本地 candidate 应转发
  peer.emitLocalCandidate({
    candidate: "candidate:2 1 udp 1 2.2.2.2 5678 typ host",
    sdpMid: "0",
    sdpMLineIndex: 0,
  });
  assert.ok(
    sent.some((m) => m.type === "tunnel.upgrade.candidate"),
    "local candidate forwarded",
  );

  // peer 进入 connected -> localCommit
  peer.emitState("connected");
  assert.ok(
    sent.some((m) => m.type === "tunnel.upgrade.committed"),
    "committed sent on connected",
  );
  assert.equal(coordinator.getState(), "committing");

  // 收到对端 committed -> upgraded -> p2p
  coordinator.handleCommitted({ upgrade_id: UPGRADE_ID, app_connection_id: APP_CONNECTION_ID });
  assert.equal(coordinator.getState(), "upgraded");
  assert.deepEqual(pathChanges, ["p2p"]);
}

// 2. offerer 端：propose 立即发送 offer，timeout 触发 downgrade
{
  const peer = new MockPeer();
  const sent: MessageEnvelope[] = [];
  const pathChanges: TransportPath[] = [];

  const coordinator = new UpgradeCoordinator({
    role: "offerer",
    deviceId: "device-test",
    peerFactory: () => peer,
    sendControl: (env) => sent.push(env),
    onSwitchPath: (p) => pathChanges.push(p),
    timeoutMs: 50,
  });

  await coordinator.propose({
    upgrade_id: UPGRADE_ID,
    app_connection_id: APP_CONNECTION_ID,
    ice_servers: ICE_SERVERS,
    role: "offerer",
  });

  assert.ok(
    sent.some((m) => m.type === "tunnel.upgrade.offer"),
    "offer sent immediately",
  );
  assert.equal(coordinator.getState(), "negotiating");

  // 等超时
  await sleep(120);
  assert.equal(coordinator.getState(), "idle");
  assert.ok(
    sent.some((m) => m.type === "tunnel.upgrade.downgrade"),
    "downgrade sent after timeout",
  );
  assert.deepEqual(pathChanges, ["relay"]);
  assert.equal(peer.closed, true);
}

// 3. peer factory 返回 null -> failed -> downgrade
{
  const sent: MessageEnvelope[] = [];
  const pathChanges: TransportPath[] = [];
  const coordinator = new UpgradeCoordinator({
    role: "offerer",
    deviceId: "device-test",
    peerFactory: () => null,
    sendControl: (env) => sent.push(env),
    onSwitchPath: (p) => pathChanges.push(p),
    timeoutMs: 1_000,
  });

  await coordinator.propose({
    upgrade_id: UPGRADE_ID,
    app_connection_id: APP_CONNECTION_ID,
    ice_servers: ICE_SERVERS,
    role: "offerer",
  });

  assert.equal(coordinator.getState(), "idle");
  assert.ok(
    sent.some(
      (m) =>
        m.type === "tunnel.upgrade.downgrade" &&
        (m.payload as { reason: string }).reason === "peer_unavailable",
    ),
    "downgrade with peer_unavailable",
  );
  assert.deepEqual(pathChanges, ["relay"]);
}

// 4. 重复 propose 在非 idle 状态被忽略
{
  const peer = new MockPeer();
  const sent: MessageEnvelope[] = [];
  const coordinator = new UpgradeCoordinator({
    role: "answerer",
    deviceId: "device-test",
    peerFactory: () => peer,
    sendControl: (env) => sent.push(env),
    onSwitchPath: () => {},
    timeoutMs: 5_000,
  });

  await coordinator.propose({
    upgrade_id: UPGRADE_ID,
    app_connection_id: APP_CONNECTION_ID,
    ice_servers: ICE_SERVERS,
    role: "answerer",
  });
  const before = sent.length;
  await coordinator.propose({
    upgrade_id: "another",
    app_connection_id: APP_CONNECTION_ID,
    ice_servers: ICE_SERVERS,
    role: "answerer",
  });
  // 不应触发额外发送
  assert.equal(sent.length, before);
}

// 5. strict P2P：peer factory 返回 null -> 触发 onForceClose 而非 onSwitchPath('relay')
{
  const sent: MessageEnvelope[] = [];
  const pathChanges: TransportPath[] = [];
  const forceCloseReasons: string[] = [];
  const coordinator = new UpgradeCoordinator({
    role: "offerer",
    deviceId: "device-test",
    peerFactory: () => null,
    sendControl: (env) => sent.push(env),
    onSwitchPath: (p) => pathChanges.push(p),
    onForceClose: (reason) => forceCloseReasons.push(reason),
    timeoutMs: 1_000,
  });

  await coordinator.propose({
    upgrade_id: UPGRADE_ID,
    app_connection_id: APP_CONNECTION_ID,
    ice_servers: ICE_SERVERS,
    role: "offerer",
    strict: true,
  });

  // tunnel.upgrade.downgrade 仍要发送给 Relay 用于 metrics + backoff
  assert.ok(
    sent.some(
      (m) =>
        m.type === "tunnel.upgrade.downgrade" &&
        (m.payload as { reason: string }).reason === "peer_unavailable",
    ),
    "strict mode still sends downgrade for metrics",
  );
  // 但不会触发 onSwitchPath('relay')
  assert.deepEqual(pathChanges, [], "strict mode does not switch to relay");
  assert.deepEqual(
    forceCloseReasons,
    ["peer_unavailable"],
    "strict mode triggers onForceClose with peer_unavailable",
  );
  assert.equal(coordinator.getState(), "idle");
}

// 6. strict P2P：协商超时也走 onForceClose
{
  const peer = new MockPeer();
  const sent: MessageEnvelope[] = [];
  const pathChanges: TransportPath[] = [];
  const forceCloseReasons: string[] = [];
  const coordinator = new UpgradeCoordinator({
    role: "offerer",
    deviceId: "device-test",
    peerFactory: () => peer,
    sendControl: (env) => sent.push(env),
    onSwitchPath: (p) => pathChanges.push(p),
    onForceClose: (reason) => forceCloseReasons.push(reason),
    timeoutMs: 50,
  });

  await coordinator.propose({
    upgrade_id: UPGRADE_ID,
    app_connection_id: APP_CONNECTION_ID,
    ice_servers: ICE_SERVERS,
    role: "offerer",
    strict: true,
  });

  await sleep(120);

  assert.deepEqual(pathChanges, [], "strict timeout does not switch to relay");
  assert.deepEqual(
    forceCloseReasons,
    ["timeout"],
    "strict timeout triggers onForceClose",
  );
  assert.ok(
    sent.some(
      (m) =>
        m.type === "tunnel.upgrade.downgrade" &&
        (m.payload as { reason: string }).reason === "timeout",
    ),
    "strict timeout still emits downgrade envelope",
  );
}

// 7. 非 strict propose 仍走原 switchPath('relay') 路径，未传 strict 字段时默认 false
{
  const sent: MessageEnvelope[] = [];
  const pathChanges: TransportPath[] = [];
  const forceCloseReasons: string[] = [];
  const coordinator = new UpgradeCoordinator({
    role: "offerer",
    deviceId: "device-test",
    peerFactory: () => null,
    sendControl: (env) => sent.push(env),
    onSwitchPath: (p) => pathChanges.push(p),
    onForceClose: (reason) => forceCloseReasons.push(reason),
    timeoutMs: 1_000,
  });

  await coordinator.propose({
    upgrade_id: UPGRADE_ID,
    app_connection_id: APP_CONNECTION_ID,
    ice_servers: ICE_SERVERS,
    role: "offerer",
    // 不传 strict
  });

  assert.deepEqual(
    pathChanges,
    ["relay"],
    "non-strict propose falls back to relay",
  );
  assert.deepEqual(
    forceCloseReasons,
    [],
    "non-strict propose does not trigger onForceClose",
  );
}

// 8. Relay control socket 已关闭时，downgrade 发送失败不应打断本地清理。
{
  const pathChanges: TransportPath[] = [];
  const coordinator = new UpgradeCoordinator({
    role: "offerer",
    deviceId: "device-test",
    peerFactory: () => new MockPeer(),
    sendControl: () => {
      throw new Error("Relay socket is not open");
    },
    onSwitchPath: (p) => pathChanges.push(p),
    timeoutMs: 1_000,
  });

  await assert.doesNotReject(
    coordinator.propose({
      upgrade_id: UPGRADE_ID,
      app_connection_id: APP_CONNECTION_ID,
      ice_servers: ICE_SERVERS,
      role: "offerer",
    }),
  );
  assert.doesNotThrow(() => coordinator.downgrade("client_closing"));
  assert.equal(coordinator.getState(), "idle");
  assert.deepEqual(pathChanges, ["relay"]);
}

console.log("upgrade-coordinator tests passed");
