import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import type { AgentProbeEvent, AgentProbeProvider } from "@omniwork/protocol-ts";
import {
  normalizeClaudeHookPayload,
  type ClaudeHookPayload,
} from "./claudeHookNormalizer.ts";
import {
  normalizeCodexHookPayload,
  type CodexHookPayload,
} from "./codexHookNormalizer.ts";

export interface AgentHookReceiverOptions {
  host: string;
  port: number;
  token: string;
  maxBodyBytes?: number;
  onProbeEvent(event: AgentProbeEvent): void;
}

export class AgentHookReceiver {
  private readonly options: AgentHookReceiverOptions;
  private readonly server = createServer((request, response) => {
    this.handleRequest(request, response).catch(() => {
      this.writeJson(response, 500, { error: "internal_error" });
    });
  });

  constructor(options: AgentHookReceiverOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
  }

  close(): void {
    this.server.close();
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/healthz") {
      this.writeJson(response, 200, { ok: true });
      return;
    }
    if (request.method !== "POST") {
      this.writeJson(response, 404, { error: "not_found" });
      return;
    }
    if (!this.isAuthorized(request)) {
      this.writeJson(response, 401, { error: "unauthorized" });
      return;
    }

    const body = await this.readJsonBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      this.writeJson(response, 400, { error: "invalid_json" });
      return;
    }

    const provider = resolveProvider(url, body as Record<string, unknown>);
    if (!provider) {
      this.writeJson(response, 404, { error: "not_found" });
      return;
    }

    const event = normalizeHookPayload(provider, body as Record<string, unknown>);
    if (!event) {
      this.writeJson(response, 400, { error: "invalid_hook_payload" });
      return;
    }

    this.options.onProbeEvent(event);
    this.writeJson(response, 202, { accepted: true, event_id: event.id });
  }

  private isAuthorized(request: IncomingMessage): boolean {
    return request.headers.authorization === `Bearer ${this.options.token}`;
  }

  private async readJsonBody(
    request: IncomingMessage,
  ): Promise<unknown | null> {
    const chunks: Buffer[] = [];
    const maxBodyBytes = this.options.maxBodyBytes ?? 64 * 1024;
    let total = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBodyBytes) {
        return null;
      }
      chunks.push(buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return null;
    }
  }

  private writeJson(
    response: ServerResponse,
    statusCode: number,
    body: unknown,
  ): void {
    if (response.headersSent) {
      return;
    }
    response.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(`${JSON.stringify(body)}\n`);
  }
}

function resolveProvider(
  url: URL,
  body: Record<string, unknown>,
): AgentProbeProvider | null {
  if (url.pathname === "/api/probes/codex/hooks") {
    return "codex";
  }
  if (url.pathname === "/api/probes/claude-code/hooks") {
    return "claude-code";
  }
  if (url.pathname !== "/api/probes/hooks") {
    return null;
  }

  const source =
    readString(body.omniwork_hook_source) ??
    readString(url.searchParams.get("source"));
  if (source === "claude") {
    return "claude-code";
  }
  if (source === "codex" || source === "claude-code") {
    return source;
  }
  return null;
}

function normalizeHookPayload(
  provider: AgentProbeProvider,
  payload: Record<string, unknown>,
): AgentProbeEvent | null {
  if (provider === "codex") {
    return normalizeCodexHookPayload(payload as CodexHookPayload);
  }
  if (provider === "claude-code") {
    return normalizeClaudeHookPayload(payload as ClaudeHookPayload);
  }
  return null;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}
