// Network safety for the brand pass (plain ESM). The page
// and every URL it points at are untrusted: only http(s) on the standard ports, and never a host that is, or
// resolves to, a private, loopback, link-local, CGNAT, multicast or cloud-metadata address. Downloads follow
// redirects by hand, each hop checked again; headless Chrome's own requests (the page, its redirects and every
// subresource) go through the same check with request interception.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UnsafeUrlError extends Error {}

/** All addresses of a host. Tests may pass their own. */
export const systemLookup = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

function v4Private(ip) {
  const [a, b, c] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 198 && (b === 18 || b === 19));
}

/** True for any address this tool must not reach on a page's behalf (IPv4, IPv6, mapped forms). */
export function isPrivateAddress(address) {
  const ip = String(address).replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  const family = isIP(ip);
  if (family === 4) return v4Private(ip);
  if (family !== 6) return true;
  if (ip === "::" || ip === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return v4Private(mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(ip)) return true;
  const first = parseInt(ip.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

/** Shape only (no DNS): http(s), standard port, no credentials, not a private name or IP literal. Throws UnsafeUrlError. */
export function assertSafeShape(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { throw new UnsafeUrlError("not a URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError("not an http(s) link");
  if (url.port && url.port !== "80" && url.port !== "443") throw new UnsafeUrlError("not a standard web port");
  if (url.username || url.password) throw new UnsafeUrlError("credentials in the link");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host === "metadata.google.internal") throw new UnsafeUrlError("private host");
  if (isIP(host) && isPrivateAddress(host)) throw new UnsafeUrlError("private address");
  return url;
}

/**
 * A checker with a per-host cache (one DNS lookup per host per job): resolves to the URL, or throws UnsafeUrlError.
 * `lookup` null checks the shape only.
 */
export function makeGuard(lookup = systemLookup) {
  const hosts = new Map();
  return async function check(raw) {
    const url = assertSafeShape(raw);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!lookup || isIP(host)) return url;
    if (!hosts.has(host)) {
      hosts.set(host, (async () => {
        let addresses;
        try { addresses = await lookup(host); } catch { return "the host does not resolve"; }
        return !addresses.length || addresses.some(isPrivateAddress) ? "private address" : null;
      })());
    }
    const problem = await hosts.get(host);
    if (problem) throw new UnsafeUrlError(problem);
    return url;
  };
}

/** fetch with every hop checked (redirects followed by hand, max 5). */
export async function safeFetch(raw, init = {}, { guard = makeGuard(), fetchImpl = fetch, maxRedirects = 5 } = {}) {
  let current = String(raw);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await guard(current);
    const response = await fetchImpl(current, { ...init, redirect: "manual" });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) return response;
    await response.body?.cancel().catch(() => undefined);
    current = new URL(location, current).href;
  }
  throw new UnsafeUrlError("too many redirects");
}

/**
 * Puts a page behind the guard: every request Chrome makes (navigation, redirects, subresources) is checked first;
 * data: and blob: pass, anything else unsafe is aborted. Call before page.goto.
 */
export async function guardPage(page, guard = makeGuard()) {
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.isInterceptResolutionHandled?.()) return;
    const url = request.url();
    if (/^(data|blob):/i.test(url)) { request.continue().catch(() => undefined); return; }
    guard(url).then(() => request.continue(), () => request.abort("blockedbyclient")).catch(() => undefined);
  });
}
