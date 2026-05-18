import {
  type AgentCapability,
  type AgentProviderDefinition,
  type RuntimeKind,
} from "../../../../packages/protocol-ts/src/index.ts";

export interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  readonly displayName: string;
  readonly capability: AgentCapability;
  readonly summary: string;
  buildTuiCommand(): string;
  defaultTitle(index: number): string;
}

export interface RuntimeRegistryOptions {
  providers: readonly AgentProviderDefinition[];
}

export class RuntimeRegistry {
  private readonly adapters: Map<RuntimeKind, RuntimeAdapter>;
  private readonly defaultKind?: RuntimeKind;

  constructor(options: RuntimeRegistryOptions) {
    const adapters = options.providers
      .filter((provider) => provider.creatable)
      .map((provider) =>
        new CliRuntimeAdapter(
          provider.kind,
          provider.displayName,
          provider.capability,
          provider.defaultCommand,
          provider.summary,
        ),
      );
    this.adapters = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
    this.defaultKind = adapters[0]?.kind;
  }

  get(kind?: RuntimeKind): RuntimeAdapter {
    const resolvedKind = kind ?? this.defaultKind;
    if (!resolvedKind) {
      throw new Error("No creatable agent providers configured");
    }
    const adapter = this.adapters.get(resolvedKind);
    if (!adapter) {
      throw new Error(`Unsupported runtime: ${resolvedKind}`);
    }
    return adapter;
  }

  list(): RuntimeAdapter[] {
    return Array.from(this.adapters.values());
  }

  capabilities(): AgentCapability[] {
    return this.list().map((adapter) => adapter.capability);
  }

  providers(): AgentProviderDefinition[] {
    return this.list().map((adapter) => ({
      kind: adapter.kind,
      displayName: adapter.displayName,
      capability: adapter.capability,
      summary: adapter.summary,
      defaultCommand: adapter.buildTuiCommand(),
      creatable: true,
    }));
  }

  infer(command?: string): RuntimeAdapter | undefined {
    const normalizedCommand = command?.toLowerCase() ?? "";
    if (!normalizedCommand) {
      return undefined;
    }

    return this.list().find((adapter) =>
      [
        adapter.kind,
        adapter.displayName,
        adapter.buildTuiCommand().split(/\s+/)[0] ?? "",
      ].some((value) => normalizedCommand.includes(value.toLowerCase())),
    );
  }
}

class CliRuntimeAdapter implements RuntimeAdapter {
  readonly kind: RuntimeKind;
  readonly displayName: string;
  readonly capability: AgentCapability;
  readonly summary: string;
  private readonly command: string;

  constructor(
    kind: RuntimeKind,
    displayName: string,
    capability: AgentCapability,
    command: string,
    summary = `${displayName} CLI TUI session`,
  ) {
    this.kind = kind;
    this.displayName = displayName;
    this.capability = capability;
    this.command = command;
    this.summary = summary;
  }

  buildTuiCommand(): string {
    return this.command;
  }

  defaultTitle(index: number): string {
    return `${this.displayName} ${index}`;
  }
}
