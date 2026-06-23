import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ReadStream } from "node:fs";

import {
  createMessage,
  type MessageEnvelope,
  type P2pChannelKind,
  type TerminalStreamDataPayload,
  type TerminalStreamErrorPayload,
  type TerminalStreamReadyPayload,
} from "@omniwork/protocol-ts";
import {
  TmuxManager,
  TmuxTargetMissingError,
} from "../tmux-manager/tmuxManager.ts";
import type { Logger } from "../telemetry/logger.ts";
import type { SessionManager } from "./sessionManager.ts";

const execFileAsync = promisify(execFile);

type TerminalStreamPusherOptions = {
  deviceId: string;
  enabled: boolean;
  logger: Logger;
  sessionManager: SessionManager;
  tmux: TmuxManager;
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

type StreamState = {
  sessionId: string;
  tmuxSessionName: string;
  streamId: string;
  directory: string;
  fifoPath: string;
  reader: ReadStream;
  subscribers: Set<string>;
  seq: number;
};

export class TerminalStreamPusher {
  private readonly streams = new Map<string, StreamState>();
  private readonly options: TerminalStreamPusherOptions;

  constructor(options: TerminalStreamPusherOptions) {
    this.options = options;
  }

  async start(sessionId: string, appConnectionId: string): Promise<void> {
    if (!this.options.enabled) {
      this.sendError(appConnectionId, sessionId, {
        code: "TERMINAL_STREAM_DISABLED",
        message: "Terminal byte stream is disabled on this Mac Agent.",
      });
      return;
    }

    const session = await this.options.sessionManager.get(sessionId);
    if (!session) {
      return;
    }
    if (session.status !== "running" && session.status !== "detached") {
      this.sendError(appConnectionId, sessionId, {
        code: "TERMINAL_STREAM_UNAVAILABLE",
        message: "Terminal byte stream requires a running tmux session.",
      });
      return;
    }

    const current = this.streams.get(sessionId);
    if (current) {
      current.subscribers.add(appConnectionId);
      this.sendReady(appConnectionId, current);
      return;
    }

    let state: StreamState | null = null;
    try {
      state = await this.createStream(sessionId, session.tmux_session_name);
      this.streams.set(sessionId, state);
      state.subscribers.add(appConnectionId);
      this.sendReady(appConnectionId, state);
    } catch (error) {
      if (state) {
        await this.cleanupState(state, "start_failed");
      }
      if (error instanceof TmuxTargetMissingError) {
        await this.options.onMissingTmuxTarget(sessionId, error);
        return;
      }
      this.options.logger.warn("terminal stream start failed", {
        session_id: sessionId,
        error: String(error),
      });
      this.sendError(appConnectionId, sessionId, {
        code: "TERMINAL_STREAM_START_FAILED",
        message: "Terminal byte stream could not be started.",
      });
    }
  }

  async stop(sessionId: string, appConnectionId?: string): Promise<void> {
    const state = this.streams.get(sessionId);
    if (!state) {
      return;
    }
    if (appConnectionId) {
      state.subscribers.delete(appConnectionId);
    }
    if (!appConnectionId || state.subscribers.size === 0) {
      await this.cleanupState(state, "stop");
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.streams.values()].map((state) =>
        this.cleanupState(state, "agent_stop"),
      ),
    );
  }

  private async createStream(
    sessionId: string,
    tmuxSessionName: string,
  ): Promise<StreamState> {
    const directory = await mkdtemp(join(tmpdir(), "omniwork-terminal-"));
    const fifoPath = join(directory, "pane.out");
    await execFileAsync("mkfifo", [fifoPath]);

    const state: StreamState = {
      sessionId,
      tmuxSessionName,
      streamId: `term_stream_${randomUUID()}`,
      directory,
      fifoPath,
      reader: createReadStream(fifoPath, { encoding: "utf8" }),
      subscribers: new Set<string>(),
      seq: 0,
    };

    state.reader.on("data", (chunk) => {
      this.broadcastData(state, String(chunk));
    });
    state.reader.on("error", (error) => {
      this.options.logger.warn("terminal stream read failed", {
        session_id: sessionId,
        error: String(error),
      });
      void this.cleanupState(state, "read_error");
    });

    await this.options.tmux.pipePane(
      tmuxSessionName,
      `cat > ${shellQuote(fifoPath)}`,
    );
    return state;
  }

  private broadcastData(state: StreamState, data: string): void {
    if (!data) {
      return;
    }
    state.seq += 1;
    const payload: TerminalStreamDataPayload = {
      stream_id: state.streamId,
      encoding: "utf8",
      data,
      emitted_at: new Date().toISOString(),
      byte_length: Buffer.byteLength(data, "utf8"),
    };
    const message = createMessage<TerminalStreamDataPayload>(
      "terminal.stream.data",
      payload,
      {
        device_id: this.options.deviceId,
        session_id: state.sessionId,
        seq: state.seq,
      },
    );
    for (const appConnectionId of state.subscribers) {
      this.options.sendToAppByConnectionId(appConnectionId, message, "display");
    }
  }

  private sendReady(appConnectionId: string, state: StreamState): void {
    this.options.sendToAppByConnectionId(
      appConnectionId,
      createMessage<TerminalStreamReadyPayload>(
        "terminal.stream.ready",
        {
          stream_id: state.streamId,
          encoding: "utf8",
          started_at: new Date().toISOString(),
        },
        {
          device_id: this.options.deviceId,
          session_id: state.sessionId,
        },
      ),
      "control",
    );
  }

  private sendError(
    appConnectionId: string,
    sessionId: string,
    payload: TerminalStreamErrorPayload,
  ): void {
    this.options.sendToAppByConnectionId(
      appConnectionId,
      createMessage<TerminalStreamErrorPayload>("terminal.stream.error", payload, {
        device_id: this.options.deviceId,
        session_id: sessionId,
      }),
      "control",
    );
  }

  private async cleanupState(state: StreamState, reason: string): Promise<void> {
    if (this.streams.get(state.sessionId) === state) {
      this.streams.delete(state.sessionId);
    }
    state.reader.destroy();
    try {
      await this.options.tmux.stopPipePane(state.tmuxSessionName);
    } catch (error) {
      if (!(error instanceof TmuxTargetMissingError)) {
        this.options.logger.warn("terminal stream pipe cleanup failed", {
          session_id: state.sessionId,
          reason,
          error: String(error),
        });
      }
    }
    await rm(state.directory, { recursive: true, force: true });
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
