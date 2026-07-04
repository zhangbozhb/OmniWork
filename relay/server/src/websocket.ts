import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

type MessageHandler = (message: string) => void;
type CloseHandler = () => void;

export interface WebSocketConnectionOptions {
  keepaliveIntervalMs?: number;
  pongTimeoutMs?: number;
}

export class WebSocketConnection {
  private readonly socket: Socket;
  private readonly keepaliveIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private buffer = Buffer.alloc(0);
  private closed = false;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();

  constructor(socket: Socket, options: WebSocketConnectionOptions = {}) {
    this.socket = socket;
    this.keepaliveIntervalMs = options.keepaliveIntervalMs ?? 0;
    this.pongTimeoutMs = options.pongTimeoutMs ?? 30_000;
    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("close", () => this.handleClose());
    socket.on("error", () => this.handleClose());
    this.startKeepalive();
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  sendText(message: string): void {
    if (this.closed) {
      return;
    }
    this.writeFrame(Buffer.from(message, "utf8"), 0x1);
  }

  close(code = 1000, reason = "closing"): void {
    if (this.closed) {
      return;
    }
    const reasonBytes = Buffer.from(reason, "utf8");
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.writeFrame(payload, 0x8);
    this.socket.end();
    this.handleClose();
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const frame = tryReadFrame(this.buffer);
      if (!frame) {
        return;
      }

      this.buffer = this.buffer.subarray(frame.bytesRead);
      if (frame.opcode === 0x8) {
        this.close();
        return;
      }
      if (frame.opcode === 0x9) {
        this.writeFrame(frame.payload, 0xA);
        continue;
      }
      if (frame.opcode === 0xA) {
        this.markPongReceived();
        continue;
      }
      if (frame.opcode !== 0x1) {
        continue;
      }

      const message = frame.payload.toString("utf8");
      for (const handler of this.messageHandlers) {
        handler(message);
      }
    }
  }

  private handleClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.stopKeepalive();
    for (const handler of this.closeHandlers) {
      handler();
    }
  }

  private startKeepalive(): void {
    if (this.keepaliveIntervalMs <= 0 || this.keepaliveTimer) {
      return;
    }
    this.keepaliveTimer = setInterval(() => {
      this.sendPing();
    }, this.keepaliveIntervalMs);
    this.keepaliveTimer.unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.clearPongTimeout();
  }

  private sendPing(): void {
    if (this.closed) {
      return;
    }
    if (this.pongTimeoutTimer) {
      return;
    }
    this.writeFrame(Buffer.alloc(0), 0x9);
    this.pongTimeoutTimer = setTimeout(() => {
      this.close(1001, "pong timeout");
    }, this.pongTimeoutMs);
    this.pongTimeoutTimer.unref?.();
  }

  private markPongReceived(): void {
    this.clearPongTimeout();
  }

  private clearPongTimeout(): void {
    if (this.pongTimeoutTimer) {
      clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = null;
    }
  }

  private writeFrame(payload: Buffer, opcode: number): void {
    try {
      this.socket.write(encodeFrame(payload, opcode));
    } catch {
      this.socket.destroy();
      this.handleClose();
    }
  }
}

export function acceptWebSocket(
  request: IncomingMessage,
  socket: Socket,
  options: WebSocketConnectionOptions = {},
): WebSocketConnection | null {
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return null;
  }

  const acceptKey = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "\r\n",
    ].join("\r\n"),
  );

  return new WebSocketConnection(socket, options);
}

interface DecodedFrame {
  opcode: number;
  payload: Buffer;
  bytesRead: number;
}

function tryReadFrame(buffer: Buffer): DecodedFrame | null {
  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (!fin) {
    return null;
  }

  if (length === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    const extendedLength = buffer.readBigUInt64BE(offset);
    if (extendedLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("WebSocket frame is too large");
    }
    length = Number(extendedLength);
    offset += 8;
  }

  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) {
    return null;
  }

  const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
  offset += maskLength;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }

  return {
    opcode,
    payload,
    bytesRead: offset + length,
  };
}

function encodeFrame(payload: Buffer, opcode: number): Buffer {
  const headerLength = payload.length < 126 ? 2 : payload.length <= 0xffff ? 4 : 10;
  const frame = Buffer.alloc(headerLength + payload.length);
  frame[0] = 0x80 | opcode;

  if (payload.length < 126) {
    frame[1] = payload.length;
  } else if (payload.length <= 0xffff) {
    frame[1] = 126;
    frame.writeUInt16BE(payload.length, 2);
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  payload.copy(frame, headerLength);
  return frame;
}
