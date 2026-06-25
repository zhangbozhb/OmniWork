import { strict as assert } from "node:assert";
import { test } from "node:test";

import { normalizeClaudeHookPayload } from "../src/probes/claudeHookNormalizer.ts";

test("normalizeClaudeHookPayload maps PermissionRequest to approval probe event", () => {
  const event = normalizeClaudeHookPayload({
    session_id: "sess-1",
    hook_event_name: "PermissionRequest",
    cwd: "/tmp/project",
    tool_name: "Bash",
    tool_input: {
      command: "npm test",
    },
  });

  assert.ok(event);
  assert.equal(event.provider, "claude-code");
  assert.equal(event.probe_id, "claude-code-hooks");
  assert.equal(event.session_id, "sess-1");
  assert.equal(event.event_type, "agent.approval_required");
  assert.equal(event.severity, "warning");
  assert.equal(event.summary, "npm test");
  assert.equal(event.source.kind, "cli-hook");
});

test("normalizeClaudeHookPayload ignores unsupported or incomplete hook payloads", () => {
  assert.equal(
    normalizeClaudeHookPayload({
      session_id: "sess-1",
      hook_event_name: "UnknownHook",
    }),
    null,
  );
  assert.equal(
    normalizeClaudeHookPayload({
      hook_event_name: "Stop",
    }),
    null,
  );
});

test("normalizeClaudeHookPayload creates stable ids for duplicate hook payloads", () => {
  const payload = {
    session_id: "sess-1",
    hook_event_name: "Stop",
    message: "Done",
  };

  assert.equal(
    normalizeClaudeHookPayload(payload)?.id,
    normalizeClaudeHookPayload(payload)?.id,
  );
});

test("normalizeClaudeHookPayload can use OmniWork hook event fallback", () => {
  const event = normalizeClaudeHookPayload({
    session_id: "sess-1",
    omniwork_hook_event: "SessionEnd",
    reason: "prompt_input_exit",
  });

  assert.ok(event);
  assert.equal(event.event_type, "agent.exited");
  assert.equal(event.payload?.omniwork_hook_event, "SessionEnd");
});

test("normalizeClaudeHookPayload maps Claude Code notification and failure hooks", () => {
  const notification = normalizeClaudeHookPayload({
    session_id: "sess-1",
    hook_event_name: "Notification",
    message: "Claude Code is waiting for input",
    notification_type: "input_required",
  });
  const failure = normalizeClaudeHookPayload({
    session_id: "sess-1",
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    reason: "command failed",
  });
  const denied = normalizeClaudeHookPayload({
    session_id: "sess-1",
    hook_event_name: "PermissionDenied",
    tool_name: "Write",
    reason: "blocked by user",
  });

  assert.ok(notification);
  assert.equal(notification.event_type, "agent.waiting_user_input");
  assert.equal(notification.severity, "warning");
  assert.equal(notification.summary, "Claude Code is waiting for input");
  assert.equal(notification.payload?.notification_type, "input_required");

  assert.ok(failure);
  assert.equal(failure.event_type, "agent.failed");
  assert.equal(failure.severity, "critical");
  assert.equal(failure.summary, "command failed");

  assert.ok(denied);
  assert.equal(denied.event_type, "agent.failed");
  assert.equal(denied.title, "Claude Code permission denied for Write");
});
