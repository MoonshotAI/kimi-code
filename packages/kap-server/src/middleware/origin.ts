/**
 * Origin / CORS middleware (ROADMAP M4.2).
 *
 * HTTP `onRequest` hook:
 *   - no `Origin` header → non-CORS / same-origin request → proceeds untouched;
 *   - same-origin (`Origin` host === `Host`, port stripped both sides) → allowed;
 *   - cross-origin → allowed only if the full origin (scheme + host) is in the
 *     explicit whitelist (`KIMI_CODE_CORS_ORIGINS`, no `*` wildcard — PLAN
 *     §3.4). Allowed origins get `Access-Control-Allow-Origin/-Methods` echoed
 *     and `Access-Control-Allow-Headers` reflected from the preflight's
 *     `Access-Control-Request-Headers` (so new client headers need no server
 *     change); `OPTIONS` preflight short-circuits to `204`;
 *   - cross-origin and NOT whitelisted → no CORS headers are emitted, so the
 *     browser blocks the response. `OPTIONS` still returns `204` (without CORS
 *     headers) so the preflight fails closed.
 *
 * `isOriginAllowed` is also exported for the WS upgrade path (M4.3). There,
 * absent/malformed `Origin` is treated as allowed (non-browser Node `ws`
 * clients send no `Origin`); a present-but-disallowed browser Origin is
 * rejected. See M4.3 for the deliberate present-only deviation.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { stripPort } from './hostnames';

const CORS_ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const CORS_ALLOW_HEADERS = 'Content-Type, Authorization, X-Kimi-Client-Id, X-Kimi-Client-Name, X-Kimi-Client-Version, X-Kimi-Client-Ui-Mode';

export interface OriginHookOptions {
  /** Explicit cross-origin allowlist (full origin strings, scheme + host). */
  readonly allowedOrigins?: readonly string[];
}

/**
 * Parse `KIMI_CODE_CORS_ORIGINS` into an allowlist.
 *
 * Comma-separated, trimmed, empties dropped. No `*` wildcard — every entry is
 * an explicit origin (PLAN §3.4).
 */
export function parseCorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env['KIMI_CODE_CORS_ORIGINS'];
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Return the `host` (host[:port], default port dropped) of an `Origin` value,
 * or `undefined` when the origin is missing or malformed.
 */
export function originHost(origin: string | undefined): string | undefined {
  if (origin === undefined) {
    return undefined;
  }
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
}

/**
 * Decide whether an `Origin` is allowed for a request to `host`.
 *
 *   - missing/malformed `Origin` → allowed (non-CORS / non-browser client);
 *   - same-origin (`Origin` host === `Host`, port stripped both sides) → allowed;
 *   - otherwise → allowed only when the full origin string is in `allowed`.
 */
export function isOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowed: readonly string[],
): boolean {
  const oh = originHost(origin);
  if (oh === undefined) {
    return true;
  }
  const ohStripped = stripPort(oh);
  if (host !== undefined) {
    const hostStripped = stripPort(host);
    if (ohStripped === hostStripped) {
      return true;
    }
    // Dev-proxy case: a browser hitting a same-machine dev server (e.g. Vite on
    // `localhost:5175`) whose upstream server is bound to a different loopback
    // name (e.g. `127.0.0.1:58627`). The two are not string-equal, but both ends
    // are loopback, so there is no real cross-origin threat — treat as
    // same-origin so WebSocket upgrades are not rejected with 403.
    if (isLoopbackHost(ohStripped) && isLoopbackHost(hostStripped)) {
      return true;
    }
  }
  // `origin` is defined here (originHost returned a host), so the whitelist
  // match is against the full origin string (scheme + host).
  return allowed.includes(origin as string);
}

/** Loopback-only host names, mirroring the allowlist in `hostnames.ts`. */
function isLoopbackHost(h: string): boolean {
  return (
    h === 'localhost' ||
    h === '::1' ||
    h === '[::1]' ||
    h.startsWith('127.') ||
    h.endsWith('.localhost')
  );
}

/**
 * Build the Fastify `onRequest` CORS hook.
 *
 * Allowed origins get `Access-Control-Allow-Origin/-Methods` echoed and
 * `Access-Control-Allow-Headers` reflected from the preflight's
 * `Access-Control-Request-Headers` (falling back to `CORS_ALLOW_HEADERS` for
 * non-preflight responses), so newly added client request headers do not
 * require a matching server-side allowlist change; `OPTIONS` preflights
 * short-circuit to `204`. Disallowed origins get no CORS headers (the browser
 * blocks the response); their `OPTIONS` preflight still returns `204` so it
 * fails closed without leaking headers.
 */
export function createOriginHook(
  opts: OriginHookOptions,
): (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void> {
  const allowed = opts.allowedOrigins ?? [];
  return async (req, reply) => {
    const origin = req.headers.origin;
    if (origin === undefined) {
      return;
    }
    if (isOriginAllowed(origin, req.headers.host, allowed)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Allow-Methods', CORS_ALLOW_METHODS);
      reply.header(
        'Access-Control-Allow-Headers',
        req.headers['access-control-request-headers'] ?? CORS_ALLOW_HEADERS,
      );
      reply.header('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        return reply.code(204).send();
      }
      return;
    }
    // Origin present but not allowed: emit no CORS headers so the browser
    // blocks the response. Short-circuit the preflight to fail closed.
    if (req.method === 'OPTIONS') {
      return reply.code(204).send();
    }
  };
}
