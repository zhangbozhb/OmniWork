import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { TerminalSession } from "@omniwork/protocol-ts";
import {
  formatRelayCloseMessage,
  formatStrictForceCloseMessage,
  getHeaderSubtitle,
  isSamePairing,
  upsertPairing,
  upsertSession,
} from "../src/app/appModel.ts";

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
    getHeaderSubtitle("sessions", 1, pairing, (key) => key),
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
