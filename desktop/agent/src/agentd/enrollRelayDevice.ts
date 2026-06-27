import { generateKeyPairSync } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import {
  defaultRelayDeviceCredentialsPath,
  writeRelayDeviceCredentials,
} from "../config/relayDeviceCredentials.ts";

interface EnrollOptions {
  relayUrl: string;
  token: string;
  deviceName: string;
  credentialsPath: string;
}

export async function enrollRelayDevice(
  options: EnrollOptions,
): Promise<{ deviceId: string; credentialsPath: string }> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const response = await fetch(new URL("/auth/devices", authBaseUrl(options.relayUrl)), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      enrollment_token: options.token,
      device_name: options.deviceName,
      public_key: publicKeyPem,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    device_id?: string;
    error?: string;
  };
  if (!response.ok || !body.device_id) {
    throw new Error(body.error ?? `device enrollment failed: ${response.status}`);
  }

  writeRelayDeviceCredentials(options.credentialsPath, {
    version: 1,
    relayUrl: options.relayUrl,
    deviceId: body.device_id,
    privateKeyPem,
    createdAt: new Date().toISOString(),
  });
  return { deviceId: body.device_id, credentialsPath: options.credentialsPath };
}

export async function runEnrollRelayDeviceCli(
  argv = process.argv.slice(2),
): Promise<void> {
  const options = parseArgs(argv);
  const result = await enrollRelayDevice(options);
  console.log("[omniwork-agent] device enrolled");
  console.log(`device_id=${result.deviceId}`);
  console.log(`credentials=${result.credentialsPath}`);
}

function parseArgs(argv: string[]): EnrollOptions {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    args.set(arg.slice(2), next);
    index += 1;
  }
  const appSupportDir =
    process.env.OMNIWORK_APP_SUPPORT_DIR ??
    join(homedir(), "Library", "Application Support", "OmniWork", "agent");
  const relayUrl = args.get("relay-url") ?? process.env.OMNIWORK_RELAY_URL;
  const token = args.get("token") ?? process.env.OMNIWORK_AGENT_ENROLLMENT_TOKEN;
  if (!relayUrl) {
    throw new Error("--relay-url is required");
  }
  if (!token) {
    throw new Error("--token is required");
  }
  return {
    relayUrl,
    token,
    deviceName: args.get("device-name") ?? hostname(),
    credentialsPath:
      args.get("credentials-path") ??
      process.env.OMNIWORK_AGENT_RELAY_DEVICE_CREDENTIALS_PATH ??
      defaultRelayDeviceCredentialsPath(appSupportDir),
  };
}

function authBaseUrl(relayUrl: string): string {
  const parsed = new URL(relayUrl);
  if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  }
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runEnrollRelayDeviceCli().catch((error: unknown) => {
    console.error("[omniwork-agent] enrollment failed", error);
    process.exitCode = 1;
  });
}
