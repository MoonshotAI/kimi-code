/**
 * Global HTTP bearer-auth hook (ROADMAP M2.2).
 *
 * `createAuthHook` builds a Fastify `onRequest` hook that requires a valid
 * `Authorization: Bearer <token>` on every non-bypassed route. It is NOT wired
 * into `start.ts` in M2 — that happens in M5.1. Until then it is exercised in
 * isolation via tests on a minimal Fastify app.
 *
 * 401 responses use the reserved daemon code `40101`
 * (`packages/protocol/src/error-codes.ts` intentionally omits it; the protocol
 * package is left untouched). `errEnvelope(code: number, …)` accepts a plain
 * number, so the literal is passed directly.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { errEnvelope } from '#/envelope';
import {
  AUTH_RATE_LIMIT_CODE,
  AUTH_RATE_LIMIT_MSG,
  type AuthFailureLimiter,
} from '#/middleware/rateLimit';
import type { IAuthTokenService } from '#/services/auth/authTokenService';

/** Daemon-reserved unauthorized code (not in the protocol `ErrorCode` enum). */
const AUTH_ERROR_CODE = 40101;
const AUTH_ERROR_MSG = 'Unauthorized';
const REDACTED = '[redacted]';
const BEARER_PREFIX = 'Bearer ';

export interface AuthHookOptions {
  /** Return true to skip auth for this request (bypass whitelist). */
  readonly isBypassed?: (req: FastifyRequest) => boolean;
  /**
   * Optional per-source auth-failure limiter (ROADMAP M6.4). When present, a
   * banned source is rejected with `429` before auth runs, and each failed
   * attempt is recorded. Wired only on non-loopback binds from `start.ts`.
   */
  readonly limiter?: Pick<AuthFailureLimiter, 'recordFailure' | 'isBanned'>;
}

/**
 * Default bypass policy — the security boundary.
 *
 * Bypassed (no token required):
 *   - every `OPTIONS` request (CORS preflight);
 *   - `GET /api/v1/healthz` (liveness probe for supervisors / load balancers);
 *   - static web assets, defined as any path that does NOT start with `/api/`
 *     AND is not one of the meta documents `/openapi.json` / `/asyncapi.json`.
 *
 * NOT bypassed (token required): all `/api/…` routes plus `/openapi.json` and
 * `/asyncapi.json` (the meta documents leak the API shape, so they stay gated).
 */
function defaultIsBypassed(req: FastifyRequest): boolean {
  if (req.method === 'OPTIONS') {
    return true;
  }
  const path = req.url.split('?', 1)[0] ?? req.url;
  if (req.method === 'GET' && path === '/api/v1/healthz') {
    return true;
  }
  const isApi = path.startsWith('/api/');
  const isMeta = path === '/openapi.json' || path === '/asyncapi.json';
  return !isApi && !isMeta;
}

/**
 * Extract the bearer token from the raw `Authorization` header.
 *
 * Returns `null` when the header is missing, lacks the case-sensitive
 * `Bearer ` prefix, or carries an empty token — all treated as 401.
 */
function extractBearer(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length);
  return token.length === 0 ? null : token;
}

/**
 * Build the global `onRequest` auth hook.
 *
 * Order inside the hook matters: the raw token is extracted first, then the
 * header view is redacted for downstream request logging (`start.ts` logs
 * requests), and only then is the candidate validated — so auth still sees the
 * real token while logs never do. Returning the `reply` from the async hook
 * short-circuits Fastify on 401 (the route handler never runs).
 */
export function createAuthHook(
  authTokenService: IAuthTokenService,
  opts?: AuthHookOptions,
): (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void> {
  const isBypassed = opts?.isBypassed ?? defaultIsBypassed;

  return async (req, reply) => {
    // Rate-limit check (ROADMAP M6.4): a banned source is rejected before any
    // auth work — even a valid token cannot bypass an active ban. Loopback
    // binds pass no limiter, so this branch is a no-op there.
    if (opts?.limiter?.isBanned(req.ip) === true) {
      return reply
        .code(429)
        .send(errEnvelope(AUTH_RATE_LIMIT_CODE, AUTH_RATE_LIMIT_MSG, req.id));
    }

    const header = req.headers.authorization;
    const token = extractBearer(header);

    // Redact the header view BEFORE the rest of the pipeline logs the request.
    // Auth has already consumed the raw value above, so this only affects the
    // downstream log view of the request.
    if (header !== undefined) {
      req.headers.authorization = REDACTED;
    }

    if (isBypassed(req)) {
      return;
    }

    if (token === null) {
      opts?.limiter?.recordFailure(req.ip);
      return reply
        .code(401)
        .send(errEnvelope(AUTH_ERROR_CODE, AUTH_ERROR_MSG, req.id));
    }

    if (!(await authTokenService.isValid(token))) {
      opts?.limiter?.recordFailure(req.ip);
      return reply
        .code(401)
        .send(errEnvelope(AUTH_ERROR_CODE, AUTH_ERROR_MSG, req.id));
    }
  };
}
