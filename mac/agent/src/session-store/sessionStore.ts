import { open, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, basename } from "node:path";

import type {
  CodexSession,
  RuntimeKind,
} from "../../../../packages/protocol-ts/src/index.ts";

/**
 * JsonSessionStore：持久化 sessions.json 的轻量封装。
 *
 * 关键约束（来自方案 1+4）：
 * - **进程内串行**：所有写入经 `withWriteLock` 排队，避免 list reconcile 与
 *   create/attach 并发互相覆盖；`list()` 是只读路径，无需排队。
 * - **跨进程互斥（lockfile）**：保存前抢占 `<path>.lock`，agent 升级或人工
 *   误开两个实例时能拿到 EEXIST 错误，避免"内存有、磁盘没"的偏差。
 * - **原子写入**：先写 `<path>.tmp.<rand>`，再 `rename` 替换原文件；rename
 *   在同一文件系统下是原子操作，可以杜绝写到一半被读到半截 JSON 的情况。
 * - **结构化删除日志**：`remove()` 命中条目时打印 reason，便于排查"会话
 *   被吃掉了"这类反馈（详见 docs/relay-architecture.md）。
 */
export class JsonSessionStore {
  private readonly path: string;
  private readonly lockPath: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
    this.lockPath = `${path}.lock`;
  }

  async list(): Promise<CodexSession[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as { sessions: CodexSession[] };
      return parsed.sessions.map(normalizeSession);
    } catch {
      return [];
    }
  }

  async saveAll(sessions: CodexSession[]): Promise<void> {
    await this.withWriteLock(() => this.writeAtomic(sessions));
  }

  async upsert(session: CodexSession): Promise<void> {
    await this.withWriteLock(async () => {
      const sessions = await this.list();
      const existingIndex = sessions.findIndex(
        (item) => item.session_id === session.session_id,
      );
      if (existingIndex >= 0) {
        sessions[existingIndex] = session;
      } else {
        sessions.push(session);
      }
      await this.writeAtomic(sessions);
    });
  }

  async remove(sessionId: string, reason?: string): Promise<void> {
    await this.withWriteLock(async () => {
      const sessions = await this.list();
      const next = sessions.filter((session) => session.session_id !== sessionId);
      if (next.length === sessions.length) {
        return;
      }
      // 结构化日志：方便用户反馈"我的 session 突然没了"时溯源。
      // eslint-disable-next-line no-console
      console.info(
        JSON.stringify({
          event: "session_store.remove",
          session_id: sessionId,
          reason: reason ?? "unspecified",
          remaining: next.length,
        }),
      );
      await this.writeAtomic(next);
    });
  }

  /**
   * 串行化所有写入路径，避免 list reconcile 与 upsert/remove 并发覆盖。
   * 只对当前进程生效；跨进程互斥由 lockfile 负责（见 acquireLock）。
   */
  private withWriteLock<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(task, task);
    // 即使 task 抛错也不能阻塞后续写入。
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  /**
   * 抢占 lockfile：用 `wx` 标志写入，存在即抛 EEXIST。
   * 调用方负责在 finally 里 release。
   */
  private async acquireLock(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const handle = await open(this.lockPath, "wx", 0o600);
    try {
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    } finally {
      await handle.close();
    }
  }

  private async releaseLock(): Promise<void> {
    try {
      await unlink(this.lockPath);
    } catch {
      // 已被其他人移除或从未持有，忽略。
    }
  }

  /**
   * 原子写入：tmp 文件 + rename。
   * - 抢 lockfile 失败 → 直接抛 SessionStoreLockedError；调用方一般会让上层
   *   重试，避免静默吞掉失败导致内存与磁盘漂移。
   * - rename 在同一文件系统是原子操作，读端永远不会看到半截 JSON。
   */
  private async writeAtomic(sessions: CodexSession[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await this.acquireLock();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EEXIST") {
        throw new SessionStoreLockedError(this.lockPath);
      }
      throw error;
    }

    const tmpPath = `${this.path}.tmp.${process.pid}.${Date.now()}.${Math.random()
      .toString(16)
      .slice(2)}`;
    try {
      await writeFile(tmpPath, `${JSON.stringify({ sessions }, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(tmpPath, this.path);
    } catch (error) {
      // 失败时清理 tmp，避免目录里堆积无主文件。
      try {
        await unlink(tmpPath);
      } catch {
        // 不存在或已被 rename 替换，忽略。
      }
      throw error;
    } finally {
      await this.releaseLock();
    }
  }
}

export class SessionStoreLockedError extends Error {
  readonly code = "SESSION_STORE_LOCKED";
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(
      `session store is locked by another process: ${basename(lockPath)}`,
    );
    this.name = "SessionStoreLockedError";
    this.lockPath = lockPath;
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
