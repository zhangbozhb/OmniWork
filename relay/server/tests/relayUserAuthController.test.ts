import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { runInNewContext } from "node:vm";

import {
  createMessage,
  E2E_SUPPORT_V2,
  generateIdentityKeyPair,
  PROTOCOL_SUPPORT_V2,
  PROTOCOL_VERSION,
} from "@omni-work/protocol-ts";

import { MobileEmailLinkPolicy } from "../src/auth/policies/mobileEmailLinkPolicy.ts";
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
    const config = loadRelayServerConfig(
      {
        OMNIWORK_RELAY_HOST: "127.0.0.1",
        OMNIWORK_RELAY_AUTH_MODE: "email_link",
        OMNIWORK_PUBLIC_BASE_URL: "http://127.0.0.1:8787",
        OMNIWORK_MAIL_FROM: "OmniWork <test@example.com>",
      },
      {
        cwd: dir,
        programDir: dir,
        packageRoot: dir,
        globalConfigPath: join(dir, "global.yml"),
      },
    );
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

    const unauthorizedHeaders: Record<string, string>[] = [
      {},
      { authorization: "Bearer invalid-session" },
    ];
    for (const headers of unauthorizedHeaders) {
      const unauthorized = createFakeResponse();
      await controller.handle(
        createFakeRequest("POST", "/auth/sessions", headers),
        unauthorized,
        new URL("http://relay.local/auth/sessions"),
      );
      assert.equal(unauthorized.statusCode, 401);
      assert.deepEqual(JSON.parse(unauthorized.body), { error: "unauthorized" });
    }
    const invalidCsrfHeaders: Record<string, string>[] = [
      { cookie },
      { cookie, "x-csrf-token": "invalid-csrf" },
    ];
    for (const headers of invalidCsrfHeaders) {
      const rejected = createFakeResponse();
      await controller.handle(
        createFakeRequest("POST", "/auth/sessions", headers),
        rejected,
        new URL("http://relay.local/auth/sessions"),
      );
      assert.equal(rejected.statusCode, 403);
      assert.deepEqual(JSON.parse(rejected.body), { error: "invalid_csrf" });
    }

    const appSession = createFakeResponse();
    const beforeSession = Date.now();
    await controller.handle(
      createFakeRequest("POST", "/auth/sessions", {
        cookie,
        "x-csrf-token": csrfToken,
      }),
      appSession,
      new URL("http://relay.local/auth/sessions"),
    );
    assert.equal(appSession.statusCode, 200);
    assert.equal(appSession.headers?.["cache-control"], "no-store");
    assert.equal(appSession.headers?.["set-cookie"], undefined);
    const appToken = JSON.parse(appSession.body).session_token as string;
    const expiresAt = Date.parse(JSON.parse(appSession.body).expires_at);
    assert.ok(appToken);
    assert.notEqual(appToken, session.token);
    assert.equal(controller.authenticateToken(appToken)?.id, user.id);
    assert.ok(expiresAt >= beforeSession + config.auth.sessionTtlMs);
    assert.ok(expiresAt <= Date.now() + config.auth.sessionTtlMs);
    assert.equal(store.authenticateSession(appToken, expiresAt), null);

    const bearerSession = createFakeResponse();
    await controller.handle(
      createFakeRequest("POST", "/auth/sessions", {
        authorization: `Bearer ${appToken}`,
      }),
      bearerSession,
      new URL("http://relay.local/auth/sessions"),
    );
    assert.equal(bearerSession.statusCode, 200);
    const secondAppToken = JSON.parse(bearerSession.body).session_token as string;
    assert.notEqual(secondAppToken, appToken);
    assert.equal(controller.authenticateToken(secondAppToken)?.id, user.id);

    const verifyLink = store.createEmailLink({
      email: user.email,
      ttlMs: 60_000,
    });
    const verified = createFakeResponse();
    const verifyUrl = new URL(
      `http://relay.local/auth/email/verify?token=${verifyLink.token}`,
    );
    await controller.handle(
      createFakeRequest("GET", verifyUrl.pathname),
      verified,
      verifyUrl,
    );
    assert.equal(verified.statusCode, 200);
    assert.equal(verified.headers?.["cache-control"], "no-store");
    const verifiedCookie = verified.headers?.["set-cookie"];
    assert.ok(verifiedCookie);
    assert.match(verifiedCookie, /HttpOnly; SameSite=Strict/);
    const verifiedToken = decodeURIComponent(verifiedCookie.split(";")[0]!.split("=")[1]!);
    assert.equal(controller.authenticateToken(verifiedToken)?.id, user.id);
    assert.equal(verified.body.includes(verifiedToken), false);
    assert.equal(verified.body.includes("localStorage.setItem"), false);

    const accountPage = createFakeResponse();
    await controller.handle(
      createFakeRequest("GET", "/auth/"),
      accountPage,
      new URL("http://relay.local/auth/"),
    );
    assert.equal(accountPage.headers?.["cache-control"], "no-store");
    assert.match(accountPage.body, /Create App sign-in token/);
    assert.match(accountPage.body, /localStorage.removeItem\("omniwork_user_session"\)/);
    assert.equal(me.headers?.["cache-control"], "no-store");
    await verifyAccountPageScript(accountPage.body);

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

    const identity = generateIdentityKeyPair("agent");
    const mismatchedIdentity = generateIdentityKeyPair("agent");
    const mismatchedDevice = createFakeResponse();
    await controller.handle(
      createFakeRequest(
        "POST",
        "/auth/devices",
        { "content-type": "application/json" },
        JSON.stringify({
          enrollment_token: enrollmentToken,
          device_id: mismatchedIdentity.id,
          public_key: identity.publicKey,
          device_name: "MacBook",
        }),
      ),
      mismatchedDevice,
      new URL("http://relay.local/auth/devices"),
    );
    assert.equal(mismatchedDevice.statusCode, 400);
    assert.deepEqual(JSON.parse(mismatchedDevice.body), {
      error: "invalid_device_enrollment",
    });

    const createDevice = createFakeResponse();
    await controller.handle(
      createFakeRequest(
        "POST",
        "/auth/devices",
        { "content-type": "application/json" },
        JSON.stringify({
          enrollment_token: enrollmentToken,
          device_id: ` ${identity.id.toLowerCase().replaceAll("-", "")} `,
          public_key: identity.publicKey,
          device_name: "MacBook",
        }),
      ),
      createDevice,
      new URL("http://relay.local/auth/devices"),
    );
    assert.equal(createDevice.statusCode, 200);
    const deviceId = JSON.parse(createDevice.body).device_id as string;
    assert.equal(deviceId, identity.id);
    assert.equal(store.getDevice(deviceId)?.id, identity.id);

    const policy = new MobileEmailLinkPolicy({
      config,
      authenticateUserToken: (token) => controller.authenticateToken(token),
      getDevice: (id) => store.getDevice(id),
    });
    const appIdentity = generateIdentityKeyPair("app");
    const mobileConnect = createMessage("mobile.connect", {
      v: PROTOCOL_VERSION,
      device_id: deviceId,
      app_id: appIdentity.id,
      app_public_key: appIdentity.publicKey,
      app_info: { instance_id: "app-instance", runtime_id: "app-runtime" },
      protocol: PROTOCOL_SUPPORT_V2,
      e2e: E2E_SUPPORT_V2,
      session_token: appToken,
    });
    assert.deepEqual(
      policy.authorize({ surface: "mobile_connect", message: mobileConnect }),
      { ok: true, subject: { userId: user.id, deviceId } },
    );
    const cookieConnect = createMessage("mobile.connect", {
      ...mobileConnect.payload,
      session_token: undefined,
    });
    assert.deepEqual(
      policy.authorize({
        surface: "mobile_connect",
        message: cookieConnect,
        connectionUserId: controller.authenticateRequest(
          createFakeRequest("GET", "/relay/ws/mobile", { cookie }),
        )?.id,
      }),
      { ok: true, subject: { userId: user.id, deviceId } },
    );

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

    const logout = createFakeResponse();
    await controller.handle(
      createFakeRequest("POST", "/auth/logout", {
        cookie,
        "x-csrf-token": csrfToken,
      }),
      logout,
      new URL("http://relay.local/auth/logout"),
    );
    assert.equal(logout.statusCode, 200);
    assert.equal(controller.authenticateToken(session.token), null);
    assert.equal(controller.authenticateToken(appToken)?.id, user.id);
    store.revokeSession(appToken);
    assert.equal(
      policy.authorize({ surface: "mobile_connect", message: mobileConnect })?.ok,
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("relay user auth controller tests passed");

async function verifyAccountPageScript(html: string): Promise<void> {
  const elements = new Map<string, {
    value: string;
    type: string;
    hidden: boolean;
    disabled: boolean;
    selected: boolean;
    textContent: string;
    onclick(): Promise<void> | void;
    replaceChildren(): void;
    focus(): void;
    select(): void;
  }>();
  function element(id: string) {
    if (!elements.has(id)) {
      elements.set(id, {
        value: "", type: "password", hidden: true, disabled: false,
        selected: false, textContent: "", onclick() {}, replaceChildren() {},
        focus() {}, select() { this.selected = true; },
      });
    }
    return elements.get(id)!;
  }
  let signedIn = true;
  let sessionResult = "success";
  let logoutOk = true;
  const removedKeys: string[] = [];
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  runInNewContext(script, {
    document: { getElementById: element },
    location: { origin: "https://relay.example" },
    localStorage: { removeItem: (key: string) => removedKeys.push(key) },
    navigator: {},
    async fetch(url: string, options?: { headers: Record<string, string> }) {
      if (url === "/auth/me") {
        return { ok: signedIn, json: async () => ({
          csrf_token: "csrf", user: { email: "user@example.com" },
        }) };
      }
      if (url === "/auth/devices") {
        return { ok: true, json: async () => ({ devices: [] }) };
      }
      assert.equal(options?.headers["x-csrf-token"], "csrf");
      if (url === "/auth/sessions") {
        if (sessionResult === "network-error") throw new Error("offline");
        return { ok: sessionResult === "success", json: async () => ({
          session_token: "private-app-session", expires_at: "2030-01-01T00:00:00Z",
        }) };
      }
      assert.equal(url, "/auth/logout");
      if (logoutOk) signedIn = false;
      return { ok: logoutOk };
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(removedKeys, ["omniwork_user_session"]);
  assert.equal(element("account").hidden, false);
  await element("createAppSession").onclick();
  assert.equal(element("appToken").value, "private-app-session");
  assert.equal(element("appToken").type, "password");
  assert.equal(element("appSession").hidden, false);
  assert.equal(element("createAppSession").disabled, false);
  await element("showAppToken").onclick();
  assert.equal(element("appToken").type, "text");
  await element("copyAppToken").onclick();
  assert.equal(element("appToken").selected, true);
  assert.match(element("appTokenStatus").textContent, /copy the token manually/);
  for (sessionResult of ["http-error", "network-error"]) {
    await element("createAppSession").onclick();
    assert.equal(element("appToken").value, "");
    assert.equal(element("appSession").hidden, true);
    assert.equal(element("createAppSession").disabled, false);
    assert.match(element("appTokenStatus").textContent, /Could not create token/);
  }
  sessionResult = "success";
  await element("createAppSession").onclick();
  logoutOk = false;
  await element("logout").onclick();
  assert.equal(element("appToken").value, "");
  assert.match(element("appTokenStatus").textContent, /Could not log out/);
  logoutOk = true;
  await element("logout").onclick();
  assert.equal(element("appToken").value, "");
  assert.equal(element("appTokenExpiry").textContent, "");
  assert.equal(element("account").hidden, true);
  assert.equal(element("command").textContent, "");
}

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
