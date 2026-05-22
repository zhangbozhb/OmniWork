import { strict as assert } from "node:assert";

import {
  AgentSessionTransport,
} from "../../src/transport/sessionTransport.ts";
import {
  createMessage,
  type MessageEnvelope,
} from "../../../../packages/protocol-ts/src/index.ts";

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

const buildEnvelope = (id: string): MessageEnvelope =>
  createMessage("session.list", {}, { id, device_id: "test" });

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

console.log("session-transport tests passed");
