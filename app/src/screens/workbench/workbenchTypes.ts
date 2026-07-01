import type {
  AgentCapability,
  TerminalProviderKind,
} from "@omniwork/protocol-ts";

export type CreatableTerminalProviderKind = TerminalProviderKind;
export type WorkspaceTab = "sessions" | "git" | "files";

export type TerminalProviderGroup = {
  kind: TerminalProviderKind;
  label: string;
  summary: string;
  capability?: AgentCapability;
  creatable: boolean;
  hidden?: boolean;
  default?: boolean;
};
