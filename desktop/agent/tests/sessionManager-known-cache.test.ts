import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_TERMINAL_PROVIDER_DEFINITIONS,
  type TerminalSession,
  type WorkspaceDefinition,
} from "@omniwork/protocol-ts";
import { SessionManager } from "../src/core/sessionManager.ts";
import { SQLiteSessionStore } from "../src/session-store/sessionStore.ts";
import { TerminalProviderRegistry } from "../src/terminal-provider/terminalProviderRegistry.ts";
import type {
  TmuxManager,
  TmuxSessionInfo,
} from "../src/tmux-manager/tmuxManager.ts";
import type { WorkspaceManager } from "../src/workspace/workspaceManager.ts";

function fakeSession(overrides: Partial<TerminalSession> = {}): TerminalSession {
  const now = new Date().toISOString();
  return {
    session_id: "sess_known",
    primary_surface_id: "surface_sess_known_terminal",
    surfaces: [
      {
        surface_id: "surface_sess_known_terminal",
        session_id: "sess_known",
        kind: "terminal",
        title: "Known",
        status: "active",
        provider: "codex",
      },
    ],
    terminal_provider_kind: "codex",
    terminal_provider_label: "Codex",
    title: "Known",
    cwd: "/tmp/project",
    command: "codex",
    status: "running",
    created_at: now,
    last_active_at: now,
    terminal_size: { cols: 80, rows: 24 },
    tmux_session_name: "omniwork_known",
    tmux_server_pid: 4242,
    tmux_session_uid: "$1",
    origin: "managed",
    registered: true,
    ...overrides,
  };
}

async function newStore(): Promise<SQLiteSessionStore> {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-session-manager-"));
  return new SQLiteSessionStore(join(dir, "sessions.sqlite"));
}

function terminalProviders(): TerminalProviderRegistry {
  return new TerminalProviderRegistry({
    providers: DEFAULT_TERMINAL_PROVIDER_DEFINITIONS,
  });
}

// listWithWorkspaces 是权威刷新路径；刷新完成后，getKnown* 应只读内存索引，
// 不再触发 tmux list 或 workspace 解析。
{
  const store = await newStore();
  await store.upsert(fakeSession());

  let tmuxListCalls = 0;
  let workspaceListCalls = 0;
  let resolveWorkspaceCalls = 0;
  const workspace: WorkspaceDefinition = {
    path: "/tmp/project",
    name: "project",
    isGitRepository: true,
    status: "available",
    source: "session",
  };
  const tmux = {
    async listSessions(): Promise<TmuxSessionInfo[]> {
      tmuxListCalls += 1;
      return [
        {
          name: "omniwork_known",
          sessionUid: "$1",
          serverPid: 4242,
          createdAt: new Date().toISOString(),
          attached: false,
          currentPath: "/tmp/project",
          currentCommand: "codex",
        },
      ];
    },
  } as unknown as TmuxManager;
  const workspaces = {
    async list(): Promise<WorkspaceDefinition[]> {
      workspaceListCalls += 1;
      return [workspace];
    },
    async resolveSessionWorkspace(): Promise<WorkspaceDefinition> {
      resolveWorkspaceCalls += 1;
      return workspace;
    },
  } as unknown as WorkspaceManager;
  const manager = new SessionManager(
    store,
    tmux,
    terminalProviders(),
    workspaces,
    { cwd: "/tmp", terminalSize: { cols: 80, rows: 24 } },
  );

  const { sessions } = await manager.listWithWorkspaces();
  assert.equal(sessions.length, 1);
  assert.equal(tmuxListCalls, 1);
  assert.equal(workspaceListCalls, 1);
  assert.equal(resolveWorkspaceCalls, 1);

  tmuxListCalls = 0;
  workspaceListCalls = 0;
  resolveWorkspaceCalls = 0;

  const byId = manager.getKnown("sess_known");
  const bySurface = manager.getKnownBySurfaceId("surface_sess_known_terminal");
  assert.equal(byId?.session_id, "sess_known");
  assert.equal(bySurface?.session_id, "sess_known");
  assert.equal(bySurface?.workspace_path, "/tmp/project");
  assert.equal(tmuxListCalls, 0);
  assert.equal(workspaceListCalls, 0);
  assert.equal(resolveWorkspaceCalls, 0);
}

// create/update/remove 写路径应同步维护轻量索引；updateTerminalSize 应命中
// getKnown，避免 resize 热路径重新进入 listWithWorkspaces。
{
  const store = await newStore();
  let tmuxListCalls = 0;
  const tmux = {
    async listSessions(): Promise<TmuxSessionInfo[]> {
      tmuxListCalls += 1;
      return [];
    },
    async createSession(): Promise<{ serverPid: number; sessionUid: string }> {
      return { serverPid: 5252, sessionUid: "$2" };
    },
  } as unknown as TmuxManager;
  const manager = new SessionManager(
    store,
    tmux,
    terminalProviders(),
    undefined,
    { cwd: "/tmp", terminalSize: { cols: 80, rows: 24 } },
  );

  const created = await manager.create({
    terminal_provider_kind: "codex",
    cwd: "/tmp/project",
  });
  assert.equal(manager.getKnown(created.session_id)?.status, "running");
  assert.equal(
    manager.getKnownBySurfaceId(created.primary_surface_id)?.session_id,
    created.session_id,
  );

  const updated = await manager.updateTerminalSize(created.session_id, {
    cols: 100,
    rows: 30,
  });
  assert.deepEqual(updated?.terminal_size, { cols: 100, rows: 30 });
  assert.deepEqual(manager.getKnown(created.session_id)?.terminal_size, {
    cols: 100,
    rows: 30,
  });
  assert.equal(tmuxListCalls, 0);

  await manager.remove(created.session_id);
  assert.equal(manager.getKnown(created.session_id), undefined);
  assert.equal(manager.getKnownBySurfaceId(created.primary_surface_id), undefined);
}

console.log("sessionManager-known-cache tests passed");
