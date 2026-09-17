import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the actual hook with controlled React effects and transport events.
function createHarness() {
  const states: unknown[] = [];
  const effects: Array<() => (() => void) | undefined> = [];
  let ready!: () => void;
  let changePath!: (path: string) => void;
  let forceClose!: (reason: string) => void;
  let path = "relay";
  let directReady = 0;
  let closes = 0;
  const transport = {
    connect: async () => {},
    close: () => { closes += 1; },
    getCurrentPath: () => path,
    onMessage: () => () => {},
    onClose: () => () => {},
    onBusinessReady: (handler: () => void) => {
      ready = handler;
      return () => {};
    },
    onPathChange: (handler: (path: string) => void) => {
      changePath = handler;
      return () => {};
    },
  };
  const module = { exports: {} as { useTransportController(options: unknown): void } };
  const source = readFileSync(
    new URL("../src/app/useTransportController.ts", import.meta.url), "utf8",
  );
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports: module.exports,
    require(name: string) {
      if (name === "react") {
        return {
          useState(value: unknown) {
            const index = states.push(value) - 1;
            return [value, (next: unknown) => { states[index] = next; }];
          },
          useRef: (current: unknown) => ({ current }),
          useCallback: (callback: unknown) => callback,
          useEffect: (effect: () => (() => void) | undefined) => effects.push(effect),
        };
      }
      if (name === "./connectionMessages") {
        return { formatErrorMessage: String, formatRelayCloseMessage: String, formatStrictForceCloseMessage: String };
      }
      assert.equal(name, "./appTransport");
      return {
        createAppSessionTransport(_pairing: unknown, _preference: unknown, options: { onForceClose(reason: string): void }) {
          forceClose = options.onForceClose;
          return transport;
        },
      };
    },
  });
  module.exports.useTransportController({
    pairing: { relayUrl: "wss://relay.test", deviceId: "test" },
    transportPreference: "prefer_p2p",
    onMessage() {},
    onPreferP2pConnectStart() {},
    onDirectConnectionReady() { directReady += 1; },
    setPairing() {},
  });
  const cleanups = effects.map((effect) => effect());
  return {
    states,
    ready: () => ready(),
    forceClose: () => forceClose("peer_unavailable"),
    setP2p: () => { path = "p2p"; changePath(path); },
    get directReady() { return directReady; },
    get closes() { return closes; },
    cleanup: () => cleanups.forEach((cleanup) => cleanup?.()),
  };
}

test("Direct only waits for both E2E and P2P before declaring readiness", async () => {
  const harness = createHarness();
  try {
    await Promise.resolve();
    harness.ready();
    assert.equal(harness.states[0], "authenticating");
    assert.equal(harness.directReady, 0);
    harness.setP2p();
    assert.equal(harness.directReady, 1);
  } finally {
    harness.cleanup();
  }
});

test("late readiness cannot overwrite a failed connection", async () => {
  const harness = createHarness();
  try {
    harness.forceClose();
    harness.ready();
    harness.setP2p();
    await Promise.resolve();
    assert.equal(harness.states[0], "failed");
    assert.equal(harness.directReady, 0);
    assert.equal(harness.closes, 1);
  } finally {
    harness.cleanup();
  }
});
