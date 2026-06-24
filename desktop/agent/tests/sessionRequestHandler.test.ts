import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createMessage,
  DEFAULT_AGENT_PROVIDER_DEFINITIONS,
  type CodexSession,
  type MessageEnvelope,
  type SessionCreatePayload,
} from "@omniwork/protocol-ts";
import { RuntimeRegistry } from "../src/runtime/runtimeAdapter.ts";
import { SessionRequestHandler } from "../src/core/sessionRequestHandler.ts";
import type { SessionManager } from "../src/core/sessionManager.ts";
import type { TerminalFramePusher } from "../src/core/terminalFramePusher.ts";
import type { WorkspaceManager } from "../src/workspace/workspaceManager.ts";

type TestDispatchContext = {
  appConnectionId: string;
  trustedE2E: boolean;
};

function fakeSession(overrides: Partial<CodexSession>): CodexSession {
  const now = new Date().toISOString();
  return {
    session_id: "sess_created",
    runtime_kind: "codex",
    runtime_label: "Codex",
    title: "Codex 1",
    cwd: "/tmp/project",
    command: "codex",
    status: "running",
    created_at: now,
    last_active_at: now,
    terminal_size: { cols: 80, rows: 24 },
    tmux_session_name: "omniwork_sess_created",
    workspace_path: "/tmp/project",
    workspace_name: "project",
    origin: "managed",
    registered: true,
    ...overrides,
  };
}

test("SessionRequestHandler sends create status updates to the requesting app", async () => {
  const context: TestDispatchContext = {
    appConnectionId: "app-1",
    trustedE2E: true,
  };
  const sent: Array<{
    context: TestDispatchContext | undefined;
    message: MessageEnvelope;
  }> = [];
  const snapshots: Array<{
    context: TestDispatchContext | undefined;
    message: MessageEnvelope;
  }> = [];
  const preparedRuntimes: Array<{ kind: string; command: string }> = [];
  const subscribers: Array<{ sessionId: string; appConnectionId: string }> = [];
  const startedSessionIds: string[] = [];

  const created = fakeSession({ status: "created" });
  const starting = fakeSession({ status: "starting" });
  const running = fakeSession({ status: "running" });
  const sessionManager = {
    async create(
      _payload: SessionCreatePayload,
      onStatus?: (session: CodexSession) => void | Promise<void>,
    ): Promise<CodexSession> {
      await onStatus?.(created);
      await onStatus?.(starting);
      return running;
    },
  } as unknown as SessionManager;
  const terminalFramePusher = {
    addSubscriber(sessionId: string, appConnectionId: string): void {
      subscribers.push({ sessionId, appConnectionId });
    },
    start(sessionId: string): void {
      startedSessionIds.push(sessionId);
    },
  } as unknown as TerminalFramePusher;

  const handler = new SessionRequestHandler({
    deviceId: "device-1",
    defaultCwd: "/tmp",
    runtimes: new RuntimeRegistry({
      providers: DEFAULT_AGENT_PROVIDER_DEFINITIONS,
    }),
    workspaces: {} as WorkspaceManager,
    sessionManager,
    terminalFramePusher,
    sendToApp(nextContext, message): void {
      sent.push({ context: nextContext, message });
    },
    async prepareRuntime(runtime): Promise<void> {
      preparedRuntimes.push(runtime);
    },
    async handleTerminalSnapshot(message, nextContext): Promise<void> {
      snapshots.push({ context: nextContext, message });
    },
  });
  const request = createMessage("session.create", {
    cwd: "/tmp/project",
    workspace_path: "/tmp/project",
    runtime_kind: "codex",
  });

  await handler.handleCreate(request, context);

  const statusMessages = sent.filter(
    ({ message }) => message.type === "session.status",
  );
  assert.equal(statusMessages.length, 3);
  assert.deepEqual(
    statusMessages.map(({ context: nextContext }) => nextContext),
    [context, context, context],
  );
  assert.deepEqual(
    statusMessages.map(
      ({ message }) =>
        (message.payload as { session: CodexSession }).session.status,
    ),
    ["created", "starting", "running"],
  );
  assert.deepEqual(preparedRuntimes, [{ kind: "codex", command: "codex" }]);
  assert.deepEqual(snapshots, [
    {
      context,
      message: {
        ...request,
        session_id: running.session_id,
      },
    },
  ]);
  assert.deepEqual(subscribers, [
    { sessionId: running.session_id, appConnectionId: context.appConnectionId },
  ]);
  assert.deepEqual(startedSessionIds, [running.session_id]);
});
