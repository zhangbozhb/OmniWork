import type {
  CodexSession,
  TerminalFramePayload,
  TerminalInputPayload,
  TerminalResizePayload,
  TerminalSnapshotPayload,
} from "../../../../packages/protocol-ts/src/index.ts";
import {
  createControlInput,
  createPasteInput,
  createTextInput,
} from "../../../../packages/terminal-core/src/index.ts";
import { TmuxManager } from "../tmux-manager/tmuxManager.ts";

export class TerminalBridge {
  private readonly tmux: TmuxManager;
  private readonly inputQueues = new Map<string, Promise<void>>();

  constructor(tmux: TmuxManager) {
    this.tmux = tmux;
  }

  async writeInput(
    session: CodexSession,
    input: TerminalInputPayload,
  ): Promise<void> {
    const sessionId = session.session_id;
    const previous = this.inputQueues.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.writeInputNow(session, input));

    this.inputQueues.set(sessionId, next);

    try {
      await next;
    } finally {
      if (this.inputQueues.get(sessionId) === next) {
        this.inputQueues.delete(sessionId);
      }
    }
  }

  private async writeInputNow(
    session: CodexSession,
    input: TerminalInputPayload,
  ): Promise<void> {
    if (input.kind === "key") {
      await this.tmux.sendKey(session.tmux_session_name, toTmuxKey(input.data));
      return;
    }

    await this.writeTerminalData(session.tmux_session_name, input.data);
  }

  private async writeTerminalData(
    tmuxSessionName: string,
    data: string,
  ): Promise<void> {
    let literalBuffer = "";

    for (const char of data) {
      if (char === "\r" || char === "\n") {
        await this.flushLiteralInput(tmuxSessionName, literalBuffer);
        literalBuffer = "";
        await delay(40);
        await this.tmux.sendKey(tmuxSessionName, "Enter");
        continue;
      }

      literalBuffer += char;
    }

    await this.flushLiteralInput(tmuxSessionName, literalBuffer);
  }

  private async flushLiteralInput(
    tmuxSessionName: string,
    data: string,
  ): Promise<void> {
    if (!data) {
      return;
    }

    await this.tmux.sendLiteralInput(tmuxSessionName, data);
  }

  async resize(
    session: CodexSession,
    size: TerminalResizePayload,
  ): Promise<void> {
    await this.tmux.resize(session.tmux_session_name, size);
  }

  async snapshot(session: CodexSession): Promise<TerminalSnapshotPayload> {
    await this.waitForInputDrain(session.session_id);
    const [data, cursor] = await Promise.all([
      this.tmux.capturePane(session.tmux_session_name),
      this.tmux.getCursor(session.tmux_session_name).catch(() => null),
    ]);
    return {
      data: cursor ? overlayCursor(data, cursor) : data,
      size: session.terminal_size,
      captured_at: new Date().toISOString(),
    };
  }

  async frame(session: CodexSession): Promise<TerminalFramePayload> {
    await this.waitForInputDrain(session.session_id);
    const [pane, cursor] = await Promise.all([
      this.tmux.capturePane(session.tmux_session_name),
      this.tmux.getCursor(session.tmux_session_name).catch(() => null),
    ]);
    return {
      data: cursor ? overlayCursor(pane, cursor) : pane,
      snapshot: true,
    };
  }

  private async waitForInputDrain(sessionId: string): Promise<void> {
    await (this.inputQueues.get(sessionId) ?? Promise.resolve());
  }
}

export const terminalInputs = {
  text: createTextInput,
  paste: createPasteInput,
  control: createControlInput,
};

function toTmuxKey(data: string): string {
  switch (data) {
    case "\u001b":
      return "Escape";
    case "\t":
      return "Tab";
    case "\r":
      return "Enter";
    case "\u007f":
      return "BSpace";
    case "\u0003":
      return "C-c";
    case "\u0004":
      return "C-d";
    case "\u000c":
      return "C-l";
    case "\u001b[A":
      return "Up";
    case "\u001b[B":
      return "Down";
    case "\u001b[C":
      return "Right";
    case "\u001b[D":
      return "Left";
    default:
      return data;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// 把 tmux capture-pane 的纯文本输出叠加上光标位置：用 ANSI 反色 (ESC[7m … ESC[27m)
// 包裹光标所在字符（若该位置为空，则注入一个空格作为光标块）。这样前端 ANSI
// 解析器原样渲染即可显示光标块。
function overlayCursor(
  pane: string,
  cursor: { x: number; y: number; paneHeight: number },
): string {
  // tmux capture-pane 的输出通常以一个换行符结尾，split 后会得到一个尾部空串，
  // 这会让后续以 lines.length 反推 visibleTop 时多算一行，导致光标显示在
  // 实际 prompt 的下一行。先把这个尾部空行剔除。
  const lines = pane.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  if (lines.length === 0) {
    return pane;
  }
  // tmux 的 cursor_y 是相对 **可见 pane** 顶部（0..paneHeight-1），而我们抓取
  // 时使用了 `-S -lines` 把 history 也带了出来。真实行号需要从底部反推：
  //   visibleTop = totalLines - paneHeight
  //   targetIndex = visibleTop + cursor_y
  // 当 paneHeight 不可用时，退化为 cursor_y 直接索引。
  const paneHeight = cursor.paneHeight > 0 ? cursor.paneHeight : lines.length;
  const visibleTop = Math.max(0, lines.length - paneHeight);
  const targetIndex = Math.min(
    Math.max(visibleTop + cursor.y, 0),
    lines.length - 1,
  );
  const line = lines[targetIndex] ?? "";
  // 计算第 cursor.x 个"可视字符"在去除 ANSI 转义后的位置；为简化先按
  // 不含 ANSI 的常规字符处理（agent 端侧的 prompt 通常已经被 capture 直接
  // 落为文本；如未来出现混排可再升级）。
  const x = Math.max(cursor.x, 0);
  let head = line;
  let tail = "";
  let cell = " ";
  if (x < line.length) {
    head = line.slice(0, x);
    cell = line.slice(x, x + 1);
    tail = line.slice(x + 1);
  } else {
    head = line + " ".repeat(x - line.length);
    cell = " ";
    tail = "";
  }
  lines[targetIndex] = `${head}\u001b[7m${cell}\u001b[27m${tail}`;
  return lines.join("\n");
}
