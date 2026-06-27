import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RelayServerConfig } from "./config.ts";
import type { MailSender } from "./mailSender.ts";
import {
  normalizeEmail,
  type RelayAuthUser,
  type RelayUserAuthStore,
} from "./relayUserAuthStore.ts";

export const USER_SESSION_COOKIE = "omniwork_user_session";
export const USER_CSRF_HEADER = "x-csrf-token";

type SessionCredential = {
  token: string;
  source: "authorization" | "cookie";
};

export class RelayUserAuthController {
  private readonly options: {
    config: RelayServerConfig;
    store: RelayUserAuthStore;
    mail: MailSender;
    resolveRemoteIp: (request: IncomingMessage) => string;
    revokeActiveDevice?: (deviceId: string) => void;
  };

  constructor(options: {
    config: RelayServerConfig;
    store: RelayUserAuthStore;
    mail: MailSender;
    resolveRemoteIp: (request: IncomingMessage) => string;
    revokeActiveDevice?: (deviceId: string) => void;
  }) {
    this.options = options;
  }

  matches(pathname: string): boolean {
    return pathname === "/auth" || pathname.startsWith("/auth/");
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (this.options.config.auth.mode === "none") {
      writeJson(response, 404, { error: "auth_disabled" });
      return;
    }
    if (request.method === "GET" && (url.pathname === "/auth" || url.pathname === "/auth/")) {
      writeHtml(response, 200, renderAuthPage());
      return;
    }
    if (request.method === "POST" && url.pathname === "/auth/email/start") {
      await this.startEmailLogin(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/auth/email/verify") {
      this.verifyEmailLink(response, url);
      return;
    }
    if (request.method === "GET" && url.pathname === "/auth/me") {
      this.me(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/auth/logout") {
      this.logout(request, response);
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/auth/devices/enrollments"
    ) {
      this.createDeviceEnrollment(request, response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/auth/devices") {
      await this.createDevice(request, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/auth/devices") {
      this.listDevices(request, response);
      return;
    }
    const revokeMatch = url.pathname.match(/^\/auth\/devices\/([^/]+)\/revoke$/);
    if (request.method === "POST" && revokeMatch?.[1]) {
      this.revokeDevice(request, response, revokeMatch[1]);
      return;
    }
    writeJson(response, 404, { error: "not_found" });
  }

  authenticateRequest(request: IncomingMessage): RelayAuthUser | null {
    return this.options.store.authenticateSession(readSessionToken(request));
  }

  authenticateToken(token: string | undefined): RelayAuthUser | null {
    return this.options.store.authenticateSession(token);
  }

  private async startEmailLogin(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBodyOrRespond(request, response);
    if (!body) {
      return;
    }
    const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
    if (!isValidEmail(email)) {
      writeJson(response, 400, { error: "invalid_email" });
      return;
    }
    const now = Date.now();
    const ip = this.options.resolveRemoteIp(request);
    const since = now - 3_600_000;
    if (
      this.options.store.countRecentEmailLinksByEmail(email, since) >=
        this.options.config.auth.emailRateLimitPerHour ||
      this.options.store.countRecentEmailLinksByIp(ip, since) >=
        this.options.config.auth.ipRateLimitPerHour
    ) {
      writeJson(response, 202, { ok: true });
      return;
    }

    const link = this.options.store.createEmailLink({
      email,
      requestIp: ip,
      ttlMs: this.options.config.auth.emailLinkTtlMs,
      now,
    });
    const loginUrl = new URL(
      `/auth/email/verify?token=${encodeURIComponent(link.token)}`,
      this.options.config.auth.publicBaseUrl,
    ).toString();
    await this.options.mail.sendMagicLink({
      to: email,
      loginUrl,
      expiresMinutes: Math.ceil(
        this.options.config.auth.emailLinkTtlMs / 60_000,
      ),
    });
    writeJson(response, 202, { ok: true });
  }

  private verifyEmailLink(response: ServerResponse, url: URL): void {
    const token = url.searchParams.get("token") ?? "";
    const user = this.options.store.consumeEmailLink(token);
    if (!user) {
      writeHtml(
        response,
        400,
        renderAuthMessagePage("Invalid or expired link", "/auth/"),
      );
      return;
    }
    const session = this.options.store.createSession({
      userId: user.id,
      ttlMs: this.options.config.auth.sessionTtlMs,
    });
    const body = {
      ok: true,
      session_token: session.token,
      expires_at: new Date(session.expires_at).toISOString(),
      user: publicUser(user),
    };
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": sessionCookie(session.token, session.expires_at),
    });
    response.end(renderVerifiedPage(body.session_token));
  }

  private me(request: IncomingMessage, response: ServerResponse): void {
    const credential = readSessionCredential(request);
    if (!credential) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    const user = this.options.store.authenticateSession(credential.token);
    if (!user) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    writeJson(response, 200, {
      user: publicUser(user),
      csrf_token: createCsrfToken(credential.token),
    });
  }

  private logout(request: IncomingMessage, response: ServerResponse): void {
    if (!this.verifyCsrfForCookieSession(request, response)) {
      return;
    }
    this.options.store.revokeSession(readSessionToken(request));
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": clearSessionCookie(),
    });
    response.end(JSON.stringify({ ok: true }));
  }

  private createDeviceEnrollment(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const user = this.authenticateRequest(request);
    if (!user) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (!this.verifyCsrfForCookieSession(request, response)) {
      return;
    }
    const enrollment = this.options.store.createDeviceEnrollment({
      userId: user.id,
      ttlMs: this.options.config.auth.deviceEnrollmentTtlMs,
    });
    writeJson(response, 200, {
      enrollment_token: enrollment.token,
      expires_at: new Date(enrollment.expiresAt).toISOString(),
    });
  }

  private async createDevice(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readJsonBodyOrRespond(request, response);
    if (!body) {
      return;
    }
    const enrollmentToken =
      typeof body.enrollment_token === "string" ? body.enrollment_token : "";
    const publicKey = typeof body.public_key === "string" ? body.public_key : "";
    const deviceName =
      typeof body.device_name === "string" && body.device_name.trim()
        ? body.device_name.trim()
        : undefined;
    if (!enrollmentToken || !publicKey.includes("PUBLIC KEY")) {
      writeJson(response, 400, { error: "invalid_device_enrollment" });
      return;
    }
    const device = this.options.store.consumeDeviceEnrollment({
      token: enrollmentToken,
      name: deviceName,
      publicKey,
      maxDevicesPerUser: this.options.config.auth.maxDevicesPerUser,
    });
    if (!device) {
      writeJson(response, 400, { error: "invalid_or_expired_enrollment" });
      return;
    }
    writeJson(response, 200, {
      device_id: device.id,
      user_id: device.user_id,
      device_name: device.name,
    });
  }

  private listDevices(request: IncomingMessage, response: ServerResponse): void {
    const user = this.authenticateRequest(request);
    if (!user) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    writeJson(response, 200, {
      devices: this.options.store.listDevices(user.id).map((device) => ({
        device_id: device.id,
        name: device.name,
        created_at: new Date(device.created_at).toISOString(),
        last_seen_at: device.last_seen_at
          ? new Date(device.last_seen_at).toISOString()
          : undefined,
        revoked_at: device.revoked_at
          ? new Date(device.revoked_at).toISOString()
          : undefined,
      })),
    });
  }

  private revokeDevice(
    request: IncomingMessage,
    response: ServerResponse,
    deviceId: string,
  ): void {
    const user = this.authenticateRequest(request);
    if (!user) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (!this.verifyCsrfForCookieSession(request, response)) {
      return;
    }
    const revoked = this.options.store.revokeDevice(deviceId, user.id);
    if (revoked) {
      this.options.revokeActiveDevice?.(deviceId);
    }
    writeJson(
      response,
      revoked ? 200 : 404,
      revoked ? { ok: true } : { error: "not_found" },
    );
  }

  private verifyCsrfForCookieSession(
    request: IncomingMessage,
    response: ServerResponse,
  ): boolean {
    const credential = readSessionCredential(request);
    if (!credential || credential.source !== "cookie") {
      return true;
    }
    const header = request.headers[USER_CSRF_HEADER];
    const csrfToken = Array.isArray(header) ? header[0] : header;
    if (!csrfToken || !verifyCsrfToken(credential.token, csrfToken)) {
      writeJson(response, 403, { error: "invalid_csrf" });
      return false;
    }
    return true;
  }
}

export async function readJsonBody(
  request: IncomingMessage,
  limitBytes = 32 * 1024,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > limitBytes) {
      throw new JsonBodyError("payload_too_large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new JsonBodyError("invalid_json");
  }
  return isRecord(parsed) ? parsed : {};
}

class JsonBodyError extends Error {
  readonly code: "invalid_json" | "payload_too_large";

  constructor(code: "invalid_json" | "payload_too_large") {
    super(code);
    this.code = code;
  }
}

async function readJsonBodyOrRespond(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<Record<string, unknown> | null> {
  try {
    return await readJsonBody(request);
  } catch (error) {
    if (error instanceof JsonBodyError) {
      writeJson(response, error.code === "payload_too_large" ? 413 : 400, {
        error: error.code,
      });
      return null;
    }
    throw error;
  }
}

function readSessionToken(request: IncomingMessage): string | undefined {
  return readSessionCredential(request)?.token;
}

function readSessionCredential(
  request: IncomingMessage,
): SessionCredential | undefined {
  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    return { token: auth.slice("Bearer ".length).trim(), source: "authorization" };
  }
  const cookie = request.headers.cookie;
  if (!cookie) {
    return undefined;
  }
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === USER_SESSION_COOKIE) {
      return { token: decodeURIComponent(rest.join("=")), source: "cookie" };
    }
  }
  return undefined;
}

export function createCsrfToken(sessionToken: string): string {
  return createHmac("sha256", sessionToken)
    .update("omniwork-relay-user-auth-csrf-v1")
    .digest("base64url");
}

export function verifyCsrfToken(
  sessionToken: string,
  csrfToken: string,
): boolean {
  const expected = Buffer.from(createCsrfToken(sessionToken));
  const actual = Buffer.from(csrfToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sessionCookie(token: string, expiresAt: number): string {
  return `${USER_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Expires=${new Date(
    expiresAt,
  ).toUTCString()}; HttpOnly; SameSite=Strict`;
}

function clearSessionCookie(): string {
  return `${USER_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`;
}

function publicUser(user: RelayAuthUser) {
  return {
    id: user.id,
    email: user.email,
  };
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function writeHtml(
  response: ServerResponse,
  statusCode: number,
  body: string,
): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
  });
  response.end(body);
}

function renderAuthPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OmniWork Relay</title>
  <style>
    body { background:#0f1720; color:#e6edf3; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; margin:0; }
    main { max-width:720px; margin:48px auto; padding:0 20px; }
    section { background:#151f2a; border:1px solid #263445; border-radius:16px; margin:16px 0; padding:20px; }
    input,button { border-radius:10px; border:1px solid #34465b; box-sizing:border-box; font:inherit; padding:10px 12px; }
    input { background:#0f1720; color:#e6edf3; width:100%; }
    button { background:#30c48d; border:0; color:#052014; cursor:pointer; font-weight:700; margin-top:10px; }
    button.danger { background:#ef6b73; color:#28070a; }
    code,pre { background:#0b1118; border-radius:10px; color:#bfead8; padding:10px; }
    pre { overflow:auto; white-space:pre-wrap; }
    .muted { color:#93a4b7; }
    .device { border-top:1px solid #263445; padding:12px 0; }
    .device:first-child { border-top:0; }
  </style>
</head>
<body>
  <main>
    <h1>OmniWork Relay</h1>
    <p class="muted">Sign in by email, then create a short-lived device token for Desktop Agent enrollment.</p>
    <section id="login">
      <h2>Email sign in</h2>
      <input id="email" type="email" placeholder="you@example.com" autocomplete="email" />
      <button id="send">Send sign-in link</button>
      <p id="loginStatus" class="muted"></p>
    </section>
    <section id="account" hidden>
      <h2>Account</h2>
      <p id="user"></p>
      <button id="createEnrollment">Create device token</button>
      <p class="muted">Run this command on your desktop within 5 minutes:</p>
      <pre id="command"></pre>
      <h3>Devices</h3>
      <div id="devices"></div>
      <button id="logout">Log out</button>
    </section>
  </main>
  <script>
    const login = document.getElementById("login");
    const account = document.getElementById("account");
    const status = document.getElementById("loginStatus");
    const command = document.getElementById("command");
    const devices = document.getElementById("devices");
    const relayUrl = location.origin.replace(/^http/, "ws") + "/relay/ws/agent";
    let csrfToken = "";

    async function refresh() {
      const res = await fetch("/auth/me");
      if (!res.ok) {
        login.hidden = false;
        account.hidden = true;
        return;
      }
      const data = await res.json();
      csrfToken = data.csrf_token;
      document.getElementById("user").textContent = data.user.email;
      login.hidden = true;
      account.hidden = false;
      await refreshDevices();
    }

    async function refreshDevices() {
      const res = await fetch("/auth/devices");
      if (!res.ok) {
        devices.textContent = "Could not load devices.";
        return;
      }
      const data = await res.json();
      if (!data.devices || data.devices.length === 0) {
        devices.innerHTML = '<p class="muted">No devices enrolled yet.</p>';
        return;
      }
      devices.replaceChildren(...data.devices.map(renderDevice));
    }

    function renderDevice(device) {
      const node = document.createElement("div");
      node.className = "device";
      const title = document.createElement("strong");
      title.textContent = device.name || device.device_id;
      const detail = document.createElement("p");
      detail.className = "muted";
      detail.textContent = [
        device.device_id,
        device.revoked_at ? "revoked " + device.revoked_at : "active",
        device.last_seen_at ? "last seen " + device.last_seen_at : "",
      ].filter(Boolean).join(" | ");
      node.append(title, detail);
      if (!device.revoked_at) {
        const button = document.createElement("button");
        button.className = "danger";
        button.textContent = "Revoke";
        button.onclick = async () => {
          if (!confirm("Revoke this device? Online connections will be closed.")) {
            return;
          }
          await authPost("/auth/devices/" + encodeURIComponent(device.device_id) + "/revoke");
          await refreshDevices();
        };
        node.append(button);
      }
      return node;
    }

    async function authPost(url) {
      return fetch(url, {
        method: "POST",
        headers: { "x-csrf-token": csrfToken },
      });
    }

    document.getElementById("send").onclick = async () => {
      const email = document.getElementById("email").value.trim();
      const res = await fetch("/auth/email/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      status.textContent = res.ok ? "Check your inbox for the sign-in link." : "Invalid email.";
    };

    document.getElementById("createEnrollment").onclick = async () => {
      const res = await authPost("/auth/devices/enrollments");
      if (!res.ok) {
        command.textContent = "Please sign in again.";
        return;
      }
      const data = await res.json();
      command.textContent = "omniwork-agent enroll --relay-url " + relayUrl + " --token " + data.enrollment_token;
      await refreshDevices();
    };

    document.getElementById("logout").onclick = async () => {
      await authPost("/auth/logout");
      await refresh();
    };

    refresh();
  </script>
</body>
</html>`;
}

function renderVerifiedPage(sessionToken: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Signed in</title></head>
<body>
  <script>localStorage.setItem("omniwork_user_session", ${JSON.stringify(sessionToken)}); location.replace("/auth/");</script>
  <p>Signed in. Continue to <a href="/auth/">OmniWork Relay</a>.</p>
</body>
</html>`;
}

function renderAuthMessagePage(title: string, href: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(
    title,
  )}</title></head><body><h1>${escapeHtml(
    title,
  )}</h1><p><a href="${href}">Back to OmniWork Relay</a></p></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
