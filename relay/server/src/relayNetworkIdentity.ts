import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";

import geoip from "geoip-lite";
import type { AppConnectionObservation } from "@omniwork/protocol-ts";

import type { RelayConnectionLocation, RelayEndpoint } from "./relayTypes.ts";

type RelayIpSource = NonNullable<
  NonNullable<AppConnectionObservation["network"]>["ip_source"]
>;

export interface ResolvedRemoteIp {
  ip: string;
  source: Extract<RelayIpSource, "x_forwarded_for" | "socket_remote_address">;
}

/**
 * 只有在请求来自可信反代时才使用 X-Forwarded-For；否则使用底层
 * socket.remoteAddress，避免客户端直连时伪造来源 IP。
 */
export function resolveRemoteIp(
  request: IncomingMessage,
  socket: Socket,
  options: {
    trustProxy: boolean;
    trustedProxyIps: Set<string>;
  },
): ResolvedRemoteIp {
  const socketIp = normalizeIpLiteral(socket.remoteAddress ?? "unknown");
  if (
    options.trustProxy &&
    isTrustedProxyIp(socketIp, options.trustedProxyIps)
  ) {
    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.length > 0) {
      const first = forwarded.split(",")[0]?.trim();
      if (first) {
        return { ip: normalizeIpLiteral(first), source: "x_forwarded_for" };
      }
    }
    if (Array.isArray(forwarded) && forwarded.length > 0) {
      const first = forwarded[0]?.split(",")[0]?.trim();
      if (first) {
        return { ip: normalizeIpLiteral(first), source: "x_forwarded_for" };
      }
    }
  }
  return {
    ip: socketIp,
    source: "socket_remote_address",
  };
}

export function resolveConnectionLocation(
  remoteIp: string,
): RelayConnectionLocation | undefined {
  const geo = geoip.lookup(normalizeIpForGeoLookup(remoteIp));
  if (!geo || !Array.isArray(geo.ll) || geo.ll.length !== 2) {
    return undefined;
  }
  const [latitude, longitude] = geo.ll;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return undefined;
  }
  const countryCode = geo.country || undefined;
  const country = countryCode ? countryName(countryCode) : undefined;
  const city = geo.city || undefined;
  const region = geo.region || undefined;
  const accuracy = city ? "city" : region ? "region" : "country";
  const label = [city, region && !city ? region : undefined, country]
    .filter(Boolean)
    .join(", ");
  return {
    location_id: [
      accuracy,
      slugLocationPart(countryCode ?? "unknown"),
      slugLocationPart(region ?? "unknown"),
      slugLocationPart(city ?? "unknown"),
    ].join(":"),
    label: label || countryCode || "Unknown Internet",
    latitude,
    longitude,
    source: "geoip",
    accuracy,
    country_code: countryCode,
    country,
    region,
    city,
  };
}

export function createRelayObservation(
  request: IncomingMessage,
  remoteIp: ResolvedRemoteIp,
): AppConnectionObservation {
  const userAgent = request.headers["user-agent"];
  const normalizedUserAgent =
    typeof userAgent === "string" ? userAgent.trim() || undefined : undefined;
  return {
    source: "relay",
    observed_at: new Date().toISOString(),
    network: {
      remote_ip: remoteIp.ip,
      ip_source: remoteIp.source,
    },
    ...(normalizedUserAgent
      ? { http: { user_agent: normalizedUserAgent } }
      : {}),
  };
}

export function parseRelayEndpoint(
  request: IncomingMessage,
): RelayEndpoint | null {
  const url = new URL(request.url ?? "/", "http://relay.local");
  const pathname = normalizeRelayPathname(url.pathname);
  if (pathname === "/relay/ws/agent") {
    return "agent";
  }
  if (pathname === "/relay/ws/mobile") {
    return "mobile";
  }
  return null;
}

export function relayAdminWebUrl(host: string, port: number): string {
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const urlHost = displayHost.includes(":") ? `[${displayHost}]` : displayHost;
  return `http://${urlHost}:${port}/admin/web`;
}

export function rejectWebSocketUpgrade(
  socket: Socket,
  message: string,
  statusCode = 404,
): void {
  const statusText = statusCode === 403 ? "Forbidden" : "Not Found";
  const body = JSON.stringify({
    error: statusCode === 403 ? message : "invalid_relay_path",
    message,
  });
  socket.write(
    [
      `HTTP/1.1 ${statusCode} ${statusText}`,
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: close",
      "",
      body,
    ].join("\r\n"),
  );
  socket.destroy();
}

function isTrustedProxyIp(ip: string, trustedProxyIps: Set<string>): boolean {
  for (const trustedIp of trustedProxyIps) {
    if (normalizeIpLiteral(trustedIp) === ip) {
      return true;
    }
  }
  return false;
}

function normalizeIpForGeoLookup(remoteIp: string): string {
  return normalizeIpLiteral(remoteIp);
}

function normalizeIpLiteral(remoteIp: string): string {
  const trimmed = remoteIp.trim().toLowerCase();
  return trimmed.startsWith("::ffff:")
    ? trimmed.slice("::ffff:".length)
    : trimmed;
}

function countryName(countryCode: string): string {
  try {
    return (
      new Intl.DisplayNames(["en"], { type: "region" }).of(countryCode) ??
      countryCode
    );
  } catch {
    return countryCode;
  }
}

function slugLocationPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeRelayPathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }

  return pathname;
}
