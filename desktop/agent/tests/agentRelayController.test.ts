import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  E2E_SUPPORT_V2,
  generateIdentityKeyPair,
  type MessageEnvelope,
} from "@omni-work/protocol-ts";
import type { RelayCloseEvent } from "@omni-work/relay-client";

import type { AgentConfig } from "../src/config/config.ts";
import { AgentRelayController } from "../src/core/agentRelayController.ts";
import type { AgentRelayClient } from "../src/relay-client/agentRelayClient.ts";

test("Agent handles a Relay shutdown received while connect is resolving", {
  timeout: 1_000,
}, async () => {
  const identity = generateIdentityKeyPair("agent");
  const relay = new ClosingRelayClient({
    code: 4404,
    reason: "ip_banned",
  });
  let unavailableCount = 0;
  let resolveShutdown: (reason: string) => void = () => undefined;
  const shutdown = new Promise<string>((resolve) => {
    resolveShutdown = resolve;
  });
  const controller = new AgentRelayController({
    config: {
      relayUrl: "ws://127.0.0.1:17887/relay/ws/agent",
      identity,
      deviceId: identity.id,
      relayReconnectForever: true,
      relayReconnectMaxAttempts: 0,
      relayReconnectInitialDelayMs: 1,
      relayReconnectMaxDelayMs: 10,
    } as AgentConfig,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    } as never,
    logTransport: false,
    createRelayClient: () => relay as unknown as AgentRelayClient,
    terminalProviders: {
      providers: () => [],
      capabilities: () => [],
    } as never,
    workspaces: { snapshot: () => [] } as never,
    terminalStreamPusher: { stopAll: async () => undefined } as never,
    e2eSupport: () => E2E_SUPPORT_V2,
    onMessage: async () => undefined,
    onRelayUnavailable: () => {
      unavailableCount += 1;
    },
    onRelayShutdownRequested: resolveShutdown,
  });

  controller.start();
  try {
    assert.equal(await shutdown, "ip_banned");
    assert.equal(controller.statusSnapshot().status, "stopped");
    assert.equal(unavailableCount, 1);
    assert.equal(relay.sent.length, 0);
  } finally {
    controller.stop();
  }
});

class ClosingRelayClient {
  readonly sent: MessageEnvelope[] = [];
  private readonly closeEvent: RelayCloseEvent;
  private readonly messageHandlers = new Set<
    (message: MessageEnvelope) => void
  >();
  private readonly closeHandlers = new Set<
    (event: RelayCloseEvent) => void
  >();

  constructor(closeEvent: RelayCloseEvent) {
    this.closeEvent = closeEvent;
  }

  async connect(): Promise<void> {
    for (const handler of this.closeHandlers) {
      handler(this.closeEvent);
    }
  }

  onMessage(handler: (message: MessageEnvelope) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onClose(handler: (event: RelayCloseEvent) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  send(message: MessageEnvelope): void {
    this.sent.push(message);
  }

  close(): void {}
}
