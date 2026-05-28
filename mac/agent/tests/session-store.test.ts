import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JsonSessionStore,
  SessionStoreLockedError,
} from "../src/session-store/sessionStore.ts";
import type { CodexSession } from "../../../packages/protocol-ts/src/index.ts";

function fakeSession(overrides: Partial<CodexSession> = {}): CodexSession {
  const now = new Date().toISOString();
  return {
    session_id: "sess_test",
    runtime_kind: "codex",
    runtime_label: "Codex",
    title: "Test",
    cwd: "/tmp",
    command: "codex",
    status: "running",
    created_at: now,
    last_active_at: now,
    terminal_size: { cols: 80, rows: 24 },
    tmux_session_name: "omniwork_test",
    tmux_server_pid: 4242,
    tmux_session_uid: "$1",
    origin: "managed",
    registered: true,
    ...overrides,
  };
}

async function newStore(): Promise<{ store: JsonSessionStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-store-"));
  const path = join(dir, "sessions.json");
  return { store: new JsonSessionStore(path), path };
}

// upsert + list 走 atomic write 路径，磁盘上应该是一份合法 JSON。
{
  const { store, path } = await newStore();
  await store.upsert(fakeSession());
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as { sessions: CodexSession[] };
  assert.equal(parsed.sessions.length, 1);
  assert.equal(parsed.sessions[0].tmux_session_uid, "$1");
  const listed = await store.list();
  assert.equal(listed.length, 1);
}

// 有 lockfile 时 saveAll 应抛 SessionStoreLockedError，不能写穿磁盘。
{
  const { store, path } = await newStore();
  await store.upsert(fakeSession());
  await writeFile(`${path}.lock`, `${process.pid}\n`, { mode: 0o600 });
  await assert.rejects(
    () => store.saveAll([fakeSession({ session_id: "sess_other" })]),
    (error) => error instanceof SessionStoreLockedError,
  );
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].session_id, "sess_test");
}

// remove 命中条目应输出结构化日志，且写入持久化。
{
  const { store } = await newStore();
  await store.upsert(fakeSession());
  const logs: string[] = [];
  const original = console.info;
  console.info = (msg: string) => {
    logs.push(msg);
  };
  try {
    await store.remove("sess_test", "test_remove");
  } finally {
    console.info = original;
  }
  assert.equal(logs.length, 1);
  const log = JSON.parse(logs[0]);
  assert.equal(log.event, "session_store.remove");
  assert.equal(log.reason, "test_remove");
  assert.equal((await store.list()).length, 0);
}

// 进程内并发写不会丢更新（withWriteLock 排队）。
{
  const { store } = await newStore();
  await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      store.upsert(
        fakeSession({
          session_id: `sess_${i}`,
          tmux_session_uid: `$${i + 1}`,
        }),
      ),
    ),
  );
  const listed = await store.list();
  assert.equal(listed.length, 5);
}

console.log("session-store tests passed");
