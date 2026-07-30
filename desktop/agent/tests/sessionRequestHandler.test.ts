import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createMessage,
  DEFAULT_TERMINAL_PROVIDER_DEFINITIONS,
  type TerminalSession,
  type MessageEnvelope,
  type SessionCreatePayload,
} from "@omni-work/protocol-ts";
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
    primary_surface_id: "surface_sess_created_terminal",
    surfaces: [
      {
        surface_id: "surface_sess_created_terminal",
        session_id: "sess_created",
        kind: "terminal",
        title: "Codex 1",
        status: "active",
        provider: "codex",
      },
    ],
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
        surface_id: running.primary_surface_id,
      },
    },
  ]);
  assert.deepEqual(subscribers, [
    { sessionId: running.session_id, appConnectionId: context.appConnectionId },
  ]);
  assert.deepEqual(startedSessionIds, [running.session_id]);
});

test("SessionRequestHandler does not start terminal stream for app_server sessions", async () => {
  const context: TestDispatchContext = {
    appConnectionId: "app-1",
    trustedE2E: true,
  };
  const sent: Array<MessageEnvelope> = [];
  const snapshots: MessageEnvelope[] = [];
  const subscribers: Array<{ sessionId: string; appConnectionId: string }> = [];
  const startedSessionIds: string[] = [];
  const running = fakeSession({
    primary_surface_id: "surface_sess_created_agent",
    surfaces: [
      {
        surface_id: "surface_sess_created_agent",
        session_id: "sess_created",
        kind: "agent",
        title: "Codex 1",
        status: "active",
        provider: "codex",
      },
    ],
    runtime: {
      kind: "app_server",
      label: "app server",
      description: "Structured Agent runtime.",
      capabilities: {
        terminal_io: false,
        persistent_resume: true,
        reconnect_control: true,
        native_approval: true,
        structured_timeline: true,
        diff_view: true,
      },
    },
  });
  const sessionManager = {
    async create(): Promise<TerminalSession> {
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
    sendToApp(_nextContext, message): void {
      sent.push(message);
    },
    async handleTerminalSnapshot(message): Promise<void> {
      snapshots.push(message);
    },
  });

  await handler.handleCreate(
    createMessage("session.create", {
      terminal_provider_kind: "codex",
      runtime_preference: "app_server",
    }),
    context,
  );

  assert.equal(sent.filter((message) => message.type === "session.status").length, 1);
  assert.deepEqual(snapshots, []);
  assert.deepEqual(subscribers, []);
  assert.deepEqual(startedSessionIds, []);
});

test("SessionRequestHandler rejects session creation when cwd setup fails", async () => {
  const sent: MessageEnvelope[] = [];
  const sessionManager = {
    async create(): Promise<TerminalSession> {
      throw new Error("Failed to create working directory /blocked/project");
    },
  } as unknown as SessionManager;
  const handler = new SessionRequestHandler({
    deviceId: "device-1",
    defaultCwd: "/tmp",
    terminalProviders: new TerminalProviderRegistry({
      providers: DEFAULT_TERMINAL_PROVIDER_DEFINITIONS,
    }),
    workspaces: {} as WorkspaceManager,
    sessionManager,
    terminalFramePusher: {} as TerminalFramePusher,
    sendToApp(_context, message): void {
      sent.push(message);
    },
    async handleTerminalSnapshot(): Promise<void> {},
  });

  await handler.handleCreate(
    createMessage("session.create", {
      cwd: "/blocked/project",
      terminal_provider_kind: "codex",
    }),
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.type, "terminal.error");
  assert.deepEqual(sent[0]?.payload, {
    code: "SESSION_CREATE_FAILED",
    message: "Failed to create working directory /blocked/project",
  });
});

test("SessionRequestHandler closes the structured runner with the session", async () => {
  const closedRunnerSessions: string[] = [];
  const closedSessions: string[] = [];
  const stoppedFrames: string[] = [];
  const sessionManager = {
    async close(sessionId: string): Promise<void> {
      closedSessions.push(sessionId);
    },
    async listWithWorkspaces() {
      return { sessions: [], workspaces: [] };
    },
  } as unknown as SessionManager;
  const terminalFramePusher = {
    stop(sessionId: string): void {
      stoppedFrames.push(sessionId);
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
    sendToApp(): void {},
    closeAgentSurfaceSession(sessionId): void {
      closedRunnerSessions.push(sessionId);
    },
    async handleTerminalSnapshot(): Promise<void> {},
  });

  await handler.handleClose({
    ...createMessage("session.close", {}),
    session_id: "sess_structured",
  });

  assert.deepEqual(stoppedFrames, ["sess_structured"]);
  assert.deepEqual(closedRunnerSessions, ["sess_structured"]);
  assert.deepEqual(closedSessions, ["sess_structured"]);
});
