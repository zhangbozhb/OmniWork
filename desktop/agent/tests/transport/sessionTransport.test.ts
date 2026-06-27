import { strict as assert } from "node:assert";

import {
  AgentSessionTransport,
} from "../../src/transport/sessionTransport.ts";
import {
  createMessage,
  type IceCandidateInit,
  type MessageEnvelope,
  type P2pChannelKind,
  type PeerState,
  type WebRtcPeerAdapter,
} from "@omniwork/protocol-ts";

type MessageHandler = (envelope: MessageEnvelope) => void;

class MockRelayPath {
  public readonly sent: MessageEnvelope[] = [];
  private readonly handlers = new Set<MessageHandler>();

  send(envelope: MessageEnvelope): void {
    this.sent.push(envelope);
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(envelope: MessageEnvelope): void {
    for (const handler of this.handlers) {
      handler(envelope);
    }
  }
}

class MockPeer implements WebRtcPeerAdapter {
  public readonly sent: Array<{ data: string; channel?: P2pChannelKind }> = [];
  private readonly dataHandlers = new Set<(data: string) => void>();
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

const buildEnvelope = (id: string): MessageEnvelope =>
  createMessage("session.list", {}, { id, device_id: "test" });

async function waitForSwitchPath(
  transport: AgentSessionTransport,
  target: "relay" | "p2p",
): Promise<void> {
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    await transport.switchPath(target);
  } finally {
    clearTimeout(keepAlive);
  }
}

async function waitForSwitchPathForConnection(
  transport: AgentSessionTransport,
  appConnectionId: string,
  target: "relay" | "p2p",
): Promise<void> {
  const keepAlive = setTimeout(() => {}, 1_000);
  try {
    await transport.switchPathForConnection(appConnectionId, target);
  } finally {
    clearTimeout(keepAlive);
  }
}

// 1. send 转发到 relayPath
{
  const relayPath = new MockRelayPath();
  const transport = new AgentSessionTransport(
    relayPath as unknown as import("../../src/transport/relayPath.ts").AgentRelayPath,
  );
  const envelope = buildEnvelope("send-1");
  transport.send(envelope);
  assert.equal(relayPath.sent.length, 1);
  assert.equal(relayPath.sent[0]?.id, "send-1");
}

// 2. onMessage 注册的 handler 在 relayPath 收到 envelope 时被调用
{
  const relayPath = new MockRelayPath();
  const transport = new AgentSessionTransport(
    relayPath as unknown as import("../../src/transport/relayPath.ts").AgentRelayPath,
  );
  const received: MessageEnvelope[] = [];
  transport.onMessage((message) => received.push(message));
  const envelope = buildEnvelope("recv-1");
  relayPath.emit(envelope);
  assert.equal(received.length, 1);
  assert.equal(received[0]?.id, "recv-1");
}

// 3. getCurrentPath() 默认返回 "relay"
{
  const relayPath = new MockRelayPath();
  const transport = new AgentSessionTransport(
    relayPath as unknown as import("../../src/transport/relayPath.ts").AgentRelayPath,
  );
  assert.equal(transport.getCurrentPath(), "relay");
}

// 4. close() 后 send 抛错；handlers 不再触发
{
  const relayPath = new MockRelayPath();
  const transport = new AgentSessionTransport(
    relayPath as unknown as import("../../src/transport/relayPath.ts").AgentRelayPath,
  );
  const received: MessageEnvelope[] = [];
  transport.onMessage((message) => received.push(message));

  transport.close("test reason");

  assert.throws(() => transport.send(buildEnvelope("after-close")));
  relayPath.emit(buildEnvelope("after-close-emit"));
  assert.equal(received.length, 0);
}

// 5. strict pending queue 保留 channel hint，flush 后仍走原 channel。
{
  const relayPath = new MockRelayPath();
  const peer = new MockPeer();
  const transport = new AgentSessionTransport(
    relayPath as unknown as import("../../src/transport/relayPath.ts").AgentRelayPath,
    { strictP2p: true },
  );
  transport.send(
    createMessage("terminal.frame", { data: "frame" }, { device_id: "test" }),
    "display",
  );
  transport.attachP2pPeer(peer);
  await waitForSwitchPath(transport, "p2p");

  assert.equal(peer.sent.length, 1);
  assert.equal(peer.sent[0]?.channel, "display");
  transport.close("test cleanup");
}

// 6. e2e.message 在 P2P 上必须强制走 control，不能走 display。
{
  const relayPath = new MockRelayPath();
  const peer = new MockPeer();
  const transport = new AgentSessionTransport(
    relayPath as unknown as import("../../src/transport/relayPath.ts").AgentRelayPath,
  );
  transport.attachP2pPeer(peer, { appConnectionId: "conn_app_1" });
  await waitForSwitchPathForConnection(transport, "conn_app_1", "p2p");
  transport.send(
    createMessage(
      "e2e.message",
      { app_connection_id: "conn_app_1", seq: 1, ciphertext: "cipher" },
      { device_id: "test" },
    ),
    "display",
  );

  assert.equal(peer.sent.length, 1);
  assert.equal(peer.sent[0]?.channel, "control");
  assert.equal(relayPath.sent.length, 0);
  transport.close("test cleanup");
}

// 7. per-app strict P2P 建链前，app-scoped 业务消息暂存，升级控制可 bypass。
{
  const relayPath = new MockRelayPath();
  const peer = new MockPeer();
  const transport = new AgentSessionTransport(
    relayPath as unknown as import("../../src/transport/relayPath.ts").AgentRelayPath,
  );
  transport.configureStrictP2pForConnection("conn_app_strict", true);
  transport.send(
    createMessage(
      "e2e.message",
      { app_connection_id: "conn_app_strict", seq: 1, ciphertext: "payload" },
      { device_id: "test" },
    ),
    "display",
  );
  assert.equal(relayPath.sent.length, 0);

  transport.send(
    createMessage(
      "e2e.message",
      { app_connection_id: "conn_app_strict", seq: 2, ciphertext: "control" },
      { device_id: "test" },
    ),
    "control",
    { strictBypass: true },
  );
  assert.equal(relayPath.sent.length, 1);

  transport.attachP2pPeer(peer, { appConnectionId: "conn_app_strict" });
  await waitForSwitchPathForConnection(transport, "conn_app_strict", "p2p");

  assert.equal(peer.sent.length, 1);
  assert.equal(peer.sent[0]?.channel, "control");
  transport.close("test cleanup");
}

// 8. per-app strict peer 缺失时不 fallback Relay，且不影响其他 app peer。
{
  const relayPath = new MockRelayPath();
  const peer = new MockPeer();
  const forceCloseReasons: string[] = [];
  const transport = new AgentSessionTransport(
    relayPath as unknown as import("../../src/transport/relayPath.ts").AgentRelayPath,
  );
  transport.configureStrictP2pForConnection(
    "conn_app_strict",
    true,
    (reason) => forceCloseReasons.push(reason),
  );
  transport.attachP2pPeer(peer, { appConnectionId: "conn_app_other" });
  await waitForSwitchPathForConnection(transport, "conn_app_other", "p2p");
  transport.forceCloseConnection("conn_app_strict", "peer_missing");
  transport.send(
    createMessage(
      "e2e.message",
      { app_connection_id: "conn_app_other", seq: 1, ciphertext: "other" },
      { device_id: "test" },
    ),
    "display",
  );

  assert.equal(relayPath.sent.length, 0);
  assert.deepEqual(forceCloseReasons, ["peer_missing"]);
  assert.equal(peer.sent.length, 1);
  transport.close("test cleanup");
}

console.log("session-transport tests passed");
