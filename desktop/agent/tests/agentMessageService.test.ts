import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { AgentProbeEvent } from "@omniwork/protocol-ts";
import {
  AgentMessageService,
  type AgentSystemNotificationPayload,
} from "../src/probes/agentMessageService.ts";

function probeEvent(overrides: Partial<AgentProbeEvent>): AgentProbeEvent {
  return {
    id: "event-1",
    provider: "codex",
    probe_id: "codex-hooks",
    session_id: "sess-1",
    surface_id: "surface_sess-1_terminal",
    workspace_path: "/tmp/project",
    event_type: "agent.approval_required",
    severity: "warning",
    title: "Codex needs approval",
    summary: "npm test",
    source: {
      kind: "cli-hook",
      raw_event_id: "tool-1",
    },
    created_at: "2026-06-24T00:00:00.000Z",
    ...overrides,
  };
}

test("AgentMessageService converts actionable probe events to app messages", () => {
  const pushed = [];
  const service = new AgentMessageService({
    onMessage(message) {
      pushed.push(message);
    },
  });

  const message = service.publishProbeEvent(probeEvent({}));

  assert.equal(message?.provider, "codex");
  assert.equal(message?.message_kind, "approval");
  assert.equal(message?.priority, "high");
  assert.equal(message?.action?.type, "open_approval");
  assert.equal(message?.surface_id, "surface_sess-1_terminal");
  assert.equal(message?.workspace_path, "/tmp/project");
  assert.equal(message?.action?.surface_id, "surface_sess-1_terminal");
  assert.equal(message?.action?.workspace_path, "/tmp/project");
  assert.equal(service.list().length, 1);
  assert.equal(pushed.length, 1);
});

test("AgentMessageService deduplicates probe events and filters low value events", () => {
  const service = new AgentMessageService();
  const actionable = probeEvent({ id: "same" });
  const ignored = probeEvent({
    id: "ignored",
    event_type: "agent.tool_call_started",
  });

  assert.ok(service.publishProbeEvent(actionable));
  assert.equal(service.publishProbeEvent(actionable), null);
  assert.equal(service.publishProbeEvent(ignored), null);
  assert.equal(service.list().length, 1);
});

test("AgentMessageService supports read ack and filtered list", () => {
  const service = new AgentMessageService();
  const first = service.publishProbeEvent(probeEvent({ id: "first" }));
  service.publishProbeEvent(
    probeEvent({
      id: "second",
      session_id: "sess-2",
      surface_id: "surface_sess-2_terminal",
      provider: "claude-code",
      event_type: "agent.failed",
      severity: "critical",
    }),
  );

  assert.ok(first);
  assert.equal(service.list({ provider: "codex" }).length, 1);
  assert.equal(service.list({ session_id: "sess-2" }).length, 1);
  assert.equal(
    service.list({ surface_id: "surface_sess-1_terminal" }).length,
    1,
  );
  assert.equal(service.ack(first.id, true)?.read_at !== undefined, true);
  assert.equal(service.list({ unread_only: true }).length, 1);
});

test("AgentMessageService emits sanitized notification candidates by preference", () => {
  const notifications: AgentSystemNotificationPayload[] = [];
  const service = new AgentMessageService({
    onNotification(notification) {
      notifications.push(notification);
    },
  });

  service.publishProbeEvent(probeEvent({ id: "approval" }));

  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0], {
    message_id: service.list()[0].id,
    title: "Codex needs approval",
    body: "npm test",
    action: "open_approval",
    priority: "high",
    created_at: "2026-06-24T00:00:00.000Z",
  });

  service.setNotificationSettings({
    enabled: true,
    min_priority: "critical",
    muted_providers: [],
    muted_message_kinds: [],
  });
  service.publishProbeEvent(probeEvent({ id: "muted-by-priority" }));
  assert.equal(notifications.length, 1);

  service.setNotificationSettings({
    enabled: true,
    min_priority: "high",
    muted_providers: ["codex"],
    muted_message_kinds: [],
  });
  service.publishProbeEvent(probeEvent({ id: "muted-by-provider" }));
  assert.equal(notifications.length, 1);

  service.setNotificationSettings({
    enabled: false,
    min_priority: "high",
    muted_providers: [],
    muted_message_kinds: [],
  });
  service.publishProbeEvent(probeEvent({ id: "disabled" }));
  assert.equal(notifications.length, 1);
});
