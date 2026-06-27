import type { TransportPath } from "@omniwork/protocol-ts";
import type {
  MessageHandler,
  PathChangeHandler,
  TransportEvent,
  TransportEventHandler,
} from "./types.ts";

export class TransportEventBus {
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly pathChangeHandlers = new Set<PathChangeHandler>();
  private readonly eventHandlers = new Set<TransportEventHandler>();

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onPathChange(handler: PathChangeHandler): () => void {
    this.pathChangeHandlers.add(handler);
    return () => {
      this.pathChangeHandlers.delete(handler);
    };
  }

  onEvent(handler: TransportEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  emitMessage(message: Parameters<MessageHandler>[0]): void {
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  emitPathChange(path: TransportPath): void {
    for (const handler of this.pathChangeHandlers) {
      handler(path);
    }
  }

  emitEvent(event: TransportEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        /* ignore */
      }
    }
  }

  clear(): void {
    this.messageHandlers.clear();
    this.pathChangeHandlers.clear();
    this.eventHandlers.clear();
  }
}
