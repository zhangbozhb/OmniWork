import { strict as assert } from "node:assert";
import { test } from "node:test";

import type {
  AgentPromptSubmitPayload,
  FilesReadPayload,
  TerminalSession,
  WorkspaceDefinition,
} from "@omni-work/protocol-ts";
import { createMessage } from "@omni-work/protocol-ts";
import { AgentPromptContextResolver } from "../src/agent-surface/agentPromptContextResolver.ts";
import { toAgentPromptSurfaceEvent } from "../src/core/agentMessageDispatcher.ts";

const workspace: WorkspaceDefinition = {
  name: "project",
  path: "/tmp/project",
  isGitRepository: true,
  status: "available",
  source: "session",
};

const session: TerminalSession = {
  session_id: "session-1",
  primary_surface_id: "surface-1",
  surfaces: [
    {
      surface_id: "surface-1",
      session_id: "session-1",
      kind: "agent",
      title: "Agent",
      status: "active",
      provider: "codex",
    },
  ],
  terminal_provider_kind: "codex",
  terminal_provider_label: "Codex",
  title: "Agent session",
  cwd: "/tmp/project",
  workspace_path: "/tmp/project",
  command: "codex",
  status: "running",
  created_at: "2026-08-01T00:00:00.000Z",
  last_active_at: "2026-08-01T00:00:00.000Z",
  terminal_size: { cols: 80, rows: 24 },
  tmux_session_name: "omni-session-1",
};

function payload(
  overrides: Partial<AgentPromptSubmitPayload> = {},
): AgentPromptSubmitPayload {
  return {
    session_id: "session-1",
    surface_id: "surface-1",
    prompt: "Explain the configuration.",
    context_files: [
      {
        kind: "workspace_file",
        workspace_path: "/tmp/project",
        relative_path: "config.json",
      },
    ],
    ...overrides,
  };
}

function resolver(
  file: Partial<FilesReadPayload> = {},
  maxContextBytes?: number,
): AgentPromptContextResolver {
  return new AgentPromptContextResolver({
    getSession: async (sessionId) =>
      sessionId === session.session_id ? session : undefined,
    getWorkspace: async (path) =>
      path === workspace.path ? workspace : undefined,
    files: {
      read: async (_workspace, relativePath) => ({
        workspacePath: workspace.path,
        relativePath,
        content: '{"enabled":true}',
        encoding: "utf8",
        size: 16,
        contentHash: "a".repeat(64),
        ...file,
      }),
    },
    maxContextBytes,
  });
}

test("AgentPromptContextResolver keeps plain prompts unchanged", async () => {
  assert.equal(
    await resolver().resolve(payload({ context_files: undefined })),
    "Explain the configuration.",
  );
});

test("AgentPromptContextResolver injects deduplicated file snapshots", async () => {
  const resolved = await resolver().resolve(
    payload({
      context_files: [
        payload().context_files![0],
        payload().context_files![0],
      ],
    }),
  );

  assert.match(resolved, /<context_file path="config\.json"/);
  assert.match(resolved, /\{"enabled":true\}/);
  assert.match(resolved, /<user_request>\n\nExplain the configuration\./);
  assert.equal(resolved.match(/<context_file /g)?.length, 1);
});

test("AgentPromptContextResolver rejects stale and oversized context", async () => {
  await assert.rejects(
    resolver().resolve(
      payload({
        context_files: [
          {
            ...payload().context_files![0],
            content_hash: "b".repeat(64),
          },
        ],
      }),
    ),
    /changed after selection/,
  );
  await assert.rejects(
    resolver({ content: "too large" }, 4).resolve(payload()),
    /exceeds 4 bytes/,
  );
  await assert.rejects(
    resolver().resolve(
      payload({
        context_files: Array.from({ length: 11 }, (_, index) => ({
          kind: "workspace_file",
          workspace_path: "/tmp/project",
          relative_path: `file-${index}.txt`,
        })),
      }),
    ),
    /at most 10 files/,
  );
});

test("AgentPromptContextResolver enforces session and workspace binding", async () => {
  await assert.rejects(
    resolver().resolve(
      payload({
        surface_id: "surface-other",
      }),
    ),
    /does not belong/,
  );
  await assert.rejects(
    resolver().resolve(
      payload({
        context_files: [
          {
            kind: "workspace_file",
            workspace_path: "/tmp/other",
            relative_path: "secret.txt",
          },
        ],
      }),
    ),
    /not available to this session/,
  );
});

test("prompt Surface events retain references without file contents", () => {
  const message = createMessage("agent.prompt.submit", payload(), {
    id: "prompt-message-1",
  });
  const event = toAgentPromptSurfaceEvent(message);

  assert.equal(event.summary, "Explain the configuration.");
  assert.deepEqual(event.payload?.context_files, [
    {
      kind: "workspace_file",
      workspace_path: "/tmp/project",
      relative_path: "config.json",
      content_hash: undefined,
    },
  ]);
  assert.equal(event.payload?.content, undefined);
  assert.equal(event.source?.raw_event_id, "prompt-message-1");
});
