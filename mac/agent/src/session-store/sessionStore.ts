import { mkdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";

import type {
  CodexSession,
  RuntimeKind,
} from "../../../../packages/protocol-ts/src/index.ts";
import { formatLocalTimestamp } from "../telemetry/logger.ts";

interface SessionRow {
  session_id: string;
  payload: string;
}

/**
 * SQLiteSessionStore：持久化 sessions.sqlite 的轻量封装。
 *
 * 关键约束：
 * - **进程内串行**：所有写入经 `withWriteLock` 排队，避免 list reconcile 与
 *   create/attach 并发互相覆盖；`list()` 是只读路径，无需排队。
 * - **SQLite 事务**：批量覆盖、upsert、remove 均通过 SQLite 事务或单语句提交；
 *   跨进程写入互斥由 SQLite 自身负责，避免手写 lockfile。
 * - **结构化删除日志**：`remove()` 命中条目时打印 reason，便于排查"会话
 *   被吃掉了"这类反馈（详见 docs/relay-architecture.md）。
 */
export class SQLiteSessionStore {
  private readonly path: string;
  private readonly legacyJsonPath: string;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private db: DatabaseSync | null = null;

  constructor(path: string) {
    this.path = path.endsWith(".json") ? path.replace(/\.json$/, ".sqlite") : path;
    this.legacyJsonPath = path.endsWith(".json")
      ? path
      : join(dirname(this.path), "sessions.json");
  }

  async list(): Promise<CodexSession[]> {
    const db = await this.open();
    const rows = db
      .prepare(
        "SELECT session_id, payload FROM sessions ORDER BY created_at ASC, session_id ASC",
      )
      .all() as unknown as SessionRow[];
    return rows.flatMap((row) => {
      try {
        return [normalizeSession(JSON.parse(row.payload) as CodexSession)];
      } catch {
        return [];
      }
    });
  }

  async saveAll(sessions: CodexSession[]): Promise<void> {
    await this.withWriteLock(async () => {
      const db = await this.open();
      this.runTransaction(db, () => {
        db.prepare("DELETE FROM sessions").run();
        const insert = db.prepare(
          "INSERT INTO sessions (session_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)",
        );
        for (const session of sessions) {
          insert.run(
            session.session_id,
            JSON.stringify(session),
            session.created_at,
            session.last_active_at,
          );
        }
      });
    });
  }

  async upsert(session: CodexSession): Promise<void> {
    await this.withWriteLock(async () => {
      const db = await this.open();
      db.prepare(
        `
          INSERT INTO sessions (session_id, payload, created_at, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            payload = excluded.payload,
            updated_at = excluded.updated_at
        `,
      ).run(
        session.session_id,
        JSON.stringify(session),
        session.created_at,
        session.last_active_at,
      );
    });
  }

  async remove(sessionId: string, reason?: string): Promise<void> {
    await this.withWriteLock(async () => {
      const db = await this.open();
      const result = db
        .prepare("DELETE FROM sessions WHERE session_id = ?")
        .run(sessionId);
      if (result.changes === 0) {
        return;
      }
      // 结构化日志：方便用户反馈"我的 session 突然没了"时溯源。
      // eslint-disable-next-line no-console
      console.info(
        JSON.stringify({
          ts: formatLocalTimestamp(),
          event: "session_store.remove",
          session_id: sessionId,
          reason: reason ?? "unspecified",
          remaining: this.countSessions(db),
        }),
      );
    });
  }

  /**
   * 串行化所有写入路径，避免 list reconcile 与 upsert/remove 并发覆盖。
   * 只对当前进程生效；跨进程互斥交给 SQLite 写锁与 busy_timeout。
   */
  private withWriteLock<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(task, task);
    // 即使 task 抛错也不能阻塞后续写入。
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private async open(): Promise<DatabaseSync> {
    if (this.db) {
      return this.db;
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db = db;
    await this.importLegacyJsonIfEmpty(db);
    return db;
  }

  private countSessions(db: DatabaseSync): number {
    const row = db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
      count: number;
    };
    return row.count;
  }

  private async importLegacyJsonIfEmpty(db: DatabaseSync): Promise<void> {
    if (this.countSessions(db) > 0) {
      return;
    }
    const legacyPath = this.legacyJsonPath;
    if (legacyPath === this.path) {
      return;
    }
    try {
      const raw = await readFile(legacyPath, "utf8");
      const parsed = JSON.parse(raw) as { sessions?: CodexSession[] };
      if (!Array.isArray(parsed.sessions) || parsed.sessions.length === 0) {
        return;
      }
      const legacySessions = parsed.sessions;
      const insert = db.prepare(
        "INSERT OR REPLACE INTO sessions (session_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)",
      );
      this.runTransaction(db, () => {
        for (const session of legacySessions.map(normalizeSession)) {
          insert.run(
            session.session_id,
            JSON.stringify(session),
            session.created_at,
            session.last_active_at,
          );
        }
      });
    } catch {
      // legacy sessions.json 不存在或不可读时直接从空 SQLite store 开始。
    }
  }

  private runTransaction(db: DatabaseSync, task: () => void): void {
    db.exec("BEGIN IMMEDIATE");
    try {
      task();
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // rollback 失败时保留原始错误。
      }
      throw error;
    }
  }
}

function normalizeSession(session: CodexSession): CodexSession {
  const runtimeKind = (session.runtime_kind ?? "unknown") as RuntimeKind;
  return {
    ...session,
    runtime_kind: runtimeKind,
    runtime_label: session.runtime_label ?? runtimeKind,
    origin: session.origin ?? "managed",
    registered: session.registered ?? true,
  };
}
