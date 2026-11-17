import type { FastifyReply, FastifyRequest } from 'fastify';

import { errEnvelope } from '../envelope';
import {
  hasMinimumRole,
  type AccessPrincipal,
  type AccessRole,
} from '../services/auth/accessTokenStore';
import type { IAuthTokenService } from '../services/auth/authTokenService';
import type { CredentialValidator, PrincipalResolver } from '../services/auth/credentials';
import { ErrorCode } from '../protocol/error-codes';
import {
  AUTH_RATE_LIMIT_CODE,
  AUTH_RATE_LIMIT_MSG,
  type AuthFailureLimiter,
} from './rateLimit';

const AUTH_ERROR_CODE = 40101;
const AUTH_ERROR_MSG = 'Unauthorized';
const FORBIDDEN_MSG = 'Insufficient token permissions';
const REDACTED = '[redacted]';
const BEARER_PREFIX = 'Bearer ';
const PRINCIPAL_KEY = Symbol.for('kimi.kap.principal');

export function setRequestPrincipal(
  req: { [PRINCIPAL_KEY]?: AccessPrincipal },
  principal: AccessPrincipal,
): void {
  req[PRINCIPAL_KEY] = principal;
}

export function getRequestPrincipal(req: unknown): AccessPrincipal {
  if (typeof req === 'object' && req !== null && PRINCIPAL_KEY in req) {
    const p = (req as { [PRINCIPAL_KEY]?: AccessPrincipal })[PRINCIPAL_KEY];
    if (p !== undefined) return p;
  }
  return { role: 'owner' };
}

export function requireRole(
  minRole: AccessRole,
): (
  req: { id: string },
  reply: { code(status: number): { send(payload: unknown): unknown } },
) => Promise<unknown> {
  return async (req, reply) => {
    const principal = getRequestPrincipal(req);
    if (!hasMinimumRole(principal.role, minRole)) {
      return reply
        .code(403)
        .send(errEnvelope(ErrorCode.ACCESS_FORBIDDEN, FORBIDDEN_MSG, req.id));
    }
  };
}

export interface AuthHookOptions {
  readonly isBypassed?: (req: FastifyRequest) => boolean;
  readonly limiter?: Pick<AuthFailureLimiter, 'recordFailure' | 'isBanned'>;
  readonly validateCredential?: CredentialValidator;
  readonly resolvePrincipal?: PrincipalResolver;
}

function decodeRequestPath(rawUrl: string): string | null {
  const path = rawUrl.split('?', 1)[0] ?? rawUrl;
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

function isUnauthenticatedAccessRoute(method: string, path: string): boolean {
  if (method !== 'POST') return false;
  if (path === '/api/v1/access/requests') return true;
  return /^\/api\/v1\/access\/requests\/areq_[0-9A-HJKMNP-TV-Z]{26}:exchange$/.test(path);
}

export function defaultIsBypassed(req: FastifyRequest): boolean {
  if (req.method === 'OPTIONS') {
    return true;
  }
  const path = decodeRequestPath(req.url);
  if (path === null) {
    return false;
  }
  if (req.method === 'GET' && path === '/api/v1/healthz') {
    return true;
  }
  if (isUnauthenticatedAccessRoute(req.method, path)) {
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
  const resolvePrincipal: PrincipalResolver =
    opts?.resolvePrincipal ??
    (opts?.validateCredential !== undefined
      ? async (candidate) => ((await opts.validateCredential!(candidate)) ? { role: 'owner' } : null)
      : async (candidate) => ((await authTokenService.isValid(candidate)) ? { role: 'owner' } : null));

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

    const principal = await resolvePrincipal(token);
    if (principal === null) {
      opts?.limiter?.recordFailure(req.ip);
      return reply.code(401).send(errEnvelope(AUTH_ERROR_CODE, AUTH_ERROR_MSG, req.id));
    }

    setRequestPrincipal(req as unknown as { [PRINCIPAL_KEY]?: AccessPrincipal }, principal);
  };
}
