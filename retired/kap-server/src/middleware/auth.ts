/**
 * Global HTTP bearer-auth hook.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { errEnvelope } from '../envelope';
import type { IAuthTokenService } from '../services/auth/authTokenService';
import type { CredentialValidator } from '../services/auth/credentials';
import {
  AUTH_RATE_LIMIT_CODE,
  AUTH_RATE_LIMIT_MSG,
  type AuthFailureLimiter,
} from './rateLimit';

const AUTH_ERROR_CODE = 40101;
const AUTH_ERROR_MSG = 'Unauthorized';
const REDACTED = '[redacted]';
const BEARER_PREFIX = 'Bearer ';

export interface AuthHookOptions {
  readonly isBypassed?: (req: FastifyRequest) => boolean;
  readonly limiter?: Pick<AuthFailureLimiter, 'recordFailure' | 'isBanned'>;
  /**
   * Unified credential validator. Defaults to `authTokenService.isValid`
   * (persistent token / password). `start.ts` supplies one that also accepts
   * the optional `rpcToken` so the same credential gates every surface.
   */
  readonly validateCredential?: CredentialValidator;
}

/**
 * Decode the request path the same way the router does before matching.
 *
 * `req.url` is the raw, still percent-encoded URL, while find-my-way matches
 * routes against the decoded path — so a raw `/%61pi/…` reaches the `/api/…`
 * handlers. Checking the decoded path keeps the auth decision aligned with
 * routing. Returns `null` when the path cannot be decoded, in which case the
 * caller must fail closed.
 */
function decodeRequestPath(rawUrl: string): string | null {
  const path = rawUrl.split('?', 1)[0] ?? rawUrl;
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
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
 * NOT bypassed (token required): every `/api/…` route — including the
 * `/api/v1/debug` RPC surface — plus `/openapi.json` and `/asyncapi.json` (the meta
 * documents leak the API shape, so they stay gated). One persistent bearer
 * token protects them all.
 */
function defaultIsBypassed(req: FastifyRequest): boolean {
  if (req.method === 'OPTIONS') {
    return true;
  }
  const path = decodeRequestPath(req.url);
  if (path === null) {
    // Fail closed: an undecodable path must never skip authentication.
    return false;
  }
  if (req.method === 'GET' && path === '/api/v1/healthz') {
    return true;
  }
  const isApi = path.startsWith('/api/');
  const isMeta = path === '/openapi.json' || path === '/asyncapi.json';
  return !isApi && !isMeta;
}

function extractBearer(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length);
  return token.length === 0 ? null : token;
}

export function createAuthHook(
  authTokenService: IAuthTokenService,
  opts?: AuthHookOptions,
): (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | void> {
  const isBypassed = opts?.isBypassed ?? defaultIsBypassed;
  const validateCredential: CredentialValidator =
    opts?.validateCredential ?? ((candidate) => authTokenService.isValid(candidate));

  return async (req, reply) => {
    if (opts?.limiter?.isBanned(req.ip) === true) {
      return reply.code(429).send(errEnvelope(AUTH_RATE_LIMIT_CODE, AUTH_RATE_LIMIT_MSG, req.id));
    }

    const header = req.headers.authorization;
    const token = extractBearer(header);

    if (isBypassed(req)) {
      return;
    }

    if (header !== undefined) {
      req.headers.authorization = REDACTED;
    }

    if (token === null) {
      opts?.limiter?.recordFailure(req.ip);
      return reply.code(401).send(errEnvelope(AUTH_ERROR_CODE, AUTH_ERROR_MSG, req.id));
    }

    if (!(await validateCredential(token))) {
      opts?.limiter?.recordFailure(req.ip);
      return reply.code(401).send(errEnvelope(AUTH_ERROR_CODE, AUTH_ERROR_MSG, req.id));
    }
  };
}
