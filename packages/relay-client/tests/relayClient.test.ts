import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createMessage,
  E2E_SUPPORT_V1,
  PROTOCOL_SUPPORT_V1,
} from "@omniwork/protocol-ts";
import { RelayClient, type RelayCloseEvent } from "../src/index.ts";

type ListenerMap = {
  open: Set<() => void>;
  close: Set<(event: RelayCloseEvent) => void>;
  error: Set<(event: unknown) => void>;
  message: Set<(event: { data: unknown }) => void>;
};

class FakeSocket {
  readonly listeners: ListenerMap = {
    open: new Set(),
    close: new Set(),
    error: new Set(),
    message: new Set(),
  };
  readonly sent: string[] = [];
  readonly closed: Array<{ code?: number; reason?: string }> = [];
  readyState = 1;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
    for (const listener of this.listeners.close) {
      listener({ code, reason });
    }
  }

  addEventListener<TType extends keyof ListenerMap>(
    type: TType,
    listener: ListenerMap[TType] extends Set<infer TListener>
      ? TListener
      : never,
  ): void {
    this.listeners[type].add(listener as never);
  }

  emitOpen(): void {
    for (const listener of this.listeners.open) {
      listener();
    }
  }

  emitMessage(data: unknown): void {
    for (const listener of this.listeners.message) {
      listener({ data });
    }
  }
}

test("RelayClient closes on malformed protocol payload", async () => {
  const socket = new FakeSocket();
  const client = new RelayClient({
    url: "wss://relay.example/relay/ws/mobile",
    webSocketFactory: () => socket,
  });
  const connected = client.connect();
  socket.emitOpen();
  await connected;

  const malformed = createMessage("mobile.connect", {
    v: PROTOCOL_SUPPORT_V1.current,
    device_id: "device-1",
    protocol: PROTOCOL_SUPPORT_V1,
    e2e: E2E_SUPPORT_V1,
  });
  socket.emitMessage(JSON.stringify(malformed));

  assert.deepEqual(socket.closed[0], {
    code: 1003,
    reason: "invalid protocol message",
  });
});
