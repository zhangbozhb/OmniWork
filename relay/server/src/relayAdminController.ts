import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AppInfoPayload } from "@omniwork/protocol-ts";

import { RelayAdminAuth } from "./adminAuth.ts";
import {
  renderRelayAdminLoginPage,
  renderRelayAdminPage,
} from "./adminPage.ts";
import { AdminControlStore } from "./adminControlStore.ts";
import type { RelayServerConfig } from "./config.ts";
import type { ControlRule, RelayConnection, RelayAppInfo } from "./relayTypes.ts";

const ADMIN_WEB_PATHS = new Set([
  "/admin/web",
  "/admin/web/",
  "/admin/web/index.html",
]);
const ADMIN_API_PREFIX = "/admin/api";

export interface RelayAdminControllerOptions {
  config: RelayServerConfig;
  connections: Map<string, RelayConnection>;
  agentsByDevice: Map<string, RelayConnection>;
  mobilesByDevice: Map<string, Set<RelayConnection>>;
  unregister(connection: RelayConnection): void;
}

export class RelayAdminController {
  private readonly config: RelayServerConfig;
  private readonly connections: Map<string, RelayConnection>;
  private readonly agentsByDevice: Map<string, RelayConnection>;
  private readonly mobilesByDevice: Map<string, Set<RelayConnection>>;
  private readonly disabledAgentInstances = new Map<string, ControlRule>();
  private readonly ipBans = new Map<string, ControlRule>();
  private readonly auth: RelayAdminAuth;
  private readonly controlStore: AdminControlStore;
  private readonly unregister: (connection: RelayConnection) => void;

  constructor(options: RelayAdminControllerOptions) {
    this.config = options.config;
    this.connections = options.connections;
    this.agentsByDevice = options.agentsByDevice;
    this.mobilesByDevice = options.mobilesByDevice;
    this.unregister = options.unregister;
    this.auth = new RelayAdminAuth(options.config.admin);
    this.controlStore = new AdminControlStore(options.config.admin.controlsDbPath);
  }

  start(): void {
    this.loadPermanentControlRules();
    this.auth.start();
  }

  matches(pathname: string): boolean {
    return (
      (this.config.admin.webEnabled && ADMIN_WEB_PATHS.has(pathname)) ||
      pathname.startsWith(`${ADMIN_API_PREFIX}/`)
    );
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (
      this.config.admin.webEnabled &&
      request.method === "GET" &&
      ADMIN_WEB_PATHS.has(url.pathname)
    ) {
      this.handleWeb(request, response);
      return;
    }

    if (url.pathname.startsWith(`${ADMIN_API_PREFIX}/`)) {
      const adminUrl = new URL(url);
      adminUrl.pathname = `/api${url.pathname.slice(ADMIN_API_PREFIX.length)}`;
      await this.handleApiHttp(request, response, adminUrl);
      return;
    }

    this.writeJson(response, 404, { error: "not_found" });
  }

  tokenPath(): string {
    return this.auth.tokenPath();
  }

  activeIpBan(ip: string | undefined): ControlRule | null {
    if (!ip) {
      return null;
    }
    return this.activeRule(this.ipBans, ip);
  }

  activeDisabledAgentInstance(agentInstanceId: string | undefined): ControlRule | null {
    if (!agentInstanceId) {
      return null;
    }
    return this.activeRule(this.disabledAgentInstances, agentInstanceId);
  }

  private handleWeb(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    if (!this.isHttpsRequest(request)) {
      this.writeJson(response, 403, { error: "admin_https_required" });
      return;
    }
    if (!this.auth.authenticate(request)) {
      this.writeHtml(response, renderRelayAdminLoginPage());
      return;
    }
    this.writeHtml(response, renderRelayAdminPage());
  }

  private async handleApiHttp(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!this.isHttpsRequest(request)) {
      this.writeJson(response, 403, { error: "admin_https_required" });
      return;
    }

    const method = request.method ?? "GET";
    if (method === "POST" && url.pathname === "/api/login") {
      const body = await readJsonBody(request);
      const token =
        body &&
        typeof body === "object" &&
        "token" in body &&
        typeof body.token === "string"
          ? body.token
          : "";
      const session = this.auth.login(token.trim());
      if (!session) {
        this.writeJson(response, 401, { error: "unauthorized" });
        return;
      }
      this.writeJson(
        response,
        200,
        { ok: true, expires_at: session.expiresAt },
        { "set-cookie": this.auth.sessionCookie(session) },
      );
      return;
    }

    const session = this.auth.authenticate(request);
    if (!session) {
      this.writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    if (method === "POST" && url.pathname === "/api/logout") {
      this.auth.logout(request);
      this.writeJson(
        response,
        200,
        { ok: true },
        { "set-cookie": this.auth.clearSessionCookie() },
      );
      return;
    }

    if (method === "GET" && url.pathname === "/api/me") {
      this.writeJson(response, 200, {
        authenticated: true,
        expires_at: session.expiresAt,
        csrf_token: session.csrfToken,
      });
      return;
    }

    await this.handleApi(request, response, url);
  }

  private async handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    this.pruneExpiredRules();
    const method = request.method ?? "GET";
    if (method === "GET" && url.pathname === "/api/healthz") {
      this.writeJson(response, 200, { ok: true });
      return;
    }
    if (method === "GET" && url.pathname === "/api/status") {
      this.writeJson(response, 200, this.statusSnapshot());
      return;
    }
    if (method === "GET" && url.pathname === "/api/agents") {
      this.writeJson(response, 200, this.agentsSnapshot());
      return;
    }
    const agentAppsMatch = url.pathname.match(
      /^\/api\/agent-connections\/([^/]+)\/apps$/,
    );
    if (method === "GET" && agentAppsMatch?.[1]) {
      this.writeJson(
        response,
        200,
        this.agentAppsSnapshot(decodeURIComponent(agentAppsMatch[1])),
      );
      return;
    }
    if (method === "GET" && url.pathname === "/api/controls") {
      this.writeJson(response, 200, this.controlsSnapshot());
      return;
    }

    if (method === "POST" && url.pathname === "/api/controls/agents/agent-op") {
      const body = await readJsonBody(request);
      const action = readAgentControlAction(body);
      const agentInstanceIds = readAgentInstanceIds(body);
      if (action === "delete") {
        for (const agentInstanceId of agentInstanceIds) {
          this.disabledAgentInstances.delete(agentInstanceId);
          this.controlStore.delete("agent_instance_disable", agentInstanceId);
        }
        this.writeJson(response, 200, {
          ok: true,
          action,
          agent_instance_ids: agentInstanceIds,
        });
        return;
      }

      const rules = agentInstanceIds.map((agentInstanceId) => {
        const rule = this.disableAgentInstance(
          agentInstanceId,
          controlRuleFromBody(body, this.config.admin.agentDisableDefaultMs),
        );
        return {
          agent_instance_id: agentInstanceId,
          rule: serializeRule(rule),
        };
      });
      this.writeJson(response, 200, {
        ok: true,
        action,
        agent_instance_ids: agentInstanceIds,
        rules,
      });
      return;
    }
    if (method === "POST" && url.pathname === "/api/controls/ip-bans") {
      const body = await readJsonBody(request);
      const action = readIpBanAction(body);
      const ips = readIpList(body);
      if (action === "unban") {
        for (const ip of ips) {
          this.ipBans.delete(ip);
          this.controlStore.delete("ip_ban", ip);
        }
        this.writeJson(response, 200, { ok: true, action, ips });
        return;
      }

      const rules = ips.map((ip) => {
        const rule = this.banIp(
          ip,
          controlRuleFromBody(body, this.config.admin.ipBanDefaultMs),
        );
        return { ip, rule: serializeRule(rule) };
      });
      this.writeJson(response, 200, { ok: true, action, ips, rules });
      return;
    }

    this.writeJson(response, 404, { error: "not_found" });
  }

  private statusSnapshot() {
    const agents = this.agents();
    const appCount = agents.reduce(
      (total, agent) => total + agent.app_count,
      0,
    );
    return {
      ok: true,
      generated_at: new Date().toISOString(),
      relay: {
        host: this.config.host,
        port: this.config.port,
        protocol_version: this.config.protocolVersion,
      },
      summary: {
        agent_count: agents.length,
        app_count: appCount,
        disabled_agent_count: this.activeDisabledAgentInstances().length,
        ip_ban_count: this.activeIpBans().length,
      },
    };
  }

  private agentsSnapshot() {
    const agents = this.agents();
    return {
      agents,
      summary: {
        agent_count: agents.length,
        app_count: agents.reduce((total, agent) => total + agent.app_count, 0),
      },
    };
  }

  private agentAppsSnapshot(connectionId: string) {
    const agent = this.connections.get(connectionId);
    if (!agent || agent.role !== "agent") {
      return {
        connection_id: connectionId,
        device_id: undefined,
        agent_instance_id: undefined,
        apps: [],
        summary: {
          app_count: 0,
        },
      };
    }

    const deviceId = agent.deviceId ?? "";
    const apps = this.appsForDevice(deviceId);
    return {
      connection_id: connectionId,
      device_id: deviceId,
      agent_instance_id: agent.agentInstanceId,
      apps,
      summary: {
        app_count: apps.length,
      },
    };
  }

  private controlsSnapshot() {
    this.pruneExpiredRules();
    return {
      agent_instance_disables: this.activeDisabledAgentInstances(),
      ip_bans: this.activeIpBans(),
      defaults: {
        agent_disable_default_ms: this.config.admin.agentDisableDefaultMs,
        ip_ban_default_ms: this.config.admin.ipBanDefaultMs,
        session_auth_required: true,
        https_required: this.config.admin.requireHttps,
        web_enabled: this.config.admin.webEnabled,
        token_file: this.auth.tokenPath(),
        controls_db: this.config.admin.controlsDbPath,
      },
    };
  }

  private agents() {
    this.pruneExpiredRules();
    return [...this.agentsByDevice.values()]
      .sort((a, b) => (a.deviceId ?? "").localeCompare(b.deviceId ?? ""))
      .map((agent) => {
        const deviceId = agent.deviceId ?? "";
        const apps = this.appsForDevice(deviceId);
        return {
          device_id: deviceId,
          connection_id: agent.id,
          agent_instance_id: agent.agentInstanceId,
          key_id: agent.keyId,
          state: agent.state,
          remote_ip: agent.remoteIp,
          connected_at: toIso(agent.connectedAt),
          last_seen_at: toIso(agent.lastSeenAt),
          business_security_mode: agent.businessSecurityMode ?? "e2e_required",
          app_count: apps.length,
          disabled: Boolean(
            this.activeDisabledAgentInstance(agent.agentInstanceId),
          ),
        };
      });
  }

  private appsForDevice(deviceId: string) {
    const mobiles = [...(this.mobilesByDevice.get(deviceId) ?? new Set())];
    for (const connection of this.connections.values()) {
      if (
        connection.role === "mobile" &&
        connection.deviceId === deviceId &&
        !mobiles.includes(connection)
      ) {
        mobiles.push(connection);
      }
    }
    return mobiles
      .sort((a, b) => a.connectedAt - b.connectedAt)
      .map((mobile) => ({
        connection_id: mobile.id,
        app_info: mobile.appInfo ? appInfoToPayload(mobile.appInfo) : undefined,
        remote_ip: mobile.remoteIp,
        state: mobile.state,
        auth_state: mobile.authState,
        connected_at: toIso(mobile.connectedAt),
        last_seen_at: toIso(mobile.lastSeenAt),
        transport_path: mobile.transportPath,
      }));
  }

  private disableAgentInstance(
    agentInstanceId: string,
    rule: ControlRule,
  ): ControlRule {
    this.disabledAgentInstances.set(agentInstanceId, rule);
    this.persistPermanentRule("agent_instance_disable", agentInstanceId, rule);
    const agents = [...this.connections.values()].filter(
      (connection) =>
        connection.role === "agent" &&
        connection.agentInstanceId === agentInstanceId,
    );
    for (const agent of agents) {
      agent.socket.close(4403, "agent_disabled");
      this.unregister(agent);
      const mobiles = [
        ...(this.mobilesByDevice.get(agent.deviceId ?? "") ?? new Set()),
      ];
      for (const mobile of mobiles) {
        mobile.socket.close(4403, "agent_disabled");
        this.unregister(mobile);
      }
    }
    return rule;
  }

  private banIp(ip: string, rule: ControlRule): ControlRule {
    this.ipBans.set(ip, rule);
    this.persistPermanentRule("ip_ban", ip, rule);
    for (const connection of [...this.connections.values()]) {
      if (connection.remoteIp === ip) {
        connection.socket.close(4403, "ip_banned");
        this.unregister(connection);
      }
    }
    return rule;
  }

  private isHttpsRequest(request: IncomingMessage): boolean {
    return !this.config.admin.requireHttps || this.auth.isHttps(request);
  }

  private activeRule(
    rules: Map<string, ControlRule>,
    key: string,
  ): ControlRule | null {
    const rule = rules.get(key);
    if (!rule) {
      return null;
    }
    if (rule.expiresAt && rule.expiresAt <= Date.now()) {
      rules.delete(key);
      return null;
    }
    return rule;
  }

  private activeDisabledAgentInstances() {
    this.pruneExpiredRules();
    return [...this.disabledAgentInstances.entries()].map(
      ([agentInstanceId, rule]) => ({
        agent_instance_id: agentInstanceId,
        rule: serializeRule(rule),
      }),
    );
  }

  private activeIpBans() {
    this.pruneExpiredRules();
    return [...this.ipBans.entries()].map(([ip, rule]) => ({
      ip,
      rule: serializeRule(rule),
    }));
  }

  private pruneExpiredRules(): void {
    const now = Date.now();
    for (const [key, rule] of this.disabledAgentInstances) {
      if (rule.expiresAt && rule.expiresAt <= now) {
        this.disabledAgentInstances.delete(key);
      }
    }
    for (const [key, rule] of this.ipBans) {
      if (rule.expiresAt && rule.expiresAt <= now) {
        this.ipBans.delete(key);
      }
    }
  }

  private loadPermanentControlRules(): void {
    for (const record of this.controlStore.load()) {
      if (record.rule.expiresAt) {
        continue;
      }
      if (record.kind === "agent_instance_disable") {
        this.disabledAgentInstances.set(record.target, record.rule);
      } else {
        this.ipBans.set(record.target, record.rule);
      }
    }
  }

  private persistPermanentRule(
    kind: "agent_instance_disable" | "ip_ban",
    target: string,
    rule: ControlRule,
  ): void {
    if (rule.expiresAt) {
      this.controlStore.delete(kind, target);
      return;
    }
    this.controlStore.upsert({ kind, target, rule });
  }

  private writeJson(
    response: ServerResponse,
    statusCode: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    response.writeHead(statusCode, {
      "content-type": "application/json",
      ...headers,
    });
    response.end(JSON.stringify(body));
  }

  private writeHtml(response: ServerResponse, body: string): void {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  }
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}

function serializeRule(rule: ControlRule) {
  return {
    id: rule.id,
    reason: rule.reason,
    created_at: toIso(rule.createdAt),
    expires_at: rule.expiresAt ? toIso(rule.expiresAt) : undefined,
  };
}

function controlRuleFromBody(
  body: unknown,
  defaultTtlMs?: number,
): ControlRule {
  const record = isRecord(body) ? body : {};
  const now = Date.now();
  const expiresAt = parseExpiresAt(record, now, defaultTtlMs);
  return {
    id: `rule_${randomUUID()}`,
    reason: readOptionalString(record, "reason"),
    createdAt: now,
    expiresAt,
  };
}

function parseExpiresAt(
  body: Record<string, unknown>,
  now: number,
  defaultTtlMs?: number,
): number | undefined {
  if (
    body.permanent === true ||
    readOptionalString(body, "duration") === "permanent"
  ) {
    return undefined;
  }
  const expiresAt = readOptionalString(body, "expires_at");
  if (expiresAt) {
    const parsed = Date.parse(expiresAt);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  const ttl = body.expires_in_ms ?? body.ttl_ms;
  if (typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0) {
    return now + ttl;
  }
  if (typeof ttl === "string") {
    const parsed = Number(ttl);
    if (Number.isFinite(parsed) && parsed > 0) {
      return now + parsed;
    }
  }
  return defaultTtlMs ? now + defaultTtlMs : undefined;
}

function readIpBanAction(body: unknown): "ban" | "unban" {
  if (!isRecord(body)) {
    return "ban";
  }
  const action = readOptionalString(body, "action") ?? "ban";
  if (action !== "ban" && action !== "unban") {
    throw new Error('Invalid action. Use "ban" or "unban".');
  }
  return action;
}

function readAgentControlAction(body: unknown): "disable" | "delete" {
  if (!isRecord(body)) {
    return "disable";
  }
  const action = readOptionalString(body, "action") ?? "disable";
  if (action !== "disable" && action !== "delete") {
    throw new Error('Invalid action. Use "disable" or "delete".');
  }
  return action;
}

function readAgentInstanceIds(body: unknown): string[] {
  if (!isRecord(body)) {
    throw new Error("Missing agent_instance_ids.");
  }
  const rawIds = body.agent_instance_ids;
  const ids = Array.isArray(rawIds)
    ? rawIds
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const singleId = readOptionalString(body, "agent_instance_id");
  if (singleId) {
    ids.push(singleId);
  }
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) {
    throw new Error("Missing agent_instance_ids.");
  }
  return uniqueIds;
}

function readIpList(body: unknown): string[] {
  if (!isRecord(body)) {
    throw new Error("Missing ips.");
  }
  const rawIps = body.ips;
  const ips = Array.isArray(rawIps)
    ? rawIps
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const singleIp = readOptionalString(body, "ip");
  if (singleIp) {
    ips.push(singleIp);
  }
  const uniqueIps = [...new Set(ips)];
  if (uniqueIps.length === 0) {
    throw new Error("Missing ips.");
  }
  return uniqueIps;
}

function readOptionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? (JSON.parse(raw) as unknown) : {};
}

function appInfoToPayload(appInfo: RelayAppInfo): AppInfoPayload {
  return {
    instance_id: appInfo.instanceId,
    runtime_id: appInfo.runtimeId,
    name: appInfo.name,
    device_name: appInfo.deviceName,
    platform: appInfo.platform,
    version: appInfo.version,
    capabilities: appInfo.capabilities,
  };
}
