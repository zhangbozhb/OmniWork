import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { loadRelayServerConfig } from "../src/config.ts";
import {
  createCsrfToken,
  RelayUserAuthController,
  readJsonBody,
  USER_SESSION_COOKIE,
  verifyCsrfToken,
} from "../src/relayUserAuthController.ts";
import { RelayUserAuthStore } from "../src/relayUserAuthStore.ts";

const parsed = await readJsonBody(
  Readable.from(['{"email":"user@example.com"}']) as IncomingMessage,
);
assert.equal(parsed.email, "user@example.com");

await assert.rejects(
  () => readJsonBody(Readable.from(["{"]) as IncomingMessage),
  /invalid_json/,
);

await assert.rejects(
  () => readJsonBody(Readable.from(["x".repeat(16)]) as IncomingMessage, 8),
  /payload_too_large/,
);

{
  const sessionToken = "session-token";
  const csrfToken = createCsrfToken(sessionToken);
  assert.equal(verifyCsrfToken(sessionToken, csrfToken), true);
  assert.equal(verifyCsrfToken(sessionToken, "bad-token"), false);
}

{
  const dir = mkdtempSync(join(tmpdir(), "omniwork-relay-auth-controller-"));
  try {
    const store = new RelayUserAuthStore(join(dir, "relay-auth.sqlite"));
    const config = loadRelayServerConfig({
      OMNIWORK_RELAY_HOST: "127.0.0.1",
      OMNIWORK_RELAY_AUTH_MODE: "email_link",
      OMNIWORK_PUBLIC_BASE_URL: "http://127.0.0.1:8787",
      OMNIWORK_MAIL_FROM: "OmniWork <test@example.com>",
    });
    const revokedDeviceIds: string[] = [];
    const controller = new RelayUserAuthController({
      config,
      store,
      mail: {
        async sendMagicLink() {
          return undefined;
        },
      },
      resolveRemoteIp: () => "127.0.0.1",
      revokeActiveDevice: (deviceId) => revokedDeviceIds.push(deviceId),
    });

    const link = store.createEmailLink({
      email: "user@example.com",
      ttlMs: 60_000,
    });
    const user = store.consumeEmailLink(link.token);
    assert.ok(user);
    const session = store.createSession({
      userId: user.id,
      ttlMs: 60_000,
    });
    const cookie = `${USER_SESSION_COOKIE}=${encodeURIComponent(session.token)}`;

    const me = createFakeResponse();
    await controller.handle(
      createFakeRequest("GET", "/auth/me", { cookie }),
      me,
      new URL("http://relay.local/auth/me"),
    );
    assert.equal(me.statusCode, 200);
    const csrfToken = JSON.parse(me.body).csrf_token as string;
    assert.equal(verifyCsrfToken(session.token, csrfToken), true);

    const missingCsrf = createFakeResponse();
    await controller.handle(
      createFakeRequest("POST", "/auth/devices/enrollments", { cookie }),
      missingCsrf,
      new URL("http://relay.local/auth/devices/enrollments"),
    );
    assert.equal(missingCsrf.statusCode, 403);
    assert.deepEqual(JSON.parse(missingCsrf.body), { error: "invalid_csrf" });

    const withCsrf = createFakeResponse();
    await controller.handle(
      createFakeRequest("POST", "/auth/devices/enrollments", {
        cookie,
        "x-csrf-token": csrfToken,
      }),
      withCsrf,
      new URL("http://relay.local/auth/devices/enrollments"),
    );
    assert.equal(withCsrf.statusCode, 200);
    const enrollmentToken = JSON.parse(withCsrf.body).enrollment_token as string;
    assert.ok(enrollmentToken);

    const createDevice = createFakeResponse();
    await controller.handle(
      createFakeRequest(
        "POST",
        "/auth/devices",
        { "content-type": "application/json" },
        JSON.stringify({
          enrollment_token: enrollmentToken,
          public_key:
            "-----BEGIN PUBLIC KEY-----\ntest-public-key\n-----END PUBLIC KEY-----",
          device_name: "MacBook",
        }),
      ),
      createDevice,
      new URL("http://relay.local/auth/devices"),
    );
    assert.equal(createDevice.statusCode, 200);
    const deviceId = JSON.parse(createDevice.body).device_id as string;
    assert.ok(deviceId);

    const listDevices = createFakeResponse();
    await controller.handle(
      createFakeRequest("GET", "/auth/devices", { cookie }),
      listDevices,
      new URL("http://relay.local/auth/devices"),
    );
    assert.equal(listDevices.statusCode, 200);
    assert.equal(JSON.parse(listDevices.body).devices[0].device_id, deviceId);

    const revokeDevice = createFakeResponse();
    await controller.handle(
      createFakeRequest("POST", `/auth/devices/${deviceId}/revoke`, {
        cookie,
        "x-csrf-token": csrfToken,
      }),
      revokeDevice,
      new URL(`http://relay.local/auth/devices/${deviceId}/revoke`),
    );
    assert.equal(revokeDevice.statusCode, 200);
    assert.deepEqual(JSON.parse(revokeDevice.body), { ok: true });
    assert.deepEqual(revokedDeviceIds, [deviceId]);

    const bearer = createFakeResponse();
    await controller.handle(
      createFakeRequest("POST", "/auth/devices/enrollments", {
        authorization: `Bearer ${session.token}`,
      }),
      bearer,
      new URL("http://relay.local/auth/devices/enrollments"),
    );
    assert.equal(bearer.statusCode, 200);
    assert.ok(JSON.parse(bearer.body).enrollment_token);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("relay user auth controller tests passed");

function createFakeRequest(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body = "",
): IncomingMessage {
  const request = Readable.from(body ? [body] : []) as IncomingMessage;
  request.method = method;
  request.url = url;
  request.headers = headers;
  return request;
}

type FakeResponse = ServerResponse & {
  statusCode?: number;
  headers?: Record<string, string>;
  body: string;
  writeHead(statusCode: number, headers: Record<string, string>): void;
  end(body: string): void;
};

function createFakeResponse(): FakeResponse {
  const response: {
    statusCode?: number;
    headers?: Record<string, string>;
    body: string;
    writeHead(statusCode: number, headers: Record<string, string>): void;
    end(body: string): void;
  } = {
    body: "",
    writeHead(statusCode: number, headers: Record<string, string>) {
      response.statusCode = statusCode;
      response.headers = headers;
    },
    end(body: string) {
      response.body = body;
    },
  };
  return response as unknown as FakeResponse;
}
