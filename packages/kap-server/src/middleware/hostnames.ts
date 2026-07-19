/**
 * Host-header allowlist middleware (ROADMAP M4.1).
 *
 * `createHostCheck` builds a Fastify `onRequest` hook that rejects requests
 * whose `Host` header is not in the allowlist with a `403 Invalid Host header`
 * envelope. This is the primary DNS-rebinding defence once the server is
 * reachable beyond localhost (PLAN §3.4).
 *
 * Default-allow set (no configuration required):
 *   - `localhost`, `*.localhost` (any subdomain of `localhost`);
 *   - `127.0.0.1`, `::1`, `[::1]`;
 *   - any literal IP (`net.isIP(host) !== 0`);
 *   - the host the server actually bound to (`boundHost`);
 *   - caller-supplied extras (`extra`), where a leading `.` matches the bare
 *     domain and any subdomain (e.g. `.example.com` matches `example.com` and
 *     `a.example.com`).
 *
 * The default set is intentionally permissive for loopback/IP access so that
 * `app.inject` (default `Host: localhost:80`) and real `fetch` to
 * `127.0.0.1:<port>` keep working — existing HTTP/WS tests rely on this.
 *
 * 403 responses use the reserved daemon code `40301`
 * (`packages/protocol/src/error-codes.ts` intentionally omits it; the protocol
 * package is left untouched). `errEnvelope(code: number, …)` accepts a plain
 * number, so the literal is passed directly.
 */

import net from 'node:net';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { errEnvelope } from '../envelope';

/** Daemon-reserved "invalid Host" code (not in the protocol `ErrorCode` enum). */
const HOST_ERROR_CODE = 40301;

export interface HostCheckOptions {
  /** The host the server bound to; always allowed (port stripped both sides). */
  readonly boundHost?: string;
  /** Extra allowed hosts / domain-suffix patterns (from `KIMI_CODE_ALLOWED_HOSTS`). */
  readonly extra?: readonly string[];
  /** Disable the check entirely (`KIMI_CODE_DISABLE_HOST_CHECK=1`; test-only). */
  readonly disable?: boolean;
}

/** Returned by {@link createHostCheck}: the Fastify hook plus the raw predicate. */
export interface HostCheck {
  /** Fastify `onRequest` hook that 403s on a disallowed `Host`. */
  readonly onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void>;
  /** Reusable predicate (also used by the WS upgrade path in M4.3). */
  readonly isAllowed: (host: string | undefined) => boolean;
}

/**
 * Parse `KIMI_CODE_ALLOWED_HOSTS` into an `extra` allowlist.
 *
 * Comma-separated, trimmed, empties dropped. A leading `.` is preserved so the
 * caller can express domain-suffix wildcards (`.example.com`).
 */
export function parseAllowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env['KIMI_CODE_ALLOWED_HOSTS'];
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** True when `KIMI_CODE_DISABLE_HOST_CHECK=1` (test/controlled env only). */
export function isHostCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['KIMI_CODE_DISABLE_HOST_CHECK'] === '1';
}

/**
 * Strip a trailing `:port` from a `Host` value and lowercase it.
 *
 * Handles:
 *   - bracketed IPv6 with a port: `[::1]:80` → `[::1]`;
 *   - host/IPv4 with a port: `localhost:80` → `localhost`, `1.2.3.4:5678` → `1.2.3.4`;
 *   - bare values (no port): returned lowercased as-is;
 *   - bare IPv6 without brackets (multiple colons, e.g. `::1`): returned
 *     lowercased as-is — there is no unambiguous port to strip.
 */
export function stripPort(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return (end === -1 ? host : host.slice(0, end + 1)).toLowerCase();
  }
  const firstColon = host.indexOf(':');
  if (firstColon === -1) {
    return host.toLowerCase();
  }
  const lastColon = host.lastIndexOf(':');
  if (firstColon === lastColon) {
    const after = host.slice(lastColon + 1);
    if (after.length > 0 && /^\d+$/.test(after)) {
      return host.slice(0, lastColon).toLowerCase();
    }
  }
  // Multiple colons (bare IPv6) or a non-digit suffix — no port to strip.
  return host.toLowerCase();
}

export function formatHostErrorMessage(host: string | undefined): string {
  const normalizedHost = host === undefined || host.length === 0 ? undefined : stripPort(host);
  const hostLabel = normalizedHost ?? '<missing>';
  const hostArg = normalizedHost ?? '<host>';
  return `Invalid Host header: ${hostLabel}; allow this host with KIMI_CODE_ALLOWED_HOSTS=${hostArg} or 'kimi web --allowed-host ${hostArg}'.`;
}

/**
 * Decide whether a `Host` value is allowed under the given options.
 *
 * Missing/empty `Host` is rejected (HTTP/1.1 requires it). The check is a no-op
 * when `opts.disable` is set.
 */
export function isAllowedHost(host: string | undefined, opts: HostCheckOptions): boolean {
  if (opts.disable === true) {
    return true;
  }
  if (host === undefined || host.length === 0) {
    return false;
  }
  const h = stripPort(host);

  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') {
    return true;
  }
  if (h.endsWith('.localhost')) {
    return true;
  }
  if (net.isIP(h) !== 0) {
    return true;
  }
  if (opts.boundHost !== undefined && h === stripPort(opts.boundHost)) {
    return true;
  }
  if (opts.extra !== undefined) {
    for (const entry of opts.extra) {
      if (entry.startsWith('.')) {
        const base = entry.slice(1);
        if (h === base || h.endsWith(entry)) {
          return true;
        }
      } else if (h === entry) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Build the Fastify `onRequest` hook and the reusable `isAllowed` predicate.
 *
 * Returning the `reply` from the hook short-circuits Fastify on 403 so the
 * route handler never runs.
 */
export function createHostCheck(opts: HostCheckOptions): HostCheck {
  const isAllowed = (host: string | undefined): boolean => isAllowedHost(host, opts);
  const onRequest = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | void> => {
    if (!isAllowed(req.headers.host)) {
      return reply.code(403).send(errEnvelope(HOST_ERROR_CODE, formatHostErrorMessage(req.headers.host), req.id));
    }
  };
  return { onRequest, isAllowed };
}
