import type { TerminalProviderDefinition } from "@omniwork/protocol-ts";

export type ProviderPreferences = {
  hiddenKinds: string[];
  orderedKinds: string[];
  defaultKind?: string;
};

export const EMPTY_PROVIDER_PREFERENCES: ProviderPreferences = {
  hiddenKinds: [],
  orderedKinds: [],
};

const PROVIDER_PREFERENCES_STORAGE_PREFIX =
  "omniwork.session.providerPreferences";

export function getProviderPreferencesStorageKey(scope: string): string {
  return `${PROVIDER_PREFERENCES_STORAGE_PREFIX}.${scope || "default"}`;
}

export function parseProviderPreferences(value: string | null): ProviderPreferences {
  if (!value) {
    return EMPTY_PROVIDER_PREFERENCES;
  }

  try {
    const parsed = JSON.parse(value) as Partial<ProviderPreferences>;
    return {
      hiddenKinds: Array.isArray(parsed.hiddenKinds)
        ? parsed.hiddenKinds.filter(isNonEmptyString)
        : [],
      orderedKinds: Array.isArray(parsed.orderedKinds)
        ? parsed.orderedKinds.filter(isNonEmptyString)
        : [],
      defaultKind: isNonEmptyString(parsed.defaultKind)
        ? parsed.defaultKind
        : undefined,
    };
  } catch {
    return EMPTY_PROVIDER_PREFERENCES;
  }
}

export function normalizeProviderPreferences(
  preferences: ProviderPreferences,
  providers: readonly TerminalProviderDefinition[],
): ProviderPreferences {
  const providerKinds = new Set(providers.map((provider) => provider.kind));
  const hiddenKinds = preferences.hiddenKinds.filter((kind) =>
    providerKinds.has(kind),
  );
  const orderedKinds = preferences.orderedKinds.filter((kind) =>
    providerKinds.has(kind),
  );
  const defaultKind =
    preferences.defaultKind &&
    providerKinds.has(preferences.defaultKind) &&
    !hiddenKinds.includes(preferences.defaultKind)
      ? preferences.defaultKind
      : undefined;

  return {
    hiddenKinds,
    orderedKinds,
    defaultKind,
  };
}

export function orderProviders(
  providers: readonly TerminalProviderDefinition[],
  orderedKinds: readonly string[],
): TerminalProviderDefinition[] {
  const priority = new Map(
    orderedKinds.map((kind, index) => [kind, index] as const),
  );

  return [...providers].sort((left, right) => {
    const leftPriority = priority.get(left.kind) ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = priority.get(right.kind) ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return providers.indexOf(left) - providers.indexOf(right);
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
