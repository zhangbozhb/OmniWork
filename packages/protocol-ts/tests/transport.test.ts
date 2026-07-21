import assert from "node:assert/strict";
import test from "node:test";

import {
  isStrictTransportControlMessage,
  MESSAGE_TYPES,
  messageTypeSchema,
  transitionUpgradeState,
} from "../src/index.ts";

test("message type schema follows the domain message registry", () => {
  assert.deepEqual(messageTypeSchema.options, [...MESSAGE_TYPES]);
});

test("strict transport control messages are classified centrally", () => {
  assert.equal(isStrictTransportControlMessage("transport.ping"), true);
  assert.equal(isStrictTransportControlMessage("tunnel.upgrade.offer"), true);
  assert.equal(isStrictTransportControlMessage("session.list"), false);
});

test("upgrade state transitions reject platform-specific drift", () => {
  assert.equal(transitionUpgradeState("idle", "proposed"), "proposed");
  assert.equal(
    transitionUpgradeState("proposed", "negotiating"),
    "negotiating",
  );
  assert.throws(
    () => transitionUpgradeState("idle", "upgraded"),
    /Invalid upgrade state transition/,
  );
});
