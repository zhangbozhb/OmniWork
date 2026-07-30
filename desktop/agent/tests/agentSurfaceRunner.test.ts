import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  normalizeAppServerNotification,
  normalizeClaudeMessage,
} from "../src/agent-surface/agentSurfaceRunner.ts";
import { JsonLineProcess } from "../src/agent-surface/jsonLineProcess.ts";
import { Logger } from "../src/telemetry/logger.ts";

test("normalizes Codex and TraeX agent messages to the shared surface contract", () => {
  for (const provider of ["codex", "traex"]) {
    const event = normalizeAppServerNotification({
      provider,
      sessionId: "sess_1",
      surfaceId: "surface_1",
      method: "item/completed",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        item: {
          type: "agentMessage",
          id: "item_1",
          text: "Done",
        },
      },
    });

    assert.equal(event?.provider, provider);
    assert.equal(event?.summary, "Done");
    assert.equal(event?.payload?.message_role, "assistant");
    assert.equal(
      (event?.payload?.item as { type?: string } | undefined)?.type,
      "agent_message",
    );
  }
});

test("coalesces app-server text deltas under a stable event id", () => {
  const textByItemId = new Map<string, string>();
  const first = normalizeAppServerNotification({
    provider: "codex",
    sessionId: "sess_1",
    surfaceId: "surface_1",
    method: "item/agentMessage/delta",
    params: { turnId: "turn_1", itemId: "item_1", delta: "Hel" },
    textByItemId,
  });
  const second = normalizeAppServerNotification({
    provider: "codex",
    sessionId: "sess_1",
    surfaceId: "surface_1",
    method: "item/agentMessage/delta",
    params: { turnId: "turn_1", itemId: "item_1", delta: "lo" },
    textByItemId,
  });

  assert.equal(first?.event_id, second?.event_id);
  assert.equal(second?.summary, "Hello");
});

test("maps failed app-server turns to agent.failed", () => {
  const event = normalizeAppServerNotification({
    provider: "traex",
    sessionId: "sess_1",
    surfaceId: "surface_1",
    method: "turn/completed",
    params: {
      threadId: "thread_1",
      turn: {
        id: "turn_1",
        status: "failed",
        error: { message: "model unavailable" },
      },
    },
  });

  assert.equal(event?.event_type, "agent.failed");
  assert.equal(event?.summary, "model unavailable");
});

test("normalizes Claude stream-json text deltas", () => {
  const normalized = normalizeClaudeMessage({
    sessionId: "sess_1",
    surfaceId: "surface_1",
    turnKey: "turn_1",
    currentText: "Hel",
    message: {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "lo" },
      },
    },
  });

  assert.equal(normalized?.text, "Hello");
  assert.equal(normalized?.events[0]?.provider, "claude-code");
  assert.equal(normalized?.events[0]?.payload?.message_role, "assistant");
});

test("keeps server requests separate from responses with the same id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omniwork-json-line-"));
  const fixture = join(dir, "server.mjs");
  await writeFile(
    fixture,
    [
      'import { createInterface } from "node:readline";',
      "const lines = createInterface({ input: process.stdin });",
      'lines.once("line", (line) => {',
      "  const request = JSON.parse(line);",
      '  process.stdout.write(JSON.stringify({ id: request.id, method: "approval/request", params: {} }) + "\\n");',
      '  process.stdout.write(JSON.stringify({ id: request.id, result: { ok: true } }) + "\\n");',
      "});",
    ].join("\n"),
  );

  const serverRequests: unknown[] = [];
  const child = new JsonLineProcess({
    command: process.execPath,
    args: [fixture],
    cwd: dir,
    logger: new Logger("json-line-test"),
    logLabel: "json-line-test",
    onMessage: (message) => serverRequests.push(message),
    onExit: () => undefined,
  });
  try {
    const response = await child.request("initialize", {});
    assert.equal(response.ok, true);
    assert.equal(
      (serverRequests[0] as { method?: string } | undefined)?.method,
      "approval/request",
    );
  } finally {
    child.close();
  }
});
