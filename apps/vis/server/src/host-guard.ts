import type { Context, Next } from 'hono';

import { isLoopbackHost } from './config';

/** Extract the hostname (without port) from a Host header or URL authority.
 *  Handles IPv6 bracket form (`[::1]:3001`), bare IPv6 literals (`2001:db8::1`),
 *  and `host:port`. Returns null for empty/missing input.
 *
 *  A malformed authority is returned verbatim (lowercased) rather than coerced,
 *  so it fails every allow check instead of being silently reduced to a value
 *  that looks allowed (e.g. `[::1]evil.com` must not become `::1`). */
export function hostnameFromAuthority(authority: string | undefined | null): string | null {
  if (authority === undefined || authority === null) return null;
  const trimmed = authority.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end < 0) return trimmed.toLowerCase(); // unterminated bracket → cannot match
    const rest = trimmed.slice(end + 1);
    // After the closing bracket only an empty string or `:port` is valid; any
    // other trailing text means the authority is malformed — don't let the
    // bracketed prefix masquerade as the real host.
    if (rest.length > 0 && !/^:\d+$/u.test(rest)) return trimmed.toLowerCase();
    return trimmed.slice(1, end).toLowerCase();
  }
  const firstColon = trimmed.indexOf(':');
  if (firstColon < 0) return trimmed.toLowerCase();
  // An unbracketed authority with more than one colon is a bare IPv6 literal
  // with no port (a port requires bracket form), so the whole string is the
  // host. A single colon is an ordinary `host:port`.
  if (trimmed.includes(':', firstColon + 1)) return trimmed.toLowerCase();
  return trimmed.slice(0, firstColon).toLowerCase();
}

/** Wildcard bind addresses (`0.0.0.0`, `::`) mean "every interface" and never
 *  appear as a concrete client's Host, so they cannot serve as a match target. */
function isWildcardHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '0:0:0:0:0:0:0:0';
}

function parseAllowedHosts(raw: string | undefined): ReadonlySet<string> {
  const set = new Set<string>();
  if (raw === undefined) return set;
  for (const part of raw.split(',')) {
    const h = hostnameFromAuthority(part);
    if (h !== null) set.add(h);
  }
  return set;
}

/** Decide whether a single request hostname is one we expect to serve. Loopback
 *  names are always allowed (a DNS-rebinding attacker cannot forge a loopback
 *  Host from a browser). Otherwise the hostname must match the configured bind
 *  host or an explicit allow-list entry. */
function hostnameAllowed(
  hostname: string,
  normalizedBindHost: string,
  allowedHosts: ReadonlySet<string>,
): boolean {
  if (isLoopbackHost(hostname)) return true;
  if (allowedHosts.has(hostname)) return true;
  if (normalizedBindHost.length > 0 && hostname === normalizedBindHost) return true;
  return false;
}

export interface HostGuardOptions {
  /** The host the server is bound to (e.g. resolveHost()). */
  readonly bindHost: string;
  /** Raw comma-separated VIS_ALLOWED_HOSTS value, if any. */
  readonly allowedHosts?: string;
}

/** Hono middleware that rejects requests whose Host header / URL authority is
 *  neither a loopback name nor an explicitly allowed host.
 *
 *  This is a DNS-rebinding defense for the *no-token loopback* mode: the vis
 *  server binds to loopback by default and serves no auth token there, so
 *  without this check any web page the user visits could rebind its own
 *  hostname to 127.0.0.1 and read or delete the user's local agent sessions
 *  cross-origin. A browser performing that attack still sends the *original*
 *  attacker hostname in the Host header, which will not match a loopback name
 *  or the configured bind host. When an auth token is configured the token is
 *  the access control — a rebinding attacker cannot read it cross-origin — so
 *  this guard is not installed in that mode (see createApp), which keeps LAN /
 *  wildcard binds working without listing every reachable host. */
export function hostGuard(options: HostGuardOptions) {
  const allowedHosts = parseAllowedHosts(options.allowedHosts);
  const bindHost = hostnameFromAuthority(options.bindHost) ?? '';
  const normalizedBindHost = isWildcardHost(bindHost) ? '' : bindHost;

  return async (c: Context, next: Next): Promise<Response | void> => {
    // Collect every hostname the request claims. In @hono/node-server the URL
    // authority is built from the client's Host header, so both reflect what a
    // rebinding attacker controls; require all present hostnames to be allowed.
    const hostnames: string[] = [];
    try {
      const fromUrl = hostnameFromAuthority(new URL(c.req.url).host);
      if (fromUrl !== null) hostnames.push(fromUrl);
    } catch {
      // ignore unparseable URL; fall back to the Host header below
    }
    const fromHeader = hostnameFromAuthority(c.req.header('host'));
    if (fromHeader !== null) hostnames.push(fromHeader);

    const ok =
      hostnames.length > 0 &&
      hostnames.every((h) => hostnameAllowed(h, normalizedBindHost, allowedHosts));
    if (!ok) {
      return c.json(
        {
          error:
            'forbidden host: request Host is not loopback, the configured bind host, or in VIS_ALLOWED_HOSTS',
          code: 'FORBIDDEN_HOST',
        },
        403,
      );
    }
    await next();
  };
}
