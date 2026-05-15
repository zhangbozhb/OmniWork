import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";

import {
  PROTOCOL_VERSION,
  createPairingLink,
  type PairingLinkPayload,
} from "../../../../packages/protocol-ts/src/index.ts";
import type { AgentConfig } from "../config/config.ts";
import type { SessionKeyRecord } from "../auth-key/authKey.ts";

interface QrCodeTerminal {
  generate(
    input: string,
    options: { small: boolean },
    callback: (qr: string) => void,
  ): void;
}

export interface PairingQrDetails {
  link: string;
  payload: PairingLinkPayload;
}

export function createPairingQrDetails(
  config: AgentConfig,
  keyRecord: SessionKeyRecord,
): PairingQrDetails | null {
  const relayUrl = createPairingRelayUrl(config);
  if (!relayUrl) {
    return null;
  }

  const endpoint = getRelayEndpoint(relayUrl);
  const payload: PairingLinkPayload = {
    v: PROTOCOL_VERSION,
    relay_url: relayUrl,
    device_id: config.deviceId,
    key: keyRecord.key,
    key_id: keyRecord.key_id,
    transport: config.pairingTransport,
    host: endpoint?.host,
    port: endpoint?.port,
  };

  return {
    link: createPairingLink(payload),
    payload,
  };
}

export function printPairingQr(details: PairingQrDetails): void {
  printPairingSummary(details);

  const qrcode = loadQrCodeTerminal();
  if (!qrcode) {
    console.info(
      "[omniwork-agent] QR code unavailable; run `pnpm install` to install qrcode-terminal.",
    );
    console.info(`[omniwork-agent] pairing_link=${details.link}`);
    return;
  }

  console.info("[omniwork-agent] scan this QR code with the OmniWork app:");
  qrcode.generate(details.link, { small: false }, (qr) => {
    console.info(qr);
  });
  console.info(`[omniwork-agent] pairing_link=${details.link}`);
}

export function printPairingDetailsWithoutRelay(
  config: AgentConfig,
  keyRecord: SessionKeyRecord,
): void {
  console.info("[omniwork-agent] pairing details");
  console.info(`  key: ${keyRecord.key}`);
  console.info(`  key_id: ${keyRecord.key_id}`);
  console.info(`  device_id: ${config.deviceId}`);
  console.info("  host: -");
  console.info("  port: -");
  console.info("  relay_url: -");
  console.info(
    "[omniwork-agent] set OMNIWORK_RELAY_URL or OMNIWORK_PAIRING_RELAY_URL to generate a scannable pairing QR code.",
  );
}

function printPairingSummary(details: PairingQrDetails): void {
  const { payload } = details;
  console.info("[omniwork-agent] pairing details");
  console.info(`  key: ${payload.key}`);
  console.info(`  key_id: ${payload.key_id ?? "-"}`);
  console.info(`  device_id: ${payload.device_id}`);
  console.info(`  host: ${payload.host ?? "-"}`);
  console.info(`  port: ${payload.port ?? "-"}`);
  console.info(`  transport: ${payload.transport ?? "websocket"}`);
  console.info(`  relay_url: ${payload.relay_url}`);
}

function loadQrCodeTerminal(): QrCodeTerminal | null {
  try {
    const require = createRequire(import.meta.url);
    return require("qrcode-terminal") as QrCodeTerminal;
  } catch {
    return null;
  }
}

function createPairingRelayUrl(config: AgentConfig): string | null {
  const explicitPairingUrl = config.pairingRelayUrl?.trim();
  if (explicitPairingUrl) {
    return createMobileReachableRelayUrl(explicitPairingUrl);
  }

  const derivedRelayUrl = createMobileRelayUrl(config.relayUrl);
  if (!derivedRelayUrl) {
    return null;
  }

  return createMobileReachableRelayUrl(derivedRelayUrl);
}

function createMobileRelayUrl(relayUrl?: string): string | null {
  const trimmed = relayUrl?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    url.pathname = toMobilePathname(url.pathname);
    return url.toString();
  } catch {
    return trimmed.replace(/\/agent\/?$/, "/mobile");
  }
}

function createMobileReachableRelayUrl(relayUrl: string): string {
  try {
    const url = new URL(relayUrl);
    if (shouldReplaceWithLocalIp(url.hostname)) {
      const localIp = getPreferredLocalIpv4Address();
      if (localIp) {
        url.hostname = localIp;
      }
    }
    return url.toString();
  } catch {
    return relayUrl;
  }
}

function getRelayEndpoint(
  relayUrl: string,
): { host: string; port: string } | null {
  try {
    const url = new URL(relayUrl);
    return {
      host: url.hostname,
      port: url.port || defaultPort(url.protocol) || "",
    };
  } catch {
    return null;
  }
}

function getPreferredLocalIpv4Address(): string | null {
  const candidates: string[] = [];
  const interfaces = networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        candidates.push(address.address);
      }
    }
  }

  return (
    candidates.find((address) => !address.startsWith("192.")) ??
    candidates[0] ??
    null
  );
}

function shouldReplaceWithLocalIp(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "::" ||
    host === "[::]"
  );
}

function toMobilePathname(pathname: string): string {
  const normalized =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  if (!normalized || normalized === "/") {
    return "/mobile";
  }
  if (normalized.endsWith("/agent")) {
    return `${normalized.slice(0, -"/agent".length)}/mobile`;
  }
  return normalized;
}

function defaultPort(protocol: string): string | null {
  if (protocol === "wss:" || protocol === "https:") {
    return "443";
  }
  if (protocol === "ws:" || protocol === "http:") {
    return "80";
  }

  return null;
}
