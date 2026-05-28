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
  /** tmux session uid，形如 `$1`，由 tmux server 分配，server 重启后重置。 */
  sessionUid: string;
  /** tmux server 进程 pid，与 sessionUid 组合可唯一标识"同一进程窗口"。 */
  serverPid: number;
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
  }): Promise<{ serverPid: number; sessionUid: string }> {
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
    // tmux 创建后立即取强 ID，以便 store 用 (serverPid, sessionUid) 绑定。
    return await this.getSessionIdentity(options.tmuxSessionName);
  }

  async listSessions(): Promise<TmuxSessionInfo[]> {
    try {
      const { stdout } = await execFileAsync("tmux", [
        "list-sessions",
        "-F",
        "#{session_name}\t#{session_id}\t#{pid}\t#{session_created}\t#{session_attached}\t#{pane_current_path}\t#{pane_current_command}",
      ]);

      return stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [
            name,
            sessionUid,
            serverPid,
            created,
            attached,
            currentPath,
            currentCommand,
          ] = line.split("\t");
          return {
            name,
            sessionUid,
            serverPid: Number(serverPid) || 0,
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

  /**
   * 取一个 tmux session 的强 ID：(serverPid, sessionUid)。
   * 用于 createSession 后立即绑定，或用于诊断"同名但不同实例"的场景。
   */
  async getSessionIdentity(
    tmuxSessionName: string,
  ): Promise<{ serverPid: number; sessionUid: string }> {
    const { stdout } = await runTmux(
      [
        "display-message",
        "-p",
        "-t",
        tmuxSessionName,
        "-F",
        "#{pid}\t#{session_id}",
      ],
      tmuxSessionName,
    );
    const [serverPidRaw, sessionUid] = stdout.trim().split("\t");
    const serverPid = Number(serverPidRaw) || 0;
    return { serverPid, sessionUid: sessionUid ?? "" };
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

  async getCursor(
    tmuxSessionName: string,
  ): Promise<{ x: number; y: number; paneHeight: number }> {
    const { stdout } = await runTmux(
      [
        "display-message",
        "-p",
        "-t",
        tmuxSessionName,
        "-F",
        "#{cursor_x},#{cursor_y},#{pane_height}",
      ],
      tmuxSessionName,
    );
    const [x, y, paneHeight] = stdout.trim().split(",").map(Number);
    return {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      paneHeight: Number.isFinite(paneHeight) ? paneHeight : 0,
    };
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
