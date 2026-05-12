import type { MessageEnvelope } from "../../protocol-ts/src/index.ts";

type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "close", listener: (event: unknown) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
};

export type RelayMessageHandler = (message: MessageEnvelope) => void;

export interface RelayConnectionOptions {
  url: string;
  webSocketFactory?: (url: string) => WebSocketLike;
}

export class RelayClient {
  private socket: WebSocketLike | null = null;
  private readonly handlers = new Set<RelayMessageHandler>();
  private readonly options: RelayConnectionOptions;

  constructor(options: RelayConnectionOptions) {
    this.options = options;
  }

  connect(): Promise<void> {
    if (this.socket && this.socket.readyState <= 1) {
      return Promise.resolve();
    }

    const factory = this.options.webSocketFactory ?? defaultWebSocketFactory;
    const socket = factory(this.options.url);
    this.socket = socket;

    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", (event) => reject(event));
      socket.addEventListener("message", (event) => this.handleMessage(event.data));
    });
  }

  onMessage(handler: RelayMessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  send(message: MessageEnvelope): void {
    if (!this.socket || this.socket.readyState !== 1) {
      throw new Error("Relay socket is not open");
    }

    this.socket.send(JSON.stringify(message));
  }

  close(code = 1000, reason = "client closing"): void {
    this.socket?.close(code, reason);
    this.socket = null;
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") {
      return;
    }

    const parsed = JSON.parse(raw) as MessageEnvelope;
    for (const handler of this.handlers) {
      handler(parsed);
    }
  }
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) {
    throw new Error("No global WebSocket implementation is available");
  }

  return new WebSocketCtor(url) as unknown as WebSocketLike;
}
