import {
  type AgentCapability,
  type TerminalProviderDefinition,
  type TerminalProviderKind,
} from "@omniwork/protocol-ts";

export interface TerminalProviderAdapter {
  readonly kind: TerminalProviderKind;
  readonly displayName: string;
  readonly capability: AgentCapability;
  readonly summary: string;
  buildTuiCommand(): string;
  defaultTitle(index: number): string;
}

export interface TerminalProviderRegistryOptions {
  providers: readonly TerminalProviderDefinition[];
}

export class TerminalProviderRegistry {
  private readonly adapters: Map<TerminalProviderKind, TerminalProviderAdapter>;
  private readonly defaultKind?: TerminalProviderKind;

  constructor(options: TerminalProviderRegistryOptions) {
    const adapters = options.providers
      .filter((provider) => provider.creatable)
      .map((provider) =>
        new CliTerminalProviderAdapter(
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

  get(kind?: TerminalProviderKind): TerminalProviderAdapter {
    const resolvedKind = kind ?? this.defaultKind;
    if (!resolvedKind) {
      throw new Error("No creatable terminal providers configured");
    }
    const adapter = this.adapters.get(resolvedKind);
    if (!adapter) {
      throw new Error(`Unsupported terminal provider: ${resolvedKind}`);
    }
    return adapter;
  }

  list(): TerminalProviderAdapter[] {
    return Array.from(this.adapters.values());
  }

  capabilities(): AgentCapability[] {
    return this.list().map((adapter) => adapter.capability);
  }

  providers(): TerminalProviderDefinition[] {
    return this.list().map((adapter) => ({
      kind: adapter.kind,
      displayName: adapter.displayName,
      capability: adapter.capability,
      summary: adapter.summary,
      defaultCommand: adapter.buildTuiCommand(),
      creatable: true,
    }));
  }

  infer(command?: string): TerminalProviderAdapter | undefined {
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

class CliTerminalProviderAdapter implements TerminalProviderAdapter {
  readonly kind: TerminalProviderKind;
  readonly displayName: string;
  readonly capability: AgentCapability;
  readonly summary: string;
  private readonly command: string;

  constructor(
    kind: TerminalProviderKind,
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
