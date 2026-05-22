import {
  PAIRING_LINK_HOST,
  PAIRING_LINK_SCHEME,
} from "../../../../packages/protocol-ts/src/index.ts";

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
  // 优先级：?pairing=<encoded link> > #...?pairing=<encoded link> > 裸 query 中的 pairing 字段。
  // 加 hashchange 监听是为了兼容 HashRouter / SPA hash 路由场景。
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
    return `${PAIRING_LINK_SCHEME}://${PAIRING_LINK_HOST}${query.startsWith("?") ? query : `?${query}`}`;
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
  // 仅检查 pairing link 必填的三个字段；`v` 由协议层 parsePairingLink 兜底校验，
  // 这里保持宽松以便接受 v 缺省的旧版（协议层会拒绝 v 不匹配的入参）。
  const params = new URLSearchParams(query.startsWith("?") ? query : `?${query}`);
  return Boolean(
    params.get("relay_url") && params.get("device_id") && params.get("key"),
  );
}
