import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createMessage,
  DEFAULT_TERMINAL_PROVIDER_DEFINITIONS,
  type TerminalSession,
  type MessageEnvelope,
  type SessionCreatePayload,
} from "@omniwork/protocol-ts";
import { TerminalProviderRegistry } from "../src/terminal-provider/terminalProviderRegistry.ts";
import { SessionRequestHandler } from "../src/core/sessionRequestHandler.ts";
import type { SessionManager } from "../src/core/sessionManager.ts";
import type { TerminalFramePusher } from "../src/core/terminalFramePusher.ts";
import type { WorkspaceManager } from "../src/workspace/workspaceManager.ts";

type TestDispatchContext = {
  appConnectionId: string;
  trustedE2E: boolean;
};

function fakeSession(overrides: Partial<TerminalSession>): TerminalSession {
  const now = new Date().toISOString();
  return {
    session_id: "sess_created",
    terminal_provider_kind: "codex",
    terminal_provider_label: "Codex",
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
  const preparedTerminalProviders: Array<{ kind: string; command: string }> = [];
  const subscribers: Array<{ sessionId: string; appConnectionId: string }> = [];
  const startedSessionIds: string[] = [];

  const created = fakeSession({ status: "created" });
  const starting = fakeSession({ status: "starting" });
  const running = fakeSession({ status: "running" });
  const sessionManager = {
    async create(
      _payload: SessionCreatePayload,
      onStatus?: (session: TerminalSession) => void | Promise<void>,
    ): Promise<TerminalSession> {
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
    terminalProviders: new TerminalProviderRegistry({
      providers: DEFAULT_TERMINAL_PROVIDER_DEFINITIONS,
    }),
    workspaces: {} as WorkspaceManager,
    sessionManager,
    terminalFramePusher,
    sendToApp(nextContext, message): void {
      sent.push({ context: nextContext, message });
    },
    async prepareTerminalProvider(terminalProvider): Promise<void> {
      preparedTerminalProviders.push(terminalProvider);
    },
    async handleTerminalSnapshot(message, nextContext): Promise<void> {
      snapshots.push({ context: nextContext, message });
    },
  });
  const request = createMessage("session.create", {
    cwd: "/tmp/project",
    workspace_path: "/tmp/project",
    terminal_provider_kind: "codex",
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
        (message.payload as { session: TerminalSession }).session.status,
    ),
    ["created", "starting", "running"],
  );
  assert.deepEqual(preparedTerminalProviders, [{ kind: "codex", command: "codex" }]);
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
