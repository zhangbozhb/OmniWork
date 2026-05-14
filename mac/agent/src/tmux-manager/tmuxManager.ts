import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { TerminalSize } from "../../../../packages/protocol-ts/src/index.ts";

const execFileAsync = promisify(execFile);

export class TmuxTargetMissingError extends Error {
  readonly code = "TMUX_TARGET_MISSING";
  readonly tmuxTarget: string;

  constructor(tmuxTarget: string, cause: unknown) {
    super(`tmux target is no longer available: ${tmuxTarget}`, { cause });
    this.name = "TmuxTargetMissingError";
    this.tmuxTarget = tmuxTarget;
  }
}

export interface TmuxSessionInfo {
  name: string;
  createdAt: string;
  attached: boolean;
  currentPath?: string;
  currentCommand?: string;
}

export class TmuxManager {
  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync("tmux", ["-V"]);
      return true;
    } catch {
      return false;
    }
  }

  async createSession(options: {
    tmuxSessionName: string;
    cwd: string;
    command: string;
    size: TerminalSize;
  }): Promise<void> {
    await runTmux([
      "new-session",
      "-d",
      "-s",
      options.tmuxSessionName,
      "-x",
      String(options.size.cols),
      "-y",
      String(options.size.rows),
      "-c",
      options.cwd,
      options.command,
    ]);
  }

  async listSessions(): Promise<TmuxSessionInfo[]> {
    try {
      const { stdout } = await execFileAsync("tmux", [
        "list-sessions",
        "-F",
        "#{session_name}\t#{session_created}\t#{session_attached}\t#{pane_current_path}\t#{pane_current_command}",
      ]);

      return stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name, created, attached, currentPath, currentCommand] =
            line.split("\t");
          return {
            name,
            createdAt: new Date(Number(created) * 1000).toISOString(),
            attached: attached === "1",
            currentPath,
            currentCommand,
          };
        });
    } catch {
      return [];
    }
  }

  async sendInput(tmuxSessionName: string, data: string): Promise<void> {
    await this.sendLiteralInput(tmuxSessionName, data);
  }

  async sendLiteralInput(tmuxSessionName: string, data: string): Promise<void> {
    if (!data) {
      return;
    }

    await runTmux(
      ["send-keys", "-t", tmuxSessionName, "-l", data],
      tmuxSessionName,
    );
  }

  async sendKey(tmuxSessionName: string, key: string): Promise<void> {
    await runTmux(["send-keys", "-t", tmuxSessionName, key], tmuxSessionName);
  }

  async resize(tmuxSessionName: string, size: TerminalSize): Promise<void> {
    await runTmux(
      [
        "resize-window",
        "-t",
        tmuxSessionName,
        "-x",
        String(size.cols),
        "-y",
        String(size.rows),
      ],
      tmuxSessionName,
    );
  }

  async capturePane(tmuxSessionName: string, lines = 200): Promise<string> {
    const { stdout } = await runTmux(
      ["capture-pane", "-p", "-t", tmuxSessionName, "-S", `-${lines}`],
      tmuxSessionName,
    );
    return stdout;
  }

  async killSession(tmuxSessionName: string): Promise<void> {
    await runTmux(["kill-session", "-t", tmuxSessionName], tmuxSessionName);
  }
}

async function runTmux(
  args: string[],
  tmuxTarget?: string,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("tmux", args, { encoding: "utf8" });
  } catch (error) {
    if (tmuxTarget && isMissingTargetError(error)) {
      throw new TmuxTargetMissingError(tmuxTarget, error);
    }

    throw error;
  }
}

function isMissingTargetError(error: unknown): boolean {
  const stderr = getErrorField(error, "stderr").toLowerCase();
  const message = getErrorField(error, "message").toLowerCase();
  const details = `${stderr}\n${message}`;
  return (
    details.includes("can't find pane") ||
    details.includes("can't find session") ||
    details.includes("can't find window")
  );
}

function getErrorField(error: unknown, key: "message" | "stderr"): string {
  if (!error || typeof error !== "object" || !(key in error)) {
    return "";
  }

  const value = (error as Record<typeof key, unknown>)[key];
  return typeof value === "string" ? value : "";
}
