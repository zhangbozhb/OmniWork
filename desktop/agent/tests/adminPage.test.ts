import { strict as assert } from "node:assert";
import { request } from "node:http";
import { test } from "node:test";

import { renderAgentAdminPage } from "../src/adminPage.ts";
import { AgentAdminServer } from "../src/core/adminServer.ts";

test("Agent Admin page is served from static assets", () => {
  const html = renderAgentAdminPage();

  assert.match(html, /<!doctype html>/i);
  assert.match(html, /OmniWork Agent Admin/);
  assert.match(html, /\/api\/status/);
  assert.match(html, /\/api\/connections/);
  assert.match(html, /\/api\/pairing\/requests/);
  assert.match(html, /\/api\/trusted-apps/);
  assert.match(html, /id="language"/);
  assert.match(html, /data-i18n="hero\.headline"/);
  assert.match(html, /"pairing\.approve": "Approve"/);
  assert.match(html, /"pairing\.approve": "批准"/);
  assert.match(html, /id="pairing-detail-dialog"/);
  assert.match(html, /data-pair-detail-action="approve"/);
  assert.match(html, /request\.remoteIp/);
  assert.match(html, /request\.platform/);
  assert.match(html, /"trustedApps\.revoke": "撤销"/);
  assert.match(html, /"trustedApps\.remove": "移除"/);
  assert.match(html, /\/api\/trusted-apps\/.*\/remove/);
  assert.match(html, /omniwork_admin_locale/);
  assert.match(html, /navigator\.languages/);
  assert.match(html, /resolvedOptions\(\)\.timeZone/);
  assert.match(html, /Asia\/Shanghai/);
  const adminScript = html.match(/<script>([\s\S]+)<\/script>/u)?.[1];
  assert.ok(adminScript);
  assert.doesNotThrow(() => new Function(adminScript));
});

test("Agent Admin requires a token on non-loopback hosts", async () => {
  const server = new AgentAdminServer({
    host: "0.0.0.0",
    port: 0,
    getStatus: () => ({}) as never,
    getConnections: () => ({}) as never,
    getPairingRequests: () => [],
    getTrustedApps: () => [],
    approvePairing: () => false,
    rejectPairing: () => false,
    revokeApp: () => false,
    removeApp: () => false,
  });

  await assert.rejects(
    server.start(),
    /requires admin\.token when binding to a non-loopback host/u,
  );
});

test("Agent Admin protects and routes pairing actions", async () => {
  const actions: string[] = [];
  const server = new AgentAdminServer({
    host: "127.0.0.1",
    port: 0,
    token: "admin-token",
    getStatus: () => ({}) as never,
    getConnections: () => ({}) as never,
    getPairingRequests: () => [
      {
        requestId: "request-1",
        appId: "APP1-TEST",
        appPublicKey: "public-key",
        appInfo: { instance_id: "app", runtime_id: "runtime" },
        appName: "OmniWork",
        deviceName: "Alice iPhone",
        platform: "ios",
        os: "iOS",
        osVersion: "26.0",
        remoteIp: "8.8.8.8",
        ipSource: "socket_remote_address",
        requestedScopes: ["device.control"],
        connectionId: "connection-1",
        createdAt: new Date(0).toISOString(),
        expiresAt: new Date(60_000).toISOString(),
      },
    ],
    getTrustedApps: () => [],
    approvePairing: (id) => {
      actions.push(`approve:${id}`);
      return true;
    },
    rejectPairing: (id) => {
      actions.push(`reject:${id}`);
      return true;
    },
    revokeApp: (id) => {
      actions.push(`revoke:${id}`);
      return true;
    },
    removeApp: (id) => {
      actions.push(`remove:${id}`);
      return true;
    },
  });
  await server.start();
  try {
    const address = (
      server as unknown as {
        server: { address(): { port: number } | string | null };
      }
    ).server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const unauthorized = await fetch(`${baseUrl}/api/pairing/requests`);
    assert.equal(unauthorized.status, 401);

    const headers = { authorization: "Bearer admin-token" };
    const requests = await fetch(`${baseUrl}/api/pairing/requests`, {
      headers,
    });
    assert.equal(requests.status, 200);
    const requestBody = (await requests.json()) as {
      requests: Array<{
        appName: string;
        deviceName: string;
        platform: string;
        remoteIp: string;
      }>;
    };
    assert.equal(requestBody.requests.length, 1);
    assert.equal(requestBody.requests[0]?.appName, "OmniWork");
    assert.equal(requestBody.requests[0]?.deviceName, "Alice iPhone");
    assert.equal(requestBody.requests[0]?.platform, "ios");
    assert.equal(requestBody.requests[0]?.remoteIp, "8.8.8.8");

    for (const path of [
      "/api/pairing/requests/request-1/approve",
      "/api/pairing/requests/request-1/reject",
      "/api/trusted-apps/APP1-TEST/revoke",
      "/api/trusted-apps/APP1-TEST/remove",
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers,
      });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(actions, [
      "approve:request-1",
      "reject:request-1",
      "revoke:APP1-TEST",
      "remove:APP1-TEST",
    ]);

    const malformed = await fetch(
      `${baseUrl}/api/pairing/requests/%E0%A4%A/approve`,
      { headers },
    );
    assert.equal(malformed.status, 404);
    const afterMalformed = await fetch(`${baseUrl}/api/status`, { headers });
    assert.equal(afterMalformed.status, 200);
    const invalidUrlStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(baseUrl, { path: "//[" }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(invalidUrlStatus, 400);
    assert.equal((await fetch(`${baseUrl}/api/status`, { headers })).status, 200);
  } finally {
    server.close();
  }
});

test("Agent Admin rejects cross-site mutations when no token is configured", async () => {
  const actions: string[] = [];
  const server = new AgentAdminServer({
    host: "127.0.0.1",
    port: 0,
    getStatus: () => ({}) as never,
    getConnections: () => ({}) as never,
    getPairingRequests: () => [],
    getTrustedApps: () => [],
    approvePairing: (id) => {
      actions.push(`approve:${id}`);
      return true;
    },
    rejectPairing: () => false,
    revokeApp: () => false,
    removeApp: () => false,
  });
  await server.start();
  try {
    const address = (
      server as unknown as {
        server: { address(): { port: number } | string | null };
      }
    ).server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const path = "/api/pairing/requests/request-1/approve";

    const crossSite = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { origin: "https://attacker.example" },
    });
    assert.equal(crossSite.status, 403);
    assert.deepEqual(actions, []);

    const rebindingHost = `127.attacker.example:${address.port}`;
    const rebinding = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        host: rebindingHost,
        origin: `http://${rebindingHost}`,
      },
    });
    assert.equal(rebinding.status, 403);
    assert.deepEqual(actions, []);

    const sameOrigin = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { origin: baseUrl },
    });
    assert.equal(sameOrigin.status, 200);
    assert.deepEqual(actions, ["approve:request-1"]);
  } finally {
    server.close();
  }
});
