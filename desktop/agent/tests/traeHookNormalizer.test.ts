import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  normalizeTraeHookPayload,
  normalizeTraeProbeProvider,
} from "../src/probes/traeHookNormalizer.ts";

test("normalizeTraeHookPayload maps Trae permission notifications", () => {
  const event = normalizeTraeHookPayload("trae", {
    session_id: "sess-1",
    hook_event_name: "Notification",
    workspace_path: "/tmp/project",
    notification_type: "permission_prompt",
    message: "Approve Bash?",
  });

  assert.ok(event);
  assert.equal(event.provider, "trae");
  assert.equal(event.probe_id, "trae-hooks");
  assert.equal(event.session_id, "sess-1");
  assert.equal(event.workspace_path, "/tmp/project");
  assert.equal(event.event_type, "agent.approval_required");
  assert.equal(event.severity, "warning");
  assert.equal(event.title, "Trae needs approval");
  assert.equal(event.summary, "Approve Bash?");
  assert.equal(event.payload?.notification_type, "permission_prompt");
  assert.equal(event.source.kind, "cli-hook");
});

test("normalizeTraeHookPayload accepts official snake_case event aliases", () => {
  const event = normalizeTraeHookPayload("trae-cn", {
    conversation_id: "conv-1",
    event: "post_tool_use",
    cwd: "/tmp/project",
    llm_tool_name: "Write",
    tool_use_id: "tool-1",
    tool_input: {
      file_path: "/tmp/project/README.md",
    },
  });

  assert.ok(event);
  assert.equal(event.provider, "trae-cn");
  assert.equal(event.probe_id, "trae-cn-hooks");
  assert.equal(event.session_id, "conv-1");
  assert.equal(event.event_type, "agent.tool_call_finished");
  assert.equal(event.severity, "info");
  assert.equal(event.title, "Trae CN finished Write");
  assert.equal(event.summary, "/tmp/project/README.md");
  assert.equal(event.payload?.tool_use_id, "tool-1");
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

test("normalizeTraeHookPayload maps idle notifications as completed", () => {
  const event = normalizeTraeHookPayload("trae-cn", {
    session_id: "sess-1",
    hook_event_name: "Notification",
    message: "Trae finished the task",
    notification_type: "idle_prompt",
  });

  assert.ok(event);
  assert.equal(event.event_type, "agent.completed");
  assert.equal(event.severity, "notice");
  assert.equal(event.title, "Trae CN completed");
  assert.equal(event.summary, "Trae finished the task");
});

test("normalizeTraeHookPayload preserves Trae Stop payload fields", () => {
  const event = normalizeTraeHookPayload("trae", {
    session_id: "sess-1",
    hook_event_name: "Stop",
    last_assistant_message: "Done",
    loop_count: 2,
    stop_hook_active: true,
  });

  assert.ok(event);
  assert.equal(event.event_type, "agent.completed");
  assert.equal(event.summary, "Done");
  assert.equal(event.payload?.last_assistant_message, "Done");
  assert.equal(event.payload?.loop_count, 2);
  assert.equal(event.payload?.stop_hook_active, true);
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
        hook_event_name: "PermissionRequest",
        session_id: "sess-1",
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

test("normalizeTraeHookPayload includes Stop summaries in stable ids", () => {
  const base = {
    session_id: "sess-1",
    event: "stop",
  };

  assert.notEqual(
    normalizeTraeHookPayload("trae", {
      ...base,
      last_assistant_message: "Done 1",
    })?.id,
    normalizeTraeHookPayload("trae", {
      ...base,
      last_assistant_message: "Done 2",
    })?.id,
  );
});

test("normalizeTraeHookPayload uses OmniWork record ids for replay dedupe", () => {
  const event = normalizeTraeHookPayload("trae", {
    session_id: "sess-1",
    hook_event_name: "Stop",
    omniwork_record_id: "record-1",
    last_assistant_message: "Done",
  });

  assert.ok(event);
  assert.equal(event.id, "record-1");
  assert.equal(event.payload?.omniwork_record_id, "record-1");
});
