import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  classifyRelayClose,
  isTerminalRelayConnectionError,
  nextRelayReconnectDelayMs,
  relayReconnectAttemptLimitLabel,
  shouldLimitRelayReconnectAttempt,
} from "../src/core/relayReconnectPolicy.ts";

test("classifyRelayClose treats explicit relay policy close as terminal", () => {
  assert.equal(
    classifyRelayClose({ code: 4403, reason: "agent_disabled" }),
    "terminal",
  );
  assert.equal(classifyRelayClose({ code: 1008, reason: "" }), "terminal");
  assert.equal(classifyRelayClose({ code: 1006, reason: "" }), "retryable");
});

test("isTerminalRelayConnectionError recognizes legacy auth rejection text", () => {
  assert.equal(
    isTerminalRelayConnectionError(new Error("Unexpected 403 forbidden")),
    true,
  );
  assert.equal(isTerminalRelayConnectionError(new Error("ECONNRESET")), false);
});

test("reconnect attempt limit supports forever and maxAttempts=0 semantics", () => {
  assert.equal(
    shouldLimitRelayReconnectAttempt({
      reconnectForever: true,
      maxAttempts: 8,
      nextAttempt: 99,
    }),
    false,
  );
  assert.equal(
    shouldLimitRelayReconnectAttempt({
      reconnectForever: false,
      maxAttempts: 0,
      nextAttempt: 99,
    }),
    false,
  );
  assert.equal(
    shouldLimitRelayReconnectAttempt({
      reconnectForever: false,
      maxAttempts: 8,
      nextAttempt: 9,
    }),
    true,
  );
  assert.equal(
    relayReconnectAttemptLimitLabel({ reconnectForever: false, maxAttempts: 0 }),
    "unlimited",
  );
});

test("nextRelayReconnectDelayMs applies exponential cap and jitter", () => {
  assert.equal(
    nextRelayReconnectDelayMs({
      attempt: 5,
      initialDelayMs: 1000,
      maxDelayMs: 30000,
      random: () => 0.5,
    }),
    16000,
  );
  assert.equal(
    nextRelayReconnectDelayMs({
      attempt: 20,
      initialDelayMs: 1000,
      maxDelayMs: 30000,
      random: () => 0,
    }),
    24000,
  );
});
