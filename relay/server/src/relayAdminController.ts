import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  normalizeIdentityId,
  RELAY_AGENT_APPROVAL_REQUIRED_CLOSE_CODE,
  RELAY_AGENT_APPROVAL_REQUIRED_CLOSE_REASON,
  RELAY_AGENT_DISABLED_CLOSE_REASON,
  RELAY_AGENT_IP_BANNED_CLOSE_REASON,
  RELAY_AGENT_SHUTDOWN_CLOSE_CODE,
} from "@omni-work/protocol-ts";

import { RelayAuthExecutor } from "./auth/executor.ts";
import { RelayAuthGuard } from "./auth/guard.ts";
import { AdminHttpPolicy } from "./auth/policies/adminHttpPolicy.ts";
import { RelayAdminAuth, type RelayAdminStartupToken } from "./adminAuth.ts";
import {
  readRelayAdminAsset,
  renderRelayAdminLoginPage,
  renderRelayAdminPage,
} from "./adminPage.ts";
import { AdminControlStore } from "./adminControlStore.ts";
import type { RelayServerConfig } from "./config.ts";
import { relayDevicePublicKeyFingerprint } from "./relayDeviceSignature.ts";
import type { RelayStateStore } from "./relayStateStore.ts";
import type {
  AgentAuthorizationDecision,
  ControlRule,
  PendingAgentAuthorization,
  RelayConnection,
} from "./relayTypes.ts";

const ADMIN_WEB_PATHS = new Set([
  "/admin/web",
  "/admin/web/",
  "/admin/web/index.html",
]);
const ADMIN_WEB_ASSET_PREFIX = "/admin/web/";
const ADMIN_API_PREFIX = "/admin/api";

export interface RelayAdminControllerOptions {
  config: RelayServerConfig;
  connections: Map<string, RelayConnection>;
  state: RelayStateStore;
  mobilesByDevice: Map<string, Set<RelayConnection>>;
  unregister(connection: RelayConnection): void;
}

export class RelayAdminController {
  private readonly config: RelayServerConfig;
  private readonly connections: Map<string, RelayConnection>;
  private readonly state: RelayStateStore;
  private readonly mobilesByDevice: Map<string, Set<RelayConnection>>;
  private readonly authorizedAgentDevices = new Map<string, ControlRule>();
  private readonly pendingAgentAuthorizations = new Map<
    string,
    PendingAgentAuthorization
  >();
  private readonly disabledAgentDevices = new Map<string, ControlRule>();
  private readonly ipBans = new Map<string, ControlRule>();
  private readonly auth: RelayAdminAuth;
  private readonly authGuard: RelayAuthGuard;
  private readonly authExecutor: RelayAuthExecutor;
  private readonly controlStore: AdminControlStore;
  private readonly unregister: (connection: RelayConnection) => void;

  constructor(options: RelayAdminControllerOptions) {
    this.config = options.config;
    this.connections = options.connections;
    this.state = options.state;
    this.mobilesByDevice = options.mobilesByDevice;
    this.unregister = options.unregister;
    this.auth = new RelayAdminAuth(options.config.admin);
    this.authGuard = new RelayAuthGuard({
      policies: {
        adminHttp: [
          new AdminHttpPolicy({
            isAdminHttps: (request) => this.isHttpsRequest(request),
            authenticateAdmin: (request) => this.auth.authenticate(request),
          }),
        ],
      },
    });
    this.authExecutor = new RelayAuthExecutor({
      send: () => {},
    });
    this.controlStore = new AdminControlStore(
      options.config.admin.controlsDbPath,
    );
  }

  start(): RelayAdminStartupToken {
    this.loadPermanentControlRules();
    return this.auth.start();
  }

  matches(pathname: string): boolean {
    const adminPathname = this.stripConfiguredPrefix(pathname);
    return (
      (this.config.admin.webEnabled &&
        (ADMIN_WEB_PATHS.has(adminPathname) ||
          adminPathname.startsWith(ADMIN_WEB_ASSET_PREFIX))) ||
      adminPathname.startsWith(`${ADMIN_API_PREFIX}/`)
    );
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const pathname = this.stripConfiguredPrefix(url.pathname);
    if (
      this.config.admin.webEnabled &&
      request.method === "GET" &&
      ADMIN_WEB_PATHS.has(pathname)
    ) {
      this.handleWeb(request, response);
      return;
    }

    if (
      this.config.admin.webEnabled &&
      request.method === "GET" &&
      pathname.startsWith(ADMIN_WEB_ASSET_PREFIX)
    ) {
      this.handleWebAsset(request, response, pathname);
      return;
    }

    if (pathname.startsWith(`${ADMIN_API_PREFIX}/`)) {
      const adminUrl = new URL(url);
      adminUrl.pathname = `/api${pathname.slice(ADMIN_API_PREFIX.length)}`;
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

  activeDisabledAgentDevice(deviceId: string | undefined): ControlRule | null {
    if (!deviceId) {
      return null;
    }
    return this.activeRule(
      this.disabledAgentDevices,
      normalizeIdentityId(deviceId) ?? deviceId,
    );
  }

  authorizeAgent(input: {
    deviceId: string;
    devicePublicKey: string;
    remoteIp: string;
    publicRemoteIp: string | null;
    hostname: string;
    systemType: string;
    uname: string;
    agentVersion: string;
  }): AgentAuthorizationDecision {
    input = {
      ...input,
      deviceId: normalizeIdentityId(input.deviceId) ?? input.deviceId,
    };
    this.pruneExpiredRules();
    if (this.activeDisabledAgentDevice(input.deviceId)) {
      return { ok: false, reason: "agent_disabled" };
    }
    if (this.activeIpBan(input.remoteIp)) {
      return { ok: false, reason: "ip_banned" };
    }
    if (this.authorizedAgentDevices.has(input.deviceId)) {
      this.pendingAgentAuthorizations.delete(input.deviceId);
      return { ok: true };
    }
    if (this.config.agentAuthorization.mode === "automatic") {
      this.approveAgentDevice(input.deviceId, "automatic authorization");
      return { ok: true };
    }

    const now = Date.now();
    const existing = this.pendingAgentAuthorizations.get(input.deviceId);
    this.pendingAgentAuthorizations.set(input.deviceId, {
      deviceId: input.deviceId,
      publicKeyFingerprint:
        relayDevicePublicKeyFingerprint(input.devicePublicKey) ?? "invalid",
      remoteIp: input.remoteIp,
      publicIp: input.publicRemoteIp,
      hostname: input.hostname,
      systemType: input.systemType,
      uname: input.uname,
      agentVersion: input.agentVersion,
      requestedAt: existing?.requestedAt ?? now,
      lastAttemptAt: now,
      expiresAt: now + this.config.agentAuthorization.pendingTtlMs,
      attemptCount: (existing?.attemptCount ?? 0) + 1,
    });
    return {
      ok: false,
      reason: RELAY_AGENT_APPROVAL_REQUIRED_CLOSE_REASON,
    };
  }

  private handleWeb(request: IncomingMessage, response: ServerResponse): void {
    const decision = this.authorizeAdminHttp(request, "/", "GET", true, false);
    if (!decision.ok) {
      if (decision.reason === "unauthorized") {
        this.writeHtml(
          response,
          renderRelayAdminLoginPage(this.config.admin.prefix),
        );
      } else {
        this.authExecutor.execute(decision, { response });
      }
      return;
    }
    this.writeHtml(response, renderRelayAdminPage(this.config.admin.prefix));
  }

  private handleWebAsset(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): void {
    const decision = this.authorizeAdminHttp(
      request,
      pathname,
      "GET",
      true,
      false,
    );
    if (!decision.ok) {
      this.authExecutor.execute(decision, { response });
      return;
    }
    const assetName = decodeURIComponent(
      pathname.slice(ADMIN_WEB_ASSET_PREFIX.length),
    );
    const asset = readRelayAdminAsset(assetName);
    if (!asset) {
      this.writeJson(response, 404, { error: "not_found" });
      return;
    }
    response.writeHead(200, {
      "content-type": asset.contentType,
      "cache-control": "public, max-age=86400",
    });
    response.end(asset.body);
  }

  private async handleApiHttp(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const method = request.method ?? "GET";
    const isLogin = method === "POST" && url.pathname === "/api/login";
    const preLoginDecision = this.authorizeAdminHttp(
      request,
      url.pathname,
      method,
      !isLogin,
      false,
    );
    if (!preLoginDecision.ok) {
      this.authExecutor.execute(preLoginDecision, { response });
      return;
    }

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

    const session = preLoginDecision.subject?.adminSession;
    if (method !== "GET") {
      const csrfDecision = this.authorizeAdminHttp(
        request,
        url.pathname,
        method,
        true,
        true,
      );
      if (!csrfDecision.ok) {
        this.authExecutor.execute(csrfDecision, { response });
        return;
      }
    }
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
    if (method === "GET" && url.pathname === "/api/agent-authorizations") {
      this.writeJson(response, 200, this.agentAuthorizationsSnapshot());
      return;
    }
    if (method === "GET" && url.pathname === "/api/devices") {
      this.writeJson(
        response,
        200,
        this.state.devicesSnapshot({
          includeOffline: url.searchParams.get("include_offline") !== "false",
          limit: readPositiveInteger(url.searchParams.get("limit"), 100),
        }),
      );
      return;
    }
    if (method === "GET" && url.pathname === "/api/links") {
      this.writeJson(response, 200, this.state.linksSnapshot());
      return;
    }
    if (method === "GET" && url.pathname === "/api/traffic") {
      this.writeJson(response, 200, this.state.trafficTop());
      return;
    }
    if (method === "GET" && url.pathname === "/api/traffic-map") {
      this.writeJson(response, 200, this.state.trafficMapSnapshot());
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

    if (
      method === "POST" &&
      url.pathname === "/api/agent-authorizations/device-op"
    ) {
      const body = await readJsonBody(request);
      const action = readAgentAuthorizationAction(body);
      const deviceIds = readAgentDeviceIds(body);
      for (const deviceId of deviceIds) {
        if (action === "approve") {
          this.approveAgentDevice(
            deviceId,
            readBodyReason(body) ?? "manual authorization",
          );
        } else if (action === "reject") {
          this.pendingAgentAuthorizations.delete(deviceId);
          this.disableAgentDevice(
            deviceId,
            controlRuleFromBody(body, undefined),
          );
        } else {
          this.removeAgentAuthorization(deviceId);
        }
      }
      this.writeJson(response, 200, {
        ok: true,
        action,
        agent_device_ids: deviceIds,
      });
      return;
    }

    if (
      method === "POST" &&
      url.pathname === "/api/controls/agent-devices/device-op"
    ) {
      const body = await readJsonBody(request);
      const action = readAgentControlAction(body);
      const deviceIds = readAgentDeviceIds(body);
      if (action === "delete") {
        for (const deviceId of deviceIds) {
          this.disabledAgentDevices.delete(deviceId);
          this.controlStore.delete("agent_device_disable", deviceId);
        }
        this.writeJson(response, 200, {
          ok: true,
          action,
          agent_device_ids: deviceIds,
        });
        return;
      }

      const rules = deviceIds.map((deviceId) => {
        const rule = this.disableAgentDevice(
          deviceId,
          controlRuleFromBody(
            body,
            this.config.admin.agentDeviceDisableDefaultMs,
          ),
        );
        return {
          agent_device_id: deviceId,
          rule: serializeRule(rule),
        };
      });
      this.writeJson(response, 200, {
        ok: true,
        action,
        agent_device_ids: deviceIds,
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
    const runtime = this.state.runtimeSnapshot();
    return {
      ok: true,
      generated_at: new Date().toISOString(),
      relay: {
        host: this.config.host,
        port: this.config.port,
        protocol_version: this.config.protocolVersion,
      },
      summary: {
        ...runtime.totals,
        active_device_count: runtime.totals.device_count,
        active_agent_count: runtime.totals.agent_count,
        active_app_count: runtime.totals.app_connection_count,
        active_link_count: runtime.totals.link_count,
        open_connection_count: runtime.totals.connection_count,
        app_count: runtime.totals.app_connection_count,
        authorized_agent_device_count: this.authorizedAgentDevices.size,
        pending_agent_authorization_count:
          this.activePendingAgentAuthorizations().length,
        disabled_agent_device_count: this.activeDisabledAgentDevices().length,
        ip_ban_count: this.activeIpBans().length,
      },
      traffic: runtime.traffic,
      auth: runtime.auth,
      routing: runtime.routing,
      protocol: runtime.protocol,
    };
  }

  private agentsSnapshot() {
    return this.state.agentsSnapshot();
  }

  private agentAppsSnapshot(connectionId: string) {
    return this.state.agentAppsSnapshot(connectionId);
  }

  private agentAuthorizationsSnapshot() {
    this.pruneExpiredRules();
    return {
      mode: this.config.agentAuthorization.mode,
      pending: this.activePendingAgentAuthorizations(),
      authorized: [...this.authorizedAgentDevices.entries()].map(
        ([deviceId, authorization]) => ({
          agent_device_id: deviceId,
          authorized_at: toIso(authorization.createdAt),
          reason: authorization.reason,
        }),
      ),
    };
  }

  private controlsSnapshot() {
    this.pruneExpiredRules();
    return {
      agent_device_disables: this.activeDisabledAgentDevices(),
      ip_bans: this.activeIpBans(),
      defaults: {
        agent_device_disable_default_ms:
          this.config.admin.agentDeviceDisableDefaultMs,
        ip_ban_default_ms: this.config.admin.ipBanDefaultMs,
        session_auth_required: true,
        https_required: this.config.admin.requireHttps,
        web_enabled: this.config.admin.webEnabled,
        token_file: this.auth.tokenPath(),
        controls_db: this.config.admin.controlsDbPath,
      },
    };
  }

  private authorizeAdminHttp(
    request: IncomingMessage,
    pathname: string,
    method: string,
    requireSession: boolean,
    requireCsrf: boolean,
  ) {
    return this.authGuard.authorize({
      surface: "admin_http",
      request,
      pathname,
      method,
      requireSession,
      requireCsrf,
    });
  }

  private approveAgentDevice(deviceId: string, reason?: string): ControlRule {
    const authorization: ControlRule = {
      id: `authorization_${randomUUID()}`,
      reason,
      createdAt: Date.now(),
    };
    this.authorizedAgentDevices.set(deviceId, authorization);
    this.pendingAgentAuthorizations.delete(deviceId);
    this.persistPermanentRule(
      "agent_device_authorization",
      deviceId,
      authorization,
    );
    return authorization;
  }

  private removeAgentAuthorization(deviceId: string): void {
    this.authorizedAgentDevices.delete(deviceId);
    this.pendingAgentAuthorizations.delete(deviceId);
    this.controlStore.delete("agent_device_authorization", deviceId);
    if (this.config.agentAuthorization.mode === "manual") {
      this.closeAgentDevice(
        deviceId,
        RELAY_AGENT_APPROVAL_REQUIRED_CLOSE_REASON,
      );
    }
  }

  private disableAgentDevice(deviceId: string, rule: ControlRule): ControlRule {
    this.disabledAgentDevices.set(deviceId, rule);
    this.pendingAgentAuthorizations.delete(deviceId);
    this.persistPermanentRule("agent_device_disable", deviceId, rule);
    this.closeAgentDevice(deviceId, RELAY_AGENT_DISABLED_CLOSE_REASON);
    return rule;
  }

  private closeAgentDevice(deviceId: string, reason: string): void {
    const agents = [...this.connections.values()].filter(
      (connection) =>
        connection.role === "agent" && connection.deviceId === deviceId,
    );
    for (const agent of agents) {
      agent.socket.close(
        reason === RELAY_AGENT_APPROVAL_REQUIRED_CLOSE_REASON
          ? RELAY_AGENT_APPROVAL_REQUIRED_CLOSE_CODE
          : RELAY_AGENT_SHUTDOWN_CLOSE_CODE,
        reason,
      );
      this.unregister(agent);
      const mobiles = [...(this.mobilesByDevice.get(deviceId) ?? new Set())];
      for (const mobile of mobiles) {
        mobile.socket.close(4403, reason);
        this.unregister(mobile);
      }
    }
  }

  private banIp(ip: string, rule: ControlRule): ControlRule {
    this.ipBans.set(ip, rule);
    for (const [deviceId, pending] of this.pendingAgentAuthorizations) {
      if (pending.remoteIp === ip) {
        this.pendingAgentAuthorizations.delete(deviceId);
      }
    }
    this.persistPermanentRule("ip_ban", ip, rule);
    for (const connection of [...this.connections.values()]) {
      if (connection.remoteIp === ip) {
        if (connection.role === "agent") {
          connection.socket.close(
            RELAY_AGENT_SHUTDOWN_CLOSE_CODE,
            RELAY_AGENT_IP_BANNED_CLOSE_REASON,
          );
        } else {
          connection.socket.close(4403, "ip_banned");
        }
        this.unregister(connection);
      }
    }
    return rule;
  }

  private isHttpsRequest(request: IncomingMessage): boolean {
    return !this.config.admin.requireHttps || this.auth.isHttps(request);
  }

  private stripConfiguredPrefix(pathname: string): string {
    const prefix = this.config.admin.prefix;
    if (
      prefix &&
      (pathname === `${prefix}/admin` ||
        pathname.startsWith(`${prefix}/admin/`))
    ) {
      return pathname.slice(prefix.length);
    }
    return pathname;
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

  private activeDisabledAgentDevices() {
    this.pruneExpiredRules();
    return [...this.disabledAgentDevices.entries()].map(([deviceId, rule]) => ({
      agent_device_id: deviceId,
      rule: serializeRule(rule),
    }));
  }

  private activePendingAgentAuthorizations() {
    this.pruneExpiredRules();
    return [...this.pendingAgentAuthorizations.values()].map((pending) => ({
      agent_device_id: pending.deviceId,
      public_key_fingerprint: pending.publicKeyFingerprint,
      public_ip: pending.publicIp,
      hostname: pending.hostname,
      system_type: pending.systemType,
      uname: pending.uname,
      agent_version: pending.agentVersion,
      requested_at: toIso(pending.requestedAt),
      last_attempt_at: toIso(pending.lastAttemptAt),
      expires_at: toIso(pending.expiresAt),
      attempt_count: pending.attemptCount,
    }));
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
    for (const [key, rule] of this.disabledAgentDevices) {
      if (rule.expiresAt && rule.expiresAt <= now) {
        this.disabledAgentDevices.delete(key);
      }
    }
    for (const [key, rule] of this.ipBans) {
      if (rule.expiresAt && rule.expiresAt <= now) {
        this.ipBans.delete(key);
      }
    }
    for (const [key, pending] of this.pendingAgentAuthorizations) {
      if (pending.expiresAt <= now) {
        this.pendingAgentAuthorizations.delete(key);
      }
    }
  }

  private loadPermanentControlRules(): void {
    for (const record of this.controlStore.load()) {
      if (record.rule.expiresAt) {
        continue;
      }
      if (record.kind !== "ip_ban") {
        const target = normalizeIdentityId(record.target);
        if (target && target !== record.target) {
          // Normalize older control records before using them as map keys.
          this.controlStore.upsert({ ...record, target });
          this.controlStore.delete(record.kind, record.target);
          record.target = target;
        }
      }
      if (record.kind === "agent_device_authorization") {
        this.authorizedAgentDevices.set(record.target, record.rule);
      } else if (record.kind === "agent_device_disable") {
        this.disabledAgentDevices.set(record.target, record.rule);
      } else if (record.kind === "ip_ban") {
        this.ipBans.set(record.target, record.rule);
      }
    }
  }

  private persistPermanentRule(
    kind: "agent_device_authorization" | "agent_device_disable" | "ip_ban",
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

function readAgentAuthorizationAction(
  body: unknown,
): "approve" | "reject" | "delete" {
  if (!isRecord(body)) {
    return "approve";
  }
  const action = readOptionalString(body, "action") ?? "approve";
  if (!["approve", "reject", "delete"].includes(action)) {
    throw new Error('Invalid action. Use "approve", "reject", or "delete".');
  }
  return action as "approve" | "reject" | "delete";
}

function readBodyReason(body: unknown): string | undefined {
  return isRecord(body) ? readOptionalString(body, "reason") : undefined;
}

function readAgentDeviceIds(body: unknown): string[] {
  if (!isRecord(body)) {
    throw new Error("Missing agent_device_ids.");
  }
  const rawIds = body.agent_device_ids;
  const ids = Array.isArray(rawIds)
    ? rawIds
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const singleId =
    readOptionalString(body, "agent_device_id") ??
    readOptionalString(body, "device_id");
  if (singleId) {
    ids.push(singleId);
  }
  const uniqueIds = [
    ...new Set(ids.map((id) => normalizeIdentityId(id) ?? id)),
  ];
  if (uniqueIds.length === 0) {
    throw new Error("Missing agent_device_ids.");
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

function readPositiveInteger(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
