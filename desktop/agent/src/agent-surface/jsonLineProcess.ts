import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type { Logger } from "../telemetry/logger.ts";

export type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve(value: JsonObject): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface JsonLineProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  logger: Logger;
  logLabel: string;
  onMessage(message: JsonObject): void;
  onExit(error: Error): void;
  requestTimeoutMs?: number;
}

export class JsonLineProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly logger: Logger;
  private readonly logLabel: string;
  private readonly onMessage: (message: JsonObject) => void;
  private readonly onExit: (error: Error) => void;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private exitError: Error | null = null;

  constructor(options: JsonLineProcessOptions) {
    this.logger = options.logger;
    this.logLabel = options.logLabel;
    this.onMessage = options.onMessage;
    this.onExit = options.onExit;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout = createInterface({ input: this.child.stdout });
    stdout.on("line", (line) => this.handleLine(line));
    const stderr = createInterface({ input: this.child.stderr });
    stderr.on("line", (line) => {
      this.logger.debug(`${this.logLabel} stderr`, { message: line });
    });
    this.child.once("error", (error) => this.handleExit(error));
    this.child.once("exit", (code, signal) => {
      this.handleExit(
        new Error(
          `${this.logLabel} exited (code=${String(code)}, signal=${String(signal)})`,
        ),
      );
    });
  }

  request(method: string, params?: JsonObject): Promise<JsonObject> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.logLabel} request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({
          id,
          method,
          ...(params ? { params } : {}),
        });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(toError(error));
      }
    });
  }

  notify(method: string, params?: JsonObject): void {
    this.write({
      method,
      ...(params ? { params } : {}),
    });
  }

  send(message: JsonObject): void {
    this.write(message);
  }

  close(): void {
    if (!this.child.killed) {
      this.child.stdin.end();
      this.child.kill("SIGTERM");
    }
  }

  private write(message: JsonObject): void {
    if (this.exitError) {
      throw this.exitError;
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonObject;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) {
        throw new Error("message is not an object");
      }
      message = parsed;
    } catch (error) {
      this.logger.warn(`${this.logLabel} emitted invalid JSON`, {
        error: String(error),
        line: line.slice(0, 500),
      });
      return;
    }

    if (typeof message.method === "string") {
      this.onMessage(message);
      return;
    }

    const id = typeof message.id === "number" ? message.id : null;
    const pending = id === null ? undefined : this.pending.get(id);
    if (!pending) {
      this.onMessage(message);
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(id as number);
    if (isRecord(message.error)) {
      pending.reject(
        new Error(
          typeof message.error.message === "string"
            ? message.error.message
            : `${this.logLabel} request failed`,
        ),
      );
      return;
    }
    pending.resolve(isRecord(message.result) ? message.result : {});
  }

  private handleExit(error: Error): void {
    if (this.exitError) {
      return;
    }
    this.exitError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.onExit(error);
  }
}

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
