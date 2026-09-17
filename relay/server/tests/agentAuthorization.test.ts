import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { generateIdentityKeyPair } from "@omni-work/protocol-ts";

import { loadRelayServerConfig } from "../src/config.ts";
import { RelayAdminController } from "../src/relayAdminController.ts";

test("manual Agent authorization requires approval and persists it", () => {
  const dir = mkdtempSync(join(tmpdir(), "omniwork-agent-auth-manual-"));
  try {
    const config = createConfig(dir);
    assert.equal(config.agentAuthorization.mode, "manual");
    const admin = createAdmin(config);
    admin.start();
    const identity = generateIdentityKeyPair("agent");
    const request = {
      deviceId: identity.id,
      devicePublicKey: identity.publicKey,
      remoteIp: "8.8.8.8",
      publicRemoteIp: "8.8.8.8",
      hostname: "agent-host",
      systemType: "Darwin",
      uname: "Darwin agent-host 25.6.0 arm64",
      agentVersion: "0.1.0",
    };

    assert.deepEqual(admin.authorizeAgent(request), {
      ok: false,
      reason: "agent_approval_required",
    });
    const pending = internals(admin).agentAuthorizationsSnapshot().pending;
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.agent_device_id, identity.id);
    assert.equal(pending[0]?.public_ip, request.publicRemoteIp);
    assert.equal(pending[0]?.system_type, request.systemType);
    assert.equal(pending[0]?.uname, request.uname);

    internals(admin).approveAgentDevice(identity.id, "operator approved");
    assert.deepEqual(admin.authorizeAgent(request), { ok: true });

    const reloaded = createAdmin(config);
    reloaded.start();
    assert.deepEqual(reloaded.authorizeAgent(request), { ok: true });
    assert.equal(
      internals(reloaded).agentAuthorizationsSnapshot().authorized[0]
        ?.agent_device_id,
      identity.id,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("automatic Agent authorization respects device and IP blocks", () => {
  const dir = mkdtempSync(join(tmpdir(), "omniwork-agent-auth-auto-"));
  try {
    const config = createConfig(dir, "automatic");
    const admin = createAdmin(config);
    admin.start();
    const first = generateIdentityKeyPair("agent");

    assert.deepEqual(
      admin.authorizeAgent({
        deviceId: first.id,
        devicePublicKey: first.publicKey,
        remoteIp: "8.8.4.4",
        publicRemoteIp: "8.8.4.4",
        hostname: "auto-host",
        systemType: "Darwin",
        uname: "Darwin auto-host 25.6.0 arm64",
        agentVersion: "0.1.0",
      }),
      { ok: true },
    );
    assert.equal(
      internals(admin).agentAuthorizationsSnapshot().authorized.length,
      1,
    );

    const disabled = generateIdentityKeyPair("agent");
    internals(admin).disableAgentDevice(disabled.id, {
      id: "disabled-rule",
      createdAt: Date.now(),
    });
    assert.deepEqual(
      admin.authorizeAgent({
        deviceId: disabled.id,
        devicePublicKey: disabled.publicKey,
        remoteIp: "203.0.113.21",
        publicRemoteIp: null,
        hostname: "disabled-host",
        systemType: "Darwin",
        uname: "Darwin disabled-host 25.6.0 arm64",
        agentVersion: "0.1.0",
      }),
      { ok: false, reason: "agent_disabled" },
    );
    for (const alias of [disabled.id.toLowerCase(), disabled.id.replaceAll("-", "")]) {
      assert.deepEqual(
        admin.authorizeAgent({
          deviceId: alias,
          devicePublicKey: disabled.publicKey,
          remoteIp: "203.0.113.21",
          publicRemoteIp: null,
          hostname: "disabled-alias",
          systemType: "Darwin",
          uname: "Darwin disabled-alias 25.6.0 arm64",
          agentVersion: "0.1.0",
        }),
        { ok: false, reason: "agent_disabled" },
      );
    }

    const banned = generateIdentityKeyPair("agent");
    internals(admin).banIp("203.0.113.22", {
      id: "ip-rule",
      createdAt: Date.now(),
    });
    assert.deepEqual(
      admin.authorizeAgent({
        deviceId: banned.id,
        devicePublicKey: banned.publicKey,
        remoteIp: "203.0.113.22",
        publicRemoteIp: null,
        hostname: "banned-host",
        systemType: "Darwin",
        uname: "Darwin banned-host 25.6.0 arm64",
        agentVersion: "0.1.0",
      }),
      { ok: false, reason: "ip_banned" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects unsupported Agent authorization modes", () => {
  const dir = mkdtempSync(join(tmpdir(), "omniwork-agent-auth-invalid-"));
  try {
    assert.throws(
      () => createConfig(dir, "unexpected"),
      /Use manual or automatic/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createConfig(dir: string, mode?: string) {
  return loadRelayServerConfig(
    {
      OMNIWORK_RELAY_HOST: "127.0.0.1",
      OMNIWORK_RELAY_RUNTIME_DIR: dir,
      OMNIWORK_RELAY_ADMIN_REQUIRE_HTTPS: "false",
      ...(mode
        ? { OMNIWORK_RELAY_AGENT_AUTHORIZATION_MODE: mode }
        : {}),
    },
    {
      cwd: join(dir, "missing-cwd"),
      programDir: join(dir, "missing-program"),
      packageRoot: join(dir, "missing-package"),
      globalConfigPath: join(dir, "missing-global.yml"),
    },
  );
}

function createAdmin(config: ReturnType<typeof createConfig>) {
  return new RelayAdminController({
    config,
    connections: new Map(),
    mobilesByDevice: new Map(),
    state: {
      runtimeSnapshot: () => ({
        totals: {
          device_count: 0,
          agent_count: 0,
          app_connection_count: 0,
          link_count: 0,
          connection_count: 0,
        },
        traffic: {},
        auth: {},
        routing: {},
        protocol: {},
      }),
    } as never,
    unregister: () => undefined,
  });
}

function internals(admin: RelayAdminController) {
  return admin as unknown as {
    agentAuthorizationsSnapshot(): {
      pending: Array<{
        agent_device_id: string;
        public_ip: string | null;
        system_type: string;
        uname: string;
      }>;
      authorized: Array<{ agent_device_id: string }>;
    };
    approveAgentDevice(deviceId: string, reason?: string): void;
    disableAgentDevice(
      deviceId: string,
      rule: { id: string; createdAt: number },
    ): void;
    banIp(ip: string, rule: { id: string; createdAt: number }): void;
  };
}
