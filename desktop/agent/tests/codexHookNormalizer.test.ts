import { strict as assert } from "node:assert";
import { test } from "node:test";

import { normalizeCodexHookPayload } from "../src/probes/codexHookNormalizer.ts";

test("normalizeCodexHookPayload maps PermissionRequest to approval probe event", () => {
  const event = normalizeCodexHookPayload({
    session_id: "sess-1",
    hook_event_name: "PermissionRequest",
    cwd: "/tmp/project",
    turn_id: "turn-1",
    tool_name: "shell",
    tool_use_id: "tool-1",
    tool_input: {
      command: "npm test",
    },
  });

  assert.ok(event);
  assert.equal(event.provider, "codex");
  assert.equal(event.probe_id, "codex-hooks");
  assert.equal(event.session_id, "sess-1");
  assert.equal(event.event_type, "agent.approval_required");
  assert.equal(event.severity, "warning");
  assert.equal(event.summary, "npm test");
  assert.equal(event.source.kind, "cli-hook");
});

test("normalizeCodexHookPayload ignores unsupported or incomplete hook payloads", () => {
  assert.equal(
    normalizeCodexHookPayload({
      session_id: "sess-1",
      hook_event_name: "UnknownHook",
    }),
    null,
  );
  assert.equal(
    normalizeCodexHookPayload({
      hook_event_name: "Stop",
    }),
    null,
  );
});

test("normalizeCodexHookPayload creates stable ids for duplicate hook payloads", () => {
  const payload = {
    session_id: "sess-1",
    hook_event_name: "Stop",
    turn_id: "turn-1",
    last_assistant_message: "Done",
  };

  assert.equal(
    normalizeCodexHookPayload(payload)?.id,
    normalizeCodexHookPayload(payload)?.id,
  );
});

test("normalizeCodexHookPayload can use OmniWork hook event fallback", () => {
  const event = normalizeCodexHookPayload({
    session_id: "sess-1",
    omniwork_hook_event: "Stop",
    last_assistant_message: "Done",
  });

  assert.ok(event);
  assert.equal(event.event_type, "agent.completed");
  assert.equal(event.payload?.omniwork_hook_event, "Stop");
});
