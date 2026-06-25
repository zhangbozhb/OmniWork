import { strict as assert } from "node:assert";
import { test } from "node:test";

import { normalizeCodexAppServerEvent } from "../src/probes/codexAppServerNormalizer.ts";

test("normalizeCodexAppServerEvent maps approval requests", () => {
  const event = normalizeCodexAppServerEvent({
    type: "approval.requested",
    id: "approval-event-1",
    approval_id: "approval-1",
    thread_id: "thread-1",
    turn_id: "turn-1",
    workspace_path: "/tmp/project",
    tool_name: "shell",
    summary: "Run pnpm test",
  });

  assert.ok(event);
  assert.equal(event.provider, "codex");
  assert.equal(event.probe_id, "codex-app-server");
  assert.equal(event.session_id, "thread-1");
  assert.equal(event.workspace_path, "/tmp/project");
  assert.equal(event.event_type, "agent.approval_required");
  assert.equal(event.severity, "warning");
  assert.equal(event.title, "Codex needs approval for shell");
  assert.equal(event.summary, "Run pnpm test");
  assert.equal(event.source.kind, "app-server");
  assert.equal(event.source.raw_event_id, "approval-event-1");
});

test("normalizeCodexAppServerEvent maps diff and completion events", () => {
  const diffEvent = normalizeCodexAppServerEvent({
    event: "diff.updated",
    thread_id: "thread-1",
    turn_id: "turn-2",
    diff: "diff --git a/foo.ts b/foo.ts",
  });
  const completedEvent = normalizeCodexAppServerEvent({
    name: "turn.completed",
    thread_id: "thread-1",
    turn_id: "turn-2",
    message: "All checks passed",
  });

  assert.ok(diffEvent);
  assert.equal(diffEvent.event_type, "agent.git_diff_changed");
  assert.equal(diffEvent.title, "Codex updated the diff");
  assert.equal(diffEvent.summary, "diff --git a/foo.ts b/foo.ts");

  assert.ok(completedEvent);
  assert.equal(completedEvent.event_type, "agent.completed");
  assert.equal(completedEvent.title, "Codex turn completed");
  assert.equal(completedEvent.summary, "All checks passed");
});

test("normalizeCodexAppServerEvent ignores incomplete or unsupported events", () => {
  assert.equal(normalizeCodexAppServerEvent({ type: "turn.completed" }), null);
  assert.equal(
    normalizeCodexAppServerEvent({
      type: "unknown.event",
      thread_id: "thread-1",
    }),
    null,
  );
});
