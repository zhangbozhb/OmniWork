import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { AgentProbeEvent, TerminalSession } from "@omniwork/protocol-ts";
import { enrichProbeEventWithSessions } from "../src/probes/agentProbeEnrichment.ts";

function fakeSession(overrides: Partial<TerminalSession> = {}): TerminalSession {
  const now = new Date().toISOString();
  return {
    session_id: "sess-1",
    primary_surface_id: "surface_sess-1_terminal",
    surfaces: [
      {
        surface_id: "surface_sess-1_terminal",
        session_id: "sess-1",
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
    tmux_session_name: "omniwork_sess_1",
    workspace_path: "/tmp/project",
    workspace_name: "project",
    origin: "managed",
    registered: true,
    ...overrides,
  };
}

function probeEvent(overrides: Partial<AgentProbeEvent> = {}): AgentProbeEvent {
  return {
    id: "event-1",
    provider: "codex",
    probe_id: "codex-hooks",
    session_id: "provider-session-1",
    workspace_path: "/tmp/project",
    event_type: "agent.approval_required",
    severity: "warning",
    source: {
      kind: "cli-hook",
      raw_event_id: "tool-1",
    },
    created_at: "2026-06-25T00:00:00.000Z",
    ...overrides,
  };
}

test("enrichProbeEventWithSessions maps provider hook events to a terminal surface", () => {
  const enriched = enrichProbeEventWithSessions(probeEvent(), [fakeSession()]);

  assert.equal(enriched.session_id, "sess-1");
  assert.equal(enriched.surface_id, "surface_sess-1_terminal");
  assert.equal(enriched.payload?.provider_session_id, "provider-session-1");
});

test("enrichProbeEventWithSessions picks the matching provider and workspace", () => {
  const enriched = enrichProbeEventWithSessions(
    probeEvent({
      provider: "claude-code",
      workspace_path: "/tmp/claude-project",
    }),
    [
      fakeSession({
        session_id: "sess-codex",
        primary_surface_id: "surface_sess-codex_terminal",
        workspace_path: "/tmp/project",
      }),
      fakeSession({
        session_id: "sess-claude",
        primary_surface_id: "surface_sess-claude_terminal",
        terminal_provider_kind: "claude",
        terminal_provider_label: "Claude",
        workspace_path: "/tmp/claude-project",
        cwd: "/tmp/claude-project",
        surfaces: [
          {
            surface_id: "surface_sess-claude_terminal",
            session_id: "sess-claude",
            kind: "terminal",
            title: "Claude 1",
            status: "active",
            provider: "claude",
          },
        ],
      }),
    ],
  );

  assert.equal(enriched.session_id, "sess-claude");
  assert.equal(enriched.surface_id, "surface_sess-claude_terminal");
});

test("enrichProbeEventWithSessions accepts claudecode as a Claude Code alias", () => {
  const enriched = enrichProbeEventWithSessions(
    probeEvent({
      provider: "claudecode",
      workspace_path: "/tmp/claude-project",
    }),
    [
      fakeSession({
        session_id: "sess-claude",
        primary_surface_id: "surface_sess-claude_terminal",
        terminal_provider_kind: "claude",
        terminal_provider_label: "Claude",
        workspace_path: "/tmp/claude-project",
        cwd: "/tmp/claude-project",
        surfaces: [
          {
            surface_id: "surface_sess-claude_terminal",
            session_id: "sess-claude",
            kind: "terminal",
            title: "Claude 1",
            status: "active",
            provider: "claude",
          },
        ],
      }),
    ],
  );

  assert.equal(enriched.session_id, "sess-claude");
  assert.equal(enriched.surface_id, "surface_sess-claude_terminal");
});
