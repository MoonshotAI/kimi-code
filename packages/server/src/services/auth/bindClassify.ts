/**
 * Bind-address classification (ROADMAP M6.1).
 *
 * `classify(host)` buckets a bind host into the network exposure tier it
 * implies, so `start.ts` can decide which hardening to apply:
 *
 *   - `loopback` — only this host (`127.0.0.0/8`, `::1`, `localhost`). The
 *     token-only default; no public hardening required.
 *   - `lan` — RFC1918 private ranges (`10/8`, `172.16/12`, `192.168/16`) plus
 *     link-local (`169.254/16`, `fe80::/10`). Reachable from the local
 *     network; hardening is recommended but not all of it is mandatory.
 *   - `public` — everything else. Full D2 hardening (forced password, TLS
 *     opt-out, auth-failure rate limiting, dangerous-endpoint downgrade,
 *     security headers).
 *
 * Wildcard binds (`0.0.0.0`, `::`, empty) are treated as `public` by default —
 * a wildcard is reachable from anywhere the host is — unless the caller
 * explicitly relaxes the classification via `opts.bindClass: 'lan'`
 * (`--bind-class=lan`).
 */

import net from 'node:net';

export type BindClass = 'loopback' | 'lan' | 'public';

export interface ClassifyOptions {
  /** Override classification of wildcard binds (`0.0.0.0` / `::` / empty). */
  readonly bindClass?: 'lan' | 'public';
}

/** Convert a dotted-quad IPv4 literal to its unsigned 32-bit integer form. */
function ipv4ToInt(ip: string): number {
  const [a, b, c, d] = ip.split('.');
  return (
    (((Number(a) << 24) >>> 0) +
      ((Number(b) << 16) >>> 0) +
      ((Number(c) << 8) >>> 0) +
      (Number(d) >>> 0)) >>>
    0
  );
}

/** True when `ip` falls inside the IPv4 CIDR `base/prefix`. */
function ipv4InCidr(ip: string, base: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((ipv4ToInt(ip) & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
}

/**
 * Expand a (possibly `::`-compressed) IPv6 literal into 8 lowercase hextets.
 * Returns `null` when the shape is not a plain 8-group IPv6 address.
 */
function expandV6(host: string): readonly string[] | null {
  const lower = host.toLowerCase();
  if (lower.includes('::')) {
    const halves = lower.split('::');
    const leftRaw = halves[0] ?? '';
    const rightRaw = halves[1] ?? '';
    const left = leftRaw.length > 0 ? leftRaw.split(':') : [];
    const right = rightRaw.length > 0 ? rightRaw.split(':') : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    return [...left, ...Array<string>(missing).fill('0'), ...right];
  }
  const parts = lower.split(':');
  return parts.length === 8 ? parts : null;
}

/**
 * True when `host` is an IPv6 link-local address (`fe80::/10`).
 *
 * The first 10 bits are fixed (`1111111010`), so the leading hextet ranges
 * `0xfe80`–`0xfebf`. IPv4-mapped / compressed forms that do not expand to an
 * `fe80::/10` leading group return false.
 */
function isLinkLocalV6(host: string): boolean {
  const groups = expandV6(host);
  if (groups === null) return false;
  const first = Number.parseInt(groups[0] ?? '', 16);
  return first >= 0xfe80 && first <= 0xfebf;
}

/**
 * Classify a bind host by the network exposure it implies.
 *
 * See the module header for the tier definitions. A non-IP hostname that is
 * not `localhost` is treated conservatively as `public` — a DNS name could
 * resolve to a public address.
 */
export function classify(host: string, opts?: ClassifyOptions): BindClass {
  if (host === '' || host === '0.0.0.0' || host === '::') {
    return opts?.bindClass ?? 'public';
  }
  if (host === 'localhost') {
    return 'loopback';
  }
  const family = net.isIP(host);
  if (family === 4) {
    if (host.startsWith('127.')) return 'loopback';
    if (ipv4InCidr(host, '10.0.0.0', 8)) return 'lan';
    if (ipv4InCidr(host, '172.16.0.0', 12)) return 'lan';
    if (ipv4InCidr(host, '192.168.0.0', 16)) return 'lan';
    if (ipv4InCidr(host, '169.254.0.0', 16)) return 'lan';
    return 'public';
  }
  if (family === 6) {
    if (host.toLowerCase() === '::1') return 'loopback';
    if (isLinkLocalV6(host)) return 'lan';
    return 'public';
  }
  return 'public';
}
