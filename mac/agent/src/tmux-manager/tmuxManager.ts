import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { TerminalSize } from "../../../../packages/protocol-ts/src/index.ts";

const execFileAsync = promisify(execFile);

export interface TmuxSessionInfo {
  name: string;
  createdAt: string;
  attached: boolean;
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
    await execFileAsync("tmux", [
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
        "#{session_name}\t#{session_created}\t#{session_attached}",
      ]);

      return stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name, created, attached] = line.split("\t");
          return {
            name,
            createdAt: new Date(Number(created) * 1000).toISOString(),
            attached: attached === "1",
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

    await execFileAsync("tmux", ["send-keys", "-t", tmuxSessionName, "-l", data]);
  }

  async sendKey(tmuxSessionName: string, key: string): Promise<void> {
    await execFileAsync("tmux", ["send-keys", "-t", tmuxSessionName, key]);
  }

  async resize(tmuxSessionName: string, size: TerminalSize): Promise<void> {
    await execFileAsync("tmux", [
      "resize-window",
      "-t",
      tmuxSessionName,
      "-x",
      String(size.cols),
      "-y",
      String(size.rows),
    ]);
  }

  async capturePane(tmuxSessionName: string, lines = 200): Promise<string> {
    const { stdout } = await execFileAsync("tmux", [
      "capture-pane",
      "-p",
      "-t",
      tmuxSessionName,
      "-S",
      `-${lines}`,
    ]);
    return stdout;
  }

  async killSession(tmuxSessionName: string): Promise<void> {
    await execFileAsync("tmux", ["kill-session", "-t", tmuxSessionName]);
  }
}
