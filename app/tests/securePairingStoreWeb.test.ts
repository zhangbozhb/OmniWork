import assert from "node:assert/strict";
import test from "node:test";

import { generateIdentityKeyPair } from "@omni-work/protocol-ts";
import {
  clearPairing,
  loadPairings,
  savePairings,
} from "../src/platform/secure-storage/securePairingStore.web.ts";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test("Web pairing persistence keeps Relay session tokens session-scoped", async () => {
  const previousLocalStorage = globalThis.localStorage;
  const previousSessionStorage = globalThis.sessionStorage;
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  Object.assign(globalThis, {
    localStorage: local,
    sessionStorage: session,
  });

  try {
    const agent = generateIdentityKeyPair("agent");
    await savePairings([
      {
        relayUrl: "wss://relay.example/relay/ws/mobile",
        deviceId: agent.id,
        displayName: "Desktop",
        relaySessionToken: "relay-session-secret",
        appInstanceId: "app_instance_1",
      },
    ]);

    assert.equal(
      local.getItem("omniwork.pairings")?.includes("relay-session-secret"),
      false,
    );
    assert.equal(
      session.getItem("omniwork.pairings")?.includes("relay-session-secret"),
      true,
    );
    assert.equal(
      (await loadPairings())[0]?.relaySessionToken,
      "relay-session-secret",
    );
  } finally {
    await clearPairing();
    Object.assign(globalThis, {
      localStorage: previousLocalStorage,
      sessionStorage: previousSessionStorage,
    });
  }
});
