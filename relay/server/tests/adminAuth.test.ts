import { strict as assert } from "node:assert";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RelayAdminAuth } from "../src/adminAuth.ts";

const tokenDir = mkdtempSync(join(tmpdir(), "omniwork-relay-admin-"));

try {
  const auth = new RelayAdminAuth({
    tokenDir,
    tokenRotateMs: 3_600_000,
    sessionTtlMs: 1_800_000,
    requireHttps: true,
    trustProxy: true,
    trustedProxyIps: new Set(["127.0.0.1"]),
  });

  const startupToken = auth.start();
  const firstToken = readToken(tokenDir);
  assert.equal(startupToken.token, firstToken);
  assert.equal(startupToken.expiresAt > Date.now(), true);
  assert.equal(firstToken.length, 64);

  const session = auth.login(firstToken, 1000);
  assert.ok(session);
  assert.equal(session.expiresAt, 1_801_000);

  const secondToken = readToken(tokenDir);
  assert.equal(secondToken.length, 64);
  assert.notEqual(secondToken, firstToken);
  assert.equal(auth.login(firstToken, 1001), null);

  const cookie = auth.sessionCookie(session);
  assert.match(cookie, /Secure/);
  assert.equal(auth.authenticate(request({ cookie }), 1002)?.id, session.id);
  assert.equal(auth.authenticate(request({ cookie }), 1_801_001), null);

  assert.equal(auth.isHttps(request({ encrypted: true })), true);
  assert.equal(
    auth.isHttps(
      request({
        remoteAddress: "127.0.0.1",
        "x-forwarded-proto": "https",
      }),
    ),
    true,
  );
  assert.equal(
    auth.isHttps(
      request({
        remoteAddress: "198.51.100.10",
        "x-forwarded-proto": "https",
      }),
    ),
    false,
  );

  auth.stop();

  const insecureTokenDir = mkdtempSync(
    join(tmpdir(), "omniwork-relay-admin-insecure-"),
  );
  const insecureAuth = new RelayAdminAuth({
    tokenDir: insecureTokenDir,
    tokenRotateMs: 3_600_000,
    sessionTtlMs: 1_800_000,
    requireHttps: false,
    trustProxy: false,
    trustedProxyIps: new Set(),
  });
  try {
    insecureAuth.start();
    const insecureSession = insecureAuth.login(
      readToken(insecureTokenDir),
      2000,
    );
    assert.ok(insecureSession);
    assert.doesNotMatch(insecureAuth.sessionCookie(insecureSession), /Secure/);
    assert.doesNotMatch(insecureAuth.clearSessionCookie(), /Secure/);
  } finally {
    insecureAuth.stop();
    rmSync(insecureTokenDir, { recursive: true, force: true });
  }

  console.log("admin auth tests passed");
} finally {
  rmSync(tokenDir, { recursive: true, force: true });
}

function readToken(dir: string): string {
  const body = JSON.parse(
    readFileSync(join(dir, "admin-token.json"), "utf8"),
  ) as { token: string };
  return body.token;
}

function request(
  options: Record<string, string | boolean | undefined>,
): IncomingMessage {
  const headers: Record<string, string> = {};
  if (typeof options.cookie === "string") {
    headers.cookie = options.cookie;
  }
  if (typeof options["x-forwarded-proto"] === "string") {
    headers["x-forwarded-proto"] = options["x-forwarded-proto"];
  }
  return {
    headers,
    socket: {
      encrypted: options.encrypted === true,
      remoteAddress:
        typeof options.remoteAddress === "string"
          ? options.remoteAddress
          : undefined,
    },
  } as unknown as IncomingMessage;
}
