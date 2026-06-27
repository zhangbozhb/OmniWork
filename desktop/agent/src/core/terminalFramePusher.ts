import { createHash } from "node:crypto";

import {
  createMessage,
  type MessageEnvelope,
  type P2pChannelKind,
  type TerminalFramePayload,
} from "@omniwork/protocol-ts";
import { TerminalBridge } from "../pty-bridge/terminalBridge.ts";
import { TmuxTargetMissingError } from "../tmux-manager/tmuxManager.ts";
import { DISPLAY_FRAME_BUFFERED_AMOUNT_LIMIT } from "../transport/index.ts";
import type { Logger } from "../telemetry/logger.ts";
import type { SessionManager } from "./sessionManager.ts";

const TERMINAL_PUSH_INTERVAL_MS = 450;

type TerminalFramePusherOptions = {
  deviceId: string;
  logTransport: boolean;
  logger: Logger;
  sessionManager: SessionManager;
  terminalBridge: TerminalBridge;
  getBufferedAmountForApp(appConnectionId: string): number;
  emitDisplayFrameDeferred(
    appConnectionId: string,
    bufferedAmount: number,
  ): void;
  sendToAppByConnectionId(
    appConnectionId: string,
    message: MessageEnvelope,
    channel?: P2pChannelKind,
  ): void;
  onMissingTmuxTarget(
    sessionId: string,
    error: TmuxTargetMissingError,
  ): Promise<void>;
};

export class TerminalFramePusher {
  private readonly terminalPushers = new Map<string, NodeJS.Timeout>();
  private readonly terminalLastFrameHash = new Map<string, string>();
  private readonly terminalFrameSeq = new Map<string, number>();
  private readonly terminalSubscribers = new Map<string, Set<string>>();
  private readonly pendingTerminalFrames = new Map<string, MessageEnvelope>();
  private readonly options: TerminalFramePusherOptions;

  constructor(options: TerminalFramePusherOptions) {
    this.options = options;
  }

  start(sessionId: string): void {
    if (this.terminalPushers.has(sessionId)) {
      return;
    }

    const timer = setInterval(() => {
      void this.pushIfChanged(sessionId);
    }, TERMINAL_PUSH_INTERVAL_MS);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    this.terminalPushers.set(sessionId, timer);
  }

  stop(sessionId: string): void {
    const timer = this.terminalPushers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.terminalPushers.delete(sessionId);
    }
    this.terminalLastFrameHash.delete(sessionId);
    this.terminalFrameSeq.delete(sessionId);
    this.terminalSubscribers.delete(sessionId);
    for (const key of [...this.pendingTerminalFrames.keys()]) {
      if (key.endsWith(`|${sessionId}`)) {
        this.pendingTerminalFrames.delete(key);
      }
    }
  }

  addSubscriber(sessionId: string, appConnectionId: string): void {
    const subscribers =
      this.terminalSubscribers.get(sessionId) ?? new Set<string>();
    subscribers.add(appConnectionId);
    this.terminalSubscribers.set(sessionId, subscribers);
  }

  nextSeq(sessionId: string): number {
    const seq = (this.terminalFrameSeq.get(sessionId) ?? 0) + 1;
    this.terminalFrameSeq.set(sessionId, seq);
    return seq;
  }

  rememberFrameData(sessionId: string, data: string): void {
    this.terminalLastFrameHash.set(sessionId, hashFrameData(data));
  }

  private async pushIfChanged(sessionId: string): Promise<void> {
    const session =
      this.options.sessionManager.getKnown(sessionId) ??
      (await this.options.sessionManager.get(sessionId));
    if (!session) {
      this.stop(sessionId);
      return;
    }
    if (session.status !== "running" && session.status !== "detached") {
      return;
    }

    let frame: TerminalFramePayload;
    try {
      frame = await this.options.terminalBridge.frame(session);
    } catch (error) {
      if (error instanceof TmuxTargetMissingError) {
        await this.options.onMissingTmuxTarget(sessionId, error);
        return;
      }
      this.options.logger.warn("terminal frame capture failed", {
        session_id: sessionId,
        error: String(error),
      });
      return;
    }

    const subscribers = this.terminalSubscribers.get(sessionId);
    if (!subscribers || subscribers.size === 0) {
      return;
    }

    this.flushPending(sessionId, subscribers);

    const hash = hashFrameData(frame.data);
    if (this.terminalLastFrameHash.get(sessionId) === hash) {
      return;
    }
    this.terminalLastFrameHash.set(sessionId, hash);
    const frameSeq = this.nextSeq(sessionId);
    const enrichedFrame: TerminalFramePayload = {
      ...frame,
      captured_at: new Date().toISOString(),
      byte_length: Buffer.byteLength(frame.data, "utf8"),
    };

    const frameMessage = createMessage<TerminalFramePayload>(
      "terminal.frame",
      enrichedFrame,
      {
        device_id: this.options.deviceId,
        session_id: sessionId,
        surface_id: session.primary_surface_id,
        seq: frameSeq,
      },
    );
    for (const appConnectionId of subscribers) {
      this.sendDisplayFrame(appConnectionId, sessionId, frameMessage);
    }
  }

  private flushPending(sessionId: string, subscribers: Set<string>): void {
    for (const appConnectionId of subscribers) {
      const key = terminalFramePendingKey(appConnectionId, sessionId);
      const pending = this.pendingTerminalFrames.get(key);
      if (!pending || this.isDisplayFrameBackpressured(appConnectionId)) {
        continue;
      }
      this.pendingTerminalFrames.delete(key);
      this.options.sendToAppByConnectionId(appConnectionId, pending, "display");
    }
  }

  private sendDisplayFrame(
    appConnectionId: string,
    sessionId: string,
    frameMessage: MessageEnvelope<TerminalFramePayload>,
  ): void {
    const pendingKey = terminalFramePendingKey(appConnectionId, sessionId);
    if (this.isDisplayFrameBackpressured(appConnectionId)) {
      if (
        this.pendingTerminalFrames.has(pendingKey) &&
        this.options.logTransport
      ) {
        this.options.logger.debug("terminal display frame dropped", {
          app_connection_id: appConnectionId,
          session_id: sessionId,
        });
      }
      this.pendingTerminalFrames.set(pendingKey, frameMessage);
      return;
    }

    const pending = this.pendingTerminalFrames.get(pendingKey);
    if (pending) {
      this.pendingTerminalFrames.delete(pendingKey);
      if (this.options.logTransport) {
        this.options.logger.debug("terminal display frame replaced", {
          app_connection_id: appConnectionId,
          session_id: sessionId,
        });
      }
    }
    this.options.sendToAppByConnectionId(
      appConnectionId,
      frameMessage,
      "display",
    );
  }

  private isDisplayFrameBackpressured(appConnectionId: string): boolean {
    const bufferedAmount =
      this.options.getBufferedAmountForApp(appConnectionId) ?? 0;
    if (bufferedAmount < DISPLAY_FRAME_BUFFERED_AMOUNT_LIMIT) {
      return false;
    }
    this.options.emitDisplayFrameDeferred(appConnectionId, bufferedAmount);
    return true;
  }
}

function hashFrameData(data: string): string {
  return createHash("sha1").update(data).digest("hex");
}

function terminalFramePendingKey(
  appConnectionId: string,
  sessionId: string,
): string {
  return `${appConnectionId}|${sessionId}`;
}
