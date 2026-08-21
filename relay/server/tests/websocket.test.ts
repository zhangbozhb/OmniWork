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
  socket.emitData(encodeClientFrame(Buffer.alloc(0), 0xA));
  await wait(10);

  assert.ok(socket.writes.some((write) => frameOpcode(write) === 0x9));
  assert.equal(closed, false);
  connection.close();
}

{
  const socket = new FakeSocket();
  const connection = new WebSocketConnection(socket as unknown as Socket);
  let closed = false;
  connection.onClose(() => {
    closed = true;
  });

  assert.doesNotThrow(() => {
    socket.emitData(
      Buffer.from([0x81, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    );
  });

  const closeFrame = socket.writes.find((write) => frameOpcode(write) === 0x8);
  assert.ok(closeFrame);
  assert.equal(frameCloseCode(closeFrame), 1009);
  assert.equal(closed, true);
}

{
  const socket = new FakeSocket();
  const connection = new WebSocketConnection(socket as unknown as Socket);
  let closed = false;
  connection.onClose(() => {
    closed = true;
  });

  assert.doesNotThrow(() => {
    socket.emitData(Buffer.from([0x81, 0x00]));
  });

  const closeFrame = socket.writes.find((write) => frameOpcode(write) === 0x8);
  assert.ok(closeFrame);
  assert.equal(frameCloseCode(closeFrame), 1002);
  assert.equal(closed, true);
}

console.log("websocket tests passed");

function frameOpcode(frame: Buffer): number {
  return frame[0] & 0x0f;
}

function frameCloseCode(frame: Buffer): number {
  return frame.readUInt16BE(2);
}

function encodeClientFrame(payload: Buffer, opcode: number): Buffer {
  assert.ok(payload.length < 126);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const frame = Buffer.alloc(2 + mask.length + payload.length);
  frame[0] = 0x80 | opcode;
  frame[1] = 0x80 | payload.length;
  mask.copy(frame, 2);
  for (let index = 0; index < payload.length; index += 1) {
    frame[6 + index] = payload[index] ^ mask[index % mask.length];
  }
  return frame;
}
