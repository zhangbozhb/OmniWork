import type { WebRtcDataChannelLike } from "../../../packages/relay-client/src/webrtcTransport.ts";

type MessageHandler = (message: string) => void;
type CloseHandler = () => void;

export class DataChannelSocket {
  private readonly channel: WebRtcDataChannelLike;
  private closed = false;
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();

  constructor(channel: WebRtcDataChannelLike) {
    this.channel = channel;
    this.channel.onmessage = (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      for (const handler of this.messageHandlers) {
        handler(event.data);
      }
    };
    this.channel.onclose = () => this.handleClose();
    this.channel.onerror = () => this.handleClose();
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
    if (this.closed || this.channel.readyState !== "open") {
      return;
    }

    this.channel.send(message);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.channel.close();
    this.handleClose();
  }

  private handleClose(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const handler of this.closeHandlers) {
      handler();
    }
  }
}
