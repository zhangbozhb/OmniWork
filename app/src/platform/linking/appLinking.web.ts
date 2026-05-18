export interface AppLinkSubscription {
  remove(): void;
}

export async function getInitialAppUrl(): Promise<string | null> {
  return getCurrentAppUrl();
}

export function addAppUrlListener(
  handler: (url: string) => void,
): AppLinkSubscription {
  const listener = () => {
    const url = getCurrentAppUrl();
    if (url) {
      handler(url);
    }
  };
  window.addEventListener("popstate", listener);
  window.addEventListener("hashchange", listener);

  return {
    remove() {
      window.removeEventListener("popstate", listener);
      window.removeEventListener("hashchange", listener);
    },
  };
}

export async function openSystemSettings(): Promise<void> {
  throw new Error("System settings are not available on web.");
}

function getCurrentAppUrl(): string | null {
  const directLink = getSearchParam(window.location.search, "pairing");
  if (directLink) {
    return directLink;
  }

  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const hashQuery = hash.includes("?") ? hash.slice(hash.indexOf("?")) : hash;
  const hashLink = getSearchParam(hashQuery, "pairing");
  if (hashLink) {
    return hashLink;
  }

  const query = window.location.search || hashQuery;
  if (hasPairingParams(query)) {
    return `omniwork://pair${query.startsWith("?") ? query : `?${query}`}`;
  }

  return null;
}

function getSearchParam(query: string, key: string): string | null {
  if (!query) {
    return null;
  }

  const params = new URLSearchParams(query.startsWith("?") ? query : `?${query}`);
  return params.get(key);
}

function hasPairingParams(query: string): boolean {
  const params = new URLSearchParams(query.startsWith("?") ? query : `?${query}`);
  return Boolean(
    params.get("relay_url") && params.get("device_id") && params.get("key"),
  );
}
