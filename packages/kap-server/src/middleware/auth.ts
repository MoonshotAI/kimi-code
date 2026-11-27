import type { FastifyReply, FastifyRequest } from 'fastify';

import { errEnvelope } from '../envelope';
import type { IAuthTokenService } from '../services/auth/authTokenService';
import type { CredentialValidator } from '../services/auth/credentials';
import { MEDIA_SIGNATURE_QUERY_PARAM } from '../services/mediaSignature/constants';
import {
  AUTH_RATE_LIMIT_CODE,
  AUTH_RATE_LIMIT_MSG,
  type AuthFailureLimiter,
} from './rateLimit';

const AUTH_ERROR_CODE = 40101;
const AUTH_ERROR_MSG = 'Unauthorized';
const REDACTED = '[redacted]';
const BEARER_PREFIX = 'Bearer ';
const SIGNED_MEDIA_PATH_RE = /^\/api\/v1\/sessions\/[^/]+\/fs\/.+:download$/;

export interface AuthHookOptions {
  readonly isBypassed?: (req: FastifyRequest) => boolean;
  readonly limiter?: Pick<AuthFailureLimiter, 'recordFailure' | 'isBanned'>;
  readonly validateCredential?: CredentialValidator;
  readonly validateMediaSignature?: (candidate: string) => boolean;
}

function decodeRequestPath(rawUrl: string): string | null {
  const path = rawUrl.split('?', 1)[0] ?? rawUrl;
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

function defaultIsBypassed(req: FastifyRequest): boolean {
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

function querySignature(rawUrl: string): string | null {
  const queryIndex = rawUrl.indexOf('?');
  if (queryIndex < 0) return null;
  const value = new URLSearchParams(rawUrl.slice(queryIndex + 1)).get(MEDIA_SIGNATURE_QUERY_PARAM);
  return value === null || value.length === 0 ? null : value;
}

function isSignedMediaRequest(req: FastifyRequest): boolean {
  if (req.method !== 'GET') return false;
  const path = decodeRequestPath(req.url);
  return path !== null && SIGNED_MEDIA_PATH_RE.test(path);
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
      const validateSignature = opts?.validateMediaSignature;
      const signature = validateSignature !== undefined && isSignedMediaRequest(req)
        ? querySignature(req.url)
        : null;
      if (signature !== null && validateSignature !== undefined && validateSignature(signature)) {
        return;
      }
      if (signature === null) opts?.limiter?.recordFailure(req.ip);
      return reply.code(401).send(errEnvelope(AUTH_ERROR_CODE, AUTH_ERROR_MSG, req.id));
    }

    if (!(await validateCredential(token))) {
      opts?.limiter?.recordFailure(req.ip);
      return reply.code(401).send(errEnvelope(AUTH_ERROR_CODE, AUTH_ERROR_MSG, req.id));
    }
  };
}
