import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_REDIRECTS = 5;
const BLOCKED_MESSAGE = "Local network URLs are not allowed";

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function mappedIPv4(ip: string): string | null {
  const dotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateIPv4(ip);
  const v6 = ip.toLowerCase();
  const v4 = mappedIPv4(v6);
  if (v4) return isPrivateIPv4(v4);
  return (
    v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)
  );
}

function parseHttpUrl(input: string): URL {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are supported");
  }
  return url;
}

/** 校验目标解析后不指向内网 */
export async function assertPublicUrl(input: string | URL): Promise<URL> {
  const url = typeof input === "string" ? parseHttpUrl(input) : input;
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are supported");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    throw new Error(BLOCKED_MESSAGE);
  }

  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((entry) => entry.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error(BLOCKED_MESSAGE);
  }
  return url;
}

/** 逐跳校验重定向的 fetch */
export async function fetchPublic(
  input: string,
  init: RequestInit,
): Promise<Response> {
  let current = await assertPublicUrl(input);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await fetch(current, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      return response;
    }
    await response.body?.cancel();
    current = await assertPublicUrl(new URL(location, current));
  }
  throw new Error("Too many redirects");
}

/** 浏览器子请求用的放行判断，按主机缓存 */
export function createPublicUrlChecker(): (input: string) => Promise<boolean> {
  const cache = new Map<string, Promise<boolean>>();
  return (input) => {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return Promise.resolve(false);
    }
    if (url.protocol === "data:" || url.protocol === "blob:") {
      return Promise.resolve(true);
    }
    const key = `${url.protocol}//${url.host}`;
    let result = cache.get(key);
    if (!result) {
      result = assertPublicUrl(url).then(
        () => true,
        () => false,
      );
      cache.set(key, result);
    }
    return result;
  };
}
