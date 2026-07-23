import assert from "node:assert/strict";
import test from "node:test";

import type {
  TerminalProviderDefinition,
  TerminalSession,
  WorkspaceDefinition,
} from "@omni-work/protocol-ts";
import {
  EMPTY_PROVIDER_PREFERENCES,
  getProviderPreferencesStorageKey,
  normalizeProviderPreferences,
  orderProviders,
  parseProviderPreferences,
} from "../src/screens/workbench/providerPreferences.ts";
import {
  findSessionWorkspace,
  formatCompactPath,
  getCloseActionLabel,
  getWorkspaceDisplayName,
  getWorkspaceTabs,
  groupSessionsByProvider,
  groupSessionsByWorkspace,
  isPathInside,
  UNASSIGNED_WORKSPACE_PATH,
} from "../src/screens/workbench/workbenchModel.ts";
import type { TerminalProviderGroup } from "../src/screens/workbench/workbenchTypes.ts";

const providers: TerminalProviderDefinition[] = [
  provider("codex", "Codex"),
  provider("claude", "Claude"),
  provider("terminal", "Terminal"),
];

const gitWorkspace: WorkspaceDefinition = {
  name: "Repo",
  path: "/Users/alice/repo",
  isGitRepository: true,
  status: "available",
  source: "default",
};

const nestedWorkspace: WorkspaceDefinition = {
  name: "Nested",
  path: "/Users/alice/repo/packages/app",
  isGitRepository: false,
  status: "available",
  source: "session",
};

function provider(kind: string, displayName: string): TerminalProviderDefinition {
  return {
    kind,
    displayName,
    capability: `${kind}.cli`,
    summary: `${displayName} summary`,
    defaultCommand: kind,
    creatable: true,
  };
}

function session(overrides: Partial<TerminalSession>): TerminalSession {
  return {
    session_id: overrides.session_id ?? "sess-1",
    primary_surface_id: `surface_${overrides.session_id ?? "sess-1"}_terminal`,
    surfaces: [],
    terminal_provider_kind: overrides.terminal_provider_kind ?? "codex",
    terminal_provider_label: overrides.terminal_provider_label ?? "Codex",
    title: overrides.title ?? "Session",
    cwd: overrides.cwd ?? "/Users/alice/repo",
    command: overrides.command ?? "codex",
    status: overrides.status ?? "running",
    created_at: overrides.created_at ?? new Date(0).toISOString(),
    last_active_at: overrides.last_active_at ?? new Date(0).toISOString(),
    terminal_size: overrides.terminal_size ?? { cols: 80, rows: 24 },
    tmux_session_name: overrides.tmux_session_name ?? "omni-sess-1",
    ...overrides,
  };
}

test("provider preferences parse, normalize, and preserve stable order", () => {
  assert.deepEqual(parseProviderPreferences(null), EMPTY_PROVIDER_PREFERENCES);
  assert.deepEqual(parseProviderPreferences("{not-json"), EMPTY_PROVIDER_PREFERENCES);

  assert.deepEqual(
    parseProviderPreferences(
      JSON.stringify({
        hiddenKinds: ["codex", "", 4],
        orderedKinds: ["terminal", "claude", false],
        defaultKind: "claude",
      }),
    ),
    {
      hiddenKinds: ["codex"],
      orderedKinds: ["terminal", "claude"],
      defaultKind: "claude",
    },
  );

  assert.deepEqual(
    normalizeProviderPreferences(
      {
        hiddenKinds: ["codex", "missing"],
        orderedKinds: ["terminal", "missing", "claude"],
        defaultKind: "codex",
      },
      providers,
    ),
    {
      hiddenKinds: ["codex"],
      orderedKinds: ["terminal", "claude"],
      defaultKind: undefined,
    },
  );

  assert.deepEqual(
    orderProviders(providers, ["terminal", "codex"]).map((item) => item.kind),
    ["terminal", "codex", "claude"],
  );
  assert.equal(
    getProviderPreferencesStorageKey("device-1"),
    "omniwork.session.providerPreferences.device-1",
  );
  assert.equal(
    getProviderPreferencesStorageKey(""),
    "omniwork.session.providerPreferences.default",
  );
});

test("workspace helpers resolve exact, nested, and unassigned sessions", () => {
  const exact = session({
    session_id: "exact",
    cwd: "/tmp/elsewhere",
    workspace_path: gitWorkspace.path,
  });
  const nested = session({
    session_id: "nested",
    cwd: "/Users/alice/repo/packages/app/src",
  });
  const unassigned = session({
    session_id: "unassigned",
    cwd: "/var/tmp",
    workspace_name: "Detached",
    git_repository: true,
  });
  const workspaces = [gitWorkspace, nestedWorkspace];

  assert.equal(findSessionWorkspace(exact, workspaces), gitWorkspace);
  assert.equal(findSessionWorkspace(nested, workspaces), nestedWorkspace);

  const fallback = findSessionWorkspace(unassigned, workspaces);
  assert.equal(fallback.path, UNASSIGNED_WORKSPACE_PATH);
  assert.equal(fallback.name, "Detached");
  assert.equal(fallback.isGitRepository, true);

  assert.equal(isPathInside("/Users/alice/repo", "/Users/alice/repo"), true);
  assert.equal(isPathInside("/Users/alice/repo/src", "/Users/alice/repo"), true);
  assert.equal(isPathInside("/Users/alice/repo-old", "/Users/alice/repo"), false);
});

test("session grouping keeps workspace and provider buckets deterministic", () => {
  const sessions = [
    session({ session_id: "nested", cwd: "/Users/alice/repo/packages/app/src" }),
    session({ session_id: "root", cwd: "/Users/alice/repo", terminal_provider_kind: "claude" }),
    session({ session_id: "unknown", cwd: "/Users/alice/repo", terminal_provider_kind: "custom" }),
  ];
  const groups = groupSessionsByWorkspace(sessions, [gitWorkspace, nestedWorkspace]);

  assert.deepEqual(
    groups.map((group) => [group.workspace.path, group.sessions.map((item) => item.session_id)]),
    [
      [nestedWorkspace.path, ["nested"]],
      [gitWorkspace.path, ["root", "unknown"]],
    ],
  );

  const providerGroups: TerminalProviderGroup[] = [
    { kind: "codex", label: "Codex", summary: "Codex", creatable: true },
    { kind: "claude", label: "Claude", summary: "Claude", creatable: true },
    { kind: "terminal", label: "Terminal", summary: "Terminal", creatable: true, hidden: true },
    { kind: "other", label: "Other", summary: "Other", creatable: true },
  ];

  assert.deepEqual(
    groupSessionsByProvider(sessions, providerGroups, providers).map((group) => [
      group.kind,
      group.sessions.map((item) => item.session_id),
    ]),
    [
      ["codex", ["nested"]],
      ["claude", ["root"]],
      ["other", ["unknown"]],
    ],
  );
});

test("presentation helpers preserve labels and compact paths", () => {
  assert.deepEqual(getWorkspaceTabs(gitWorkspace), ["sessions", "git", "files"]);
  assert.deepEqual(getWorkspaceTabs(nestedWorkspace), ["sessions", "files"]);
  assert.equal(getWorkspaceDisplayName({ ...gitWorkspace, name: "" }), "repo");
  assert.equal(formatCompactPath("/Users/alice/repo/packages/app"), "/Users/.../app");
  assert.equal(formatCompactPath("relative/path"), "relative/path");
  assert.equal(
    getCloseActionLabel(session({ status: "running" }), (key) => key),
    "workspaces.actions.closeSession",
  );
  assert.equal(
    getCloseActionLabel(session({ status: "exited" }), (key) => key),
    "workspaces.actions.remove",
  );
});
