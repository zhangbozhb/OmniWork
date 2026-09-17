import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

import { generateIdentityKeyPair } from "@omni-work/protocol-ts";
import * as pairingState from "../src/app/pairingState.ts";
import * as pairingConfig from "../src/features/auth/pairingConfig.ts";
import { createPairingShareLink } from "../src/features/auth/pairingShare.ts";
import type { PairingConfig } from "../src/features/auth/types.ts";
import type { usePairingController } from "../src/features/auth/usePairingController";

async function mountController(saved: PairingConfig[], initialUrl?: string) {
  const state: unknown[] = [];
  const effects: (() => unknown)[] = [];
  let cursor = 0;
  let mounted = false;
  let listener: (url: string) => void = () => {};
  let persisted = saved;
  const messages: string[] = [];
  const statuses: string[] = [];
  const views: string[] = [];
  const exports: { usePairingController?: typeof usePairingController } = {};
  function useState(value: unknown) {
    const index = cursor++;
    if (!(index in state)) state[index] = value;
    return [state[index], (next: unknown) => { state[index] = next; }];
  }
  const mocks: Record<string, unknown> = {
    react: {
      useState,
      useRef: (value: unknown) => useState({ current: value })[0],
      useEffect: (effect: () => unknown) => { if (!mounted) effects.push(effect); },
    },
    "react-native": { Alert: { alert() {} } },
    "../../app/connectionMessages": { formatErrorMessage: String },
    "../../app/pairingState": pairingState,
    "../../platform/linking/appLinking": {
      getInitialAppUrl: async () => initialUrl,
      addAppUrlListener: (callback: typeof listener) => {
        listener = callback;
        return { remove() {} };
      },
    },
    "../../platform/secure-storage/securePairingStore": {
      loadPairings: async () => saved,
      savePairings: async (value: PairingConfig[]) => { persisted = value; },
      clearPairing: async () => { persisted = []; },
    },
    "./pairingConfig": pairingConfig,
  };
  const source = readFileSync(
    new URL("../src/features/auth/usePairingController.ts", import.meta.url),
    "utf8",
  );
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports,
    require(name: string) {
      assert.ok(name in mocks, `Unexpected dependency: ${name}`);
      return mocks[name];
    },
  });
  function render() {
    cursor = 0;
    return exports.usePairingController!({
      t: (key) => key,
      confirm: async () => true,
      getConnectionStatus: () => "idle",
      setView: (value) => { views.push(value); },
      setConnectionStatus: (value) => { statuses.push(value); },
      setConnectionMessage: (value) => { messages.push(value); },
      onClearActiveDeviceData() {},
      onCloseActiveTransport() {},
      onReconnectActivePairing() {},
      onRequestActiveDeviceRefresh() {},
      setPendingAutoOpenSessions() {},
    });
  }
  render();
  mounted = true;
  effects.forEach((effect) => effect());
  await new Promise<void>((resolve) => setImmediate(resolve));
  return {
    render, messages, statuses, views,
    saved: () => persisted,
    async openLink(url: string) {
      listener(url);
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

test("pairing imports preserve same-target sessions but editing can clear them", async () => {
  const saved = pairingConfig.createPairingConfig({
    relayUrl: "wss://relay.example/relay/ws/mobile",
    deviceId: generateIdentityKeyPair("agent").id,
    relaySessionToken: "private-session",
  })!;
  const link = createPairingShareLink(saved);
  for (const entry of ["initial", "listener", "manual"]) {
    const controller = await mountController([saved], entry === "initial" ? link : undefined);
    if (entry === "listener") await controller.openLink(link);
    if (entry === "manual") {
      await controller.render().handlePair(pairingConfig.parsePairingConfig(link)!);
    }
    assert.equal(controller.saved().length, 1);
    assert.equal(controller.saved()[0]?.relaySessionToken, "private-session");
    assert.equal(controller.render().pairing?.relaySessionToken, "private-session");
    controller.render().handleEditDevice(controller.saved()[0]!);
    await controller.render().handlePair({ ...saved, relaySessionToken: undefined });
    assert.equal(controller.saved()[0]?.relaySessionToken, undefined);
  }
});

test("cross-Relay imports do not inherit credentials and auth failures guide sign-in", async () => {
  const saved = pairingConfig.createPairingConfig({
    relayUrl: "wss://relay.example/relay/ws/mobile",
    deviceId: generateIdentityKeyPair("agent").id,
    relaySessionToken: "private-session",
  })!;
  const otherRelay = { ...saved, relayUrl: "wss://other.example/relay/ws/mobile" };
  const link = createPairingShareLink(otherRelay);
  for (const entry of ["initial", "listener", "manual"]) {
    const controller = await mountController([saved], entry === "initial" ? link : undefined);
    if (entry === "listener") await controller.openLink(link);
    if (entry === "manual") {
      await controller.render().handlePair(pairingConfig.parsePairingConfig(link)!);
    }
    assert.equal(controller.render().pairing?.relaySessionToken, undefined);
    assert.equal(controller.saved()[0]?.relaySessionToken, "private-session");
    await controller.render().handleAuthFailureCleanup(otherRelay, "malformed_proof", "devices");
    assert.equal(controller.statuses.at(-1), "failed");
    assert.match(controller.messages.at(-1)!, /pairing.relaySignInFailure/);
    assert.equal(controller.messages.at(-1)!.includes("private-session"), false);
  }
});
