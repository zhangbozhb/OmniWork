import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { TerminalSession } from "@omni-work/protocol-ts";
import {
  formatRelayCloseMessage,
  formatStrictForceCloseMessage,
} from "../src/app/connectionMessages.ts";
import { getHeaderSubtitle } from "../src/app/appPresentation.ts";
import { getSessionCapabilities } from "../src/features/sessions/sessionCapabilities.ts";
import {
  isSamePairing,
  upsertPairing,
} from "../src/app/pairingState.ts";
import {
  upsertSession,
} from "../src/app/sessionState.ts";

const baseSession: TerminalSession = {
  session_id: "sess-1",
  primary_surface_id: "surface_sess-1_terminal",
  surfaces: [
    {
      surface_id: "surface_sess-1_terminal",
      session_id: "sess-1",
      kind: "terminal",
      title: "Demo",
      status: "active",
      provider: "codex",
    },
  ],
  terminal_provider_kind: "codex",
  terminal_provider_label: "Codex",
  title: "Demo",
  cwd: "/tmp",
  command: "codex",
  status: "running",
  created_at: new Date(0).toISOString(),
  last_active_at: new Date(0).toISOString(),
  terminal_size: { cols: 80, rows: 24 },
  tmux_session_name: "omni-sess-1",
};

test("upsertSession inserts and replaces by session_id", () => {
  assert.deepEqual(upsertSession([], baseSession), [baseSession]);

  const renamed = { ...baseSession, title: "Renamed" };
  assert.deepEqual(upsertSession([baseSession], renamed), [renamed]);
});

test("session capabilities project pending Agent attention without changing lifecycle", () => {
  const capabilities = getSessionCapabilities(baseSession, {
    attention: { kind: "waiting_approval", count: 1 },
  });

  assert.equal(baseSession.status, "running");
  assert.equal(capabilities.statusLabel, "Waiting for approval");
  assert.equal(capabilities.statusTone, "warning");
  assert.equal(capabilities.primaryActionLabel, "Review");
  assert.equal(capabilities.canOpen, true);

  const closing = getSessionCapabilities(baseSession, {
    closing: true,
    attention: { kind: "waiting_input", count: 1 },
  });
  assert.equal(closing.statusLabel, "Running");
  assert.equal(closing.primaryActionLabel, "Closing...");
});

test("upsertPairing replaces by relay URL and device ID", () => {
  const first = {
    relayUrl: "wss://relay.example/relay/ws/mobile",
    deviceId: "mac-1",
    key: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    appInstanceId: "app-1",
  };
  const refreshed = { ...first, key: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };

  assert.equal(isSamePairing(first, refreshed), true);
  assert.deepEqual(upsertPairing([first], refreshed), [refreshed]);
});

test("getHeaderSubtitle prefers pairing display name", () => {
  const pairing = {
    relayUrl: "wss://relay.example/relay/ws/mobile",
    deviceId: "mac-1",
    displayName: "Alice MacBook",
    key: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    appInstanceId: "app-1",
  };

  assert.equal(
    getHeaderSubtitle("workbench", 1, pairing, (key) => key),
    "Alice MacBook",
  );
});

test("connection close helpers keep user-facing detail", () => {
  assert.equal(
    formatRelayCloseMessage({ code: 1003, reason: "invalid protocol message" }),
    "Connection closed (1003): invalid protocol message",
  );
  assert.match(
    formatStrictForceCloseMessage("strict_unavailable:backoff_active"),
    /cooling down/,
  );
});
