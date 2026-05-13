import type { AgentCapability, RuntimeKind } from "../../../../packages/protocol-ts/src/index.ts";

export interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  readonly displayName: string;
  readonly capability: AgentCapability;
  buildTuiCommand(): string;
  defaultTitle(index: number): string;
}

export interface RuntimeRegistryOptions {
  codexCommand: string;
  claudeCommand: string;
}

export class RuntimeRegistry {
  private readonly adapters: Map<RuntimeKind, RuntimeAdapter>;
  private readonly defaultKind: RuntimeKind = "codex";

  constructor(options: RuntimeRegistryOptions) {
    const adapters = [
      new CliRuntimeAdapter("codex", "Codex", "codex.cli", options.codexCommand),
      new CliRuntimeAdapter("claude", "Claude", "claude.cli", options.claudeCommand),
    ];
    this.adapters = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
  }

  get(kind: RuntimeKind = this.defaultKind): RuntimeAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) {
      throw new Error(`Unsupported runtime: ${kind}`);
    }
    return adapter;
  }

  list(): RuntimeAdapter[] {
    return Array.from(this.adapters.values());
  }

  capabilities(): AgentCapability[] {
    return this.list().map((adapter) => adapter.capability);
  }
}

class CliRuntimeAdapter implements RuntimeAdapter {
  readonly kind: RuntimeKind;
  readonly displayName: string;
  readonly capability: AgentCapability;
  private readonly command: string;

  constructor(
    kind: RuntimeKind,
    displayName: string,
    capability: AgentCapability,
    command: string,
  ) {
    this.kind = kind;
    this.displayName = displayName;
    this.capability = capability;
    this.command = command;
  }

  buildTuiCommand(): string {
    return this.command;
  }

  defaultTitle(index: number): string {
    return `${this.displayName} ${index}`;
  }
}
