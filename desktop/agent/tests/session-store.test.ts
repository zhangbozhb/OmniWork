import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLiteSessionStore } from "../src/session-store/sessionStore.ts";
import type { CodexSession } from "@omniwork/protocol-ts";

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

async function newStore(): Promise<{ store: SQLiteSessionStore; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-store-"));
  const path = join(dir, "sessions.sqlite");
  return { store: new SQLiteSessionStore(path), path };
}

// upsert + list 走 SQLite 持久化路径。
{
  const { store } = await newStore();
  await store.upsert(fakeSession());
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].tmux_session_uid, "$1");
}

// saveAll 应以传入列表替换 SQLite 表内容。
{
  const { store } = await newStore();
  await store.upsert(fakeSession());
  await store.saveAll([fakeSession({ session_id: "sess_other" })]);
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].session_id, "sess_other");
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

// 首次打开 SQLite store 时应从同目录旧 sessions.json 导入一次。
{
  const dir = await mkdtemp(join(tmpdir(), "omniwork-store-"));
  await writeFile(
    join(dir, "sessions.json"),
    JSON.stringify({ sessions: [fakeSession({ session_id: "legacy" })] }),
  );
  const store = new SQLiteSessionStore(join(dir, "sessions.sqlite"));
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].session_id, "legacy");
}

// 兼容显式传入旧 sessions.json 路径：应自动映射到同名 SQLite 文件并导入旧数据。
{
  const dir = await mkdtemp(join(tmpdir(), "omniwork-store-"));
  const legacyPath = join(dir, "custom-sessions.json");
  await writeFile(
    legacyPath,
    JSON.stringify({ sessions: [fakeSession({ session_id: "custom_legacy" })] }),
  );
  const store = new SQLiteSessionStore(legacyPath);
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].session_id, "custom_legacy");
}

console.log("session-store tests passed");
