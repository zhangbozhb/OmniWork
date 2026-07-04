import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { setTimeout as wait } from "node:timers/promises";

import { WebSocketConnection } from "../src/websocket.ts";

class FakeSocket extends EventEmitter {
  readonly writes: Buffer[] = [];

  write(data: Buffer | string): boolean {
    this.writes.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    return true;
  }

  end(): void {
    this.emit("close");
  }

  destroy(): void {
    this.emit("close");
  }

  emitData(data: Buffer): void {
    this.emit("data", data);
  }
}

{
  const socket = new FakeSocket();
  const connection = new WebSocketConnection(socket as unknown as Socket, {
    keepaliveIntervalMs: 5,
    pongTimeoutMs: 5,
  });
  let closed = false;
  connection.onClose(() => {
    closed = true;
  });

  await wait(20);

  assert.ok(socket.writes.some((write) => frameOpcode(write) === 0x9));
  assert.equal(closed, true);
}

{
  const socket = new FakeSocket();
  const connection = new WebSocketConnection(socket as unknown as Socket, {
    keepaliveIntervalMs: 5,
    pongTimeoutMs: 30,
  });
  let closed = false;
  connection.onClose(() => {
    closed = true;
  });

  await wait(8);
  socket.emitData(Buffer.from([0x8a, 0x00]));
  await wait(10);

  assert.ok(socket.writes.some((write) => frameOpcode(write) === 0x9));
  assert.equal(closed, false);
  connection.close();
}

console.log("websocket tests passed");

function frameOpcode(frame: Buffer): number {
  return frame[0] & 0x0f;
}
