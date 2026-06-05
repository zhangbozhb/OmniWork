import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";

import {
  PROTOCOL_VERSION,
  createPairingLink,
  type PairingLinkPayload,
} from "@omniwork/protocol-ts";
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
  /**
   * 仅用于本地终端日志展示，便于运维确认 relay_url 中的本机 IP 替换是否生效。
   * pairing link payload 自身已不再携带 host/port 字段。
   */
  endpoint: { host: string; port: string } | null;
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
  };

  return {
    link: createPairingLink(payload),
    payload,
    endpoint,
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
  qrcode.generate(details.link, { small: true }, (qr) => {
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
    "[omniwork-agent] set OMNIWORK_RELAY_URL to generate a scannable pairing QR code.",
  );
}

function printPairingSummary(details: PairingQrDetails): void {
  const { payload, endpoint } = details;
  console.info("[omniwork-agent] pairing details");
  console.info(`  key: ${payload.key}`);
  console.info(`  key_id: ${payload.key_id ?? "-"}`);
  console.info(`  device_id: ${payload.device_id}`);
  console.info(`  host: ${endpoint?.host ?? "-"}`);
  console.info(`  port: ${endpoint?.port ?? "-"}`);
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
    return "/relay/ws/mobile";
  }
  if (normalized.endsWith("/agent")) {
    return `${normalized.slice(0, -"/agent".length)}/mobile`;
  }
  if (normalized.endsWith("/mobile")) {
    return normalized;
  }
  // 其它自定义后缀（例如 /custom）一律改写为兄弟路径 mobile，
  // 与 Relay `/relay/ws/agent` <-> `/relay/ws/mobile` 双 pool 约定保持一致，避免手机端
  // 落入仅供 Agent 使用的 path。
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) {
    return "/relay/ws/mobile";
  }
  return `${normalized.slice(0, lastSlash)}/mobile`;
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
