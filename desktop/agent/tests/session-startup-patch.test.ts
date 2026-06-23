import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SQLiteSessionStore } from "../src/session-store/sessionStore.ts";
import { SessionManager } from "../src/core/sessionManager.ts";
import { TmuxManager } from "../src/tmux-manager/tmuxManager.ts";
import { RuntimeRegistry } from "../src/runtime/runtimeAdapter.ts";
import {
  DEFAULT_AGENT_PROVIDER_DEFINITIONS,
  type CodexSession,
} from "@omniwork/protocol-ts";

function fakeSession(overrides: Partial<CodexSession>): CodexSession {
  const now = new Date().toISOString();
  return {
    session_id: "sess_default",
    runtime_kind: "codex",
    runtime_label: "Codex",
    title: "T",
    cwd: "/tmp",
    command: "codex",
    status: "running",
    created_at: now,
    last_active_at: now,
    terminal_size: { cols: 80, rows: 24 },
    tmux_session_name: "omniwork_default",
    origin: "managed",
    registered: true,
    ...overrides,
  };
}

// applyStartupPatches 应丢弃 status 不在 store 持久化白名单
// （SUPPORTED_SESSION_STATUSES）内的条目；`error` 虽是协议合法值，
// 但不在 store 白名单内，应被一并清理。
{
  const dir = await mkdtemp(join(tmpdir(), "omniwork-startup-patch-"));
  const store = new SQLiteSessionStore(join(dir, "sessions.sqlite"));
  await store.saveAll([
    fakeSession({ session_id: "sess_keep", status: "running" }),
    fakeSession({ session_id: "sess_keep_detached", status: "detached" }),
    fakeSession({
      session_id: "sess_invalid_error",
      // `error` 虽是协议合法值，但不在 store 持久化白名单内，应被清理。
      status: "error" as CodexSession["status"],
    }),
    fakeSession({
      session_id: "sess_invalid_recovering",
      status: "recovering" as CodexSession["status"],
    }),
    fakeSession({
      session_id: "sess_unknown",
      status: "weird" as CodexSession["status"],
    }),
  ]);
  const manager = new SessionManager(
    store,
    new TmuxManager(),
    new RuntimeRegistry({ providers: DEFAULT_AGENT_PROVIDER_DEFINITIONS }),
    undefined,
    { cwd: "/tmp", terminalSize: { cols: 80, rows: 24 } },
  );

  // 屏蔽 store.remove 的结构化日志，避免污染测试输出。
  const originalInfo = console.info;
  console.info = () => undefined;
  try {
    await manager.applyStartupPatches();
  } finally {
    console.info = originalInfo;
  }

  const after = await store.list();
  const remainingIds = after.map((session) => session.session_id).sort();
  assert.deepEqual(remainingIds, ["sess_keep", "sess_keep_detached"]);
}

// applyStartupPatches 在没有命中条目时应零写入，幂等。
{
  const dir = await mkdtemp(join(tmpdir(), "omniwork-startup-patch-"));
  const store = new SQLiteSessionStore(join(dir, "sessions.sqlite"));
  await store.saveAll([fakeSession({ session_id: "sess_ok" })]);
  const manager = new SessionManager(
    store,
    new TmuxManager(),
    new RuntimeRegistry({ providers: DEFAULT_AGENT_PROVIDER_DEFINITIONS }),
    undefined,
    { cwd: "/tmp", terminalSize: { cols: 80, rows: 24 } },
  );

  await manager.applyStartupPatches();
  const after = await store.list();
  assert.equal(after.length, 1);
  assert.equal(after[0].session_id, "sess_ok");
}

console.log("session-startup-patch tests passed");
