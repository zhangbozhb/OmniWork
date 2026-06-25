import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  normalizeTraeHookPayload,
  normalizeTraeProbeProvider,
} from "../src/probes/traeHookNormalizer.ts";

test("normalizeTraeHookPayload maps Trae approval hooks", () => {
  const event = normalizeTraeHookPayload("trae", {
    session_id: "sess-1",
    hook_event_name: "PermissionRequest",
    workspace_path: "/tmp/project",
    tool_name: "Bash",
    tool_input: {
      command: "pnpm test",
    },
  });

  assert.ok(event);
  assert.equal(event.provider, "trae");
  assert.equal(event.probe_id, "trae-hooks");
  assert.equal(event.session_id, "sess-1");
  assert.equal(event.workspace_path, "/tmp/project");
  assert.equal(event.event_type, "agent.approval_required");
  assert.equal(event.severity, "warning");
  assert.equal(event.title, "Trae needs approval for Bash");
  assert.equal(event.summary, "pnpm test");
  assert.equal(event.source.kind, "cli-hook");
});

test("normalizeTraeHookPayload accepts traecli yaml event aliases", () => {
  const event = normalizeTraeHookPayload("trae-cn", {
    conversation_id: "conv-1",
    event: "post_tool_use_failure",
    cwd: "/tmp/project",
    tool_name: "Write",
    reason: "permission denied",
  });

  assert.ok(event);
  assert.equal(event.provider, "trae-cn");
  assert.equal(event.probe_id, "trae-cn-hooks");
  assert.equal(event.session_id, "conv-1");
  assert.equal(event.event_type, "agent.failed");
  assert.equal(event.severity, "critical");
  assert.equal(event.title, "Trae CN failed Write");
  assert.equal(event.summary, "permission denied");
});

test("normalizeTraeHookPayload maps notification hooks", () => {
  const event = normalizeTraeHookPayload("trae", {
    session_id: "sess-1",
    event_name: "notification",
    message: "Trae is waiting for input",
    notification_type: "input_required",
  });

  assert.ok(event);
  assert.equal(event.event_type, "agent.waiting_user_input");
  assert.equal(event.severity, "warning");
  assert.equal(event.summary, "Trae is waiting for input");
  assert.equal(event.payload?.notification_type, "input_required");
});

test("normalizeTraeHookPayload ignores unsupported or incomplete payloads", () => {
  assert.equal(
    normalizeTraeHookPayload("trae", {
      session_id: "sess-1",
      hook_event_name: "UnknownHook",
    }),
    null,
  );
  assert.equal(
    normalizeTraeHookPayload("trae-cn", {
      hook_event_name: "Stop",
    }),
    null,
  );
});

test("normalizeTraeProbeProvider canonicalizes local Trae aliases", () => {
  assert.equal(normalizeTraeProbeProvider("traex"), "trae");
  assert.equal(normalizeTraeProbeProvider("coco"), "trae");
  assert.equal(normalizeTraeProbeProvider("trae_cn"), "trae-cn");
  assert.equal(normalizeTraeProbeProvider("codex"), null);
});
