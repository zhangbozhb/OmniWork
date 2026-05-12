import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { CodexSession } from "../../../../packages/protocol-ts/src/index.ts";

export class JsonSessionStore {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async list(): Promise<CodexSession[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as { sessions: CodexSession[] };
      return parsed.sessions;
    } catch {
      return [];
    }
  }

  async saveAll(sessions: CodexSession[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, `${JSON.stringify({ sessions }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async upsert(session: CodexSession): Promise<void> {
    const sessions = await this.list();
    const existingIndex = sessions.findIndex((item) => item.session_id === session.session_id);
    if (existingIndex >= 0) {
      sessions[existingIndex] = session;
    } else {
      sessions.push(session);
    }
    await this.saveAll(sessions);
  }

  async remove(sessionId: string): Promise<void> {
    const sessions = await this.list();
    await this.saveAll(sessions.filter((session) => session.session_id !== sessionId));
  }
}
