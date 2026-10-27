import type { IncomingMessage } from 'node:http';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import {
  extractBearer,
  extractWsBearer,
  initializeAuth,
  _ALLOWED_HOSTS,
  _DISABLE_HOST_CHECK,
  type HttpAuthOptions,
  type HttpAuthRuntime,
  type HttpAuthTokenService,
} from './auth';
import { ErrorCode, requestId } from './route/http';
import { classify } from './security/bind-classify';
import {
  formatHostErrorMessage,
  isAllowedHost,
  type HostCheckOptions,
} from './security/hostnames';
import { isOriginAllowed } from './security/origin';
import { createAuthFailureLimiter, type AuthFailureLimiter } from './security/rate-limit';
import { applySecurityHeaders } from './security/security-headers';

const REDACTED = '[redacted]';

interface HttpSecurityRuntime extends HttpAuthRuntime {
  readonly exposureClass: ReturnType<typeof classify>;
  readonly hostOptions: HostCheckOptions;
  readonly allowedOrigins: readonly string[];
  readonly limiter?: AuthFailureLimiter;
}

export interface HttpSecurity {
  readonly hostMiddleware: RequestHandler;
  readonly authMiddleware: RequestHandler;
  readonly authTokenService: HttpAuthTokenService | undefined;
  listen(host: string): Promise<void>;
  authorizeUpgrade(request: IncomingMessage): Promise<number | null>;
  close(): void;
}

export interface HttpSecurityOptions extends HttpAuthOptions {
  readonly now: () => number;
}

export function createHttpSecurity(options: HttpSecurityOptions): HttpSecurity {
  let runtime: HttpSecurityRuntime | undefined;
  const apiPrefixes = (options.apiPrefixes ?? ['/api/']).map(apiPrefix);
  const healthPath = options.healthPath ?? '/api/v1/healthz';

  return {
    hostMiddleware: (request: Request, response: Response, next: NextFunction): void => {
      if (runtime === undefined) {
        next(new Error('HTTP host validation is not initialized'));
        return;
      }
      if (runtime.exposureClass !== 'loopback') applySecurityHeaders(response, false);
      if (!isAllowedHost(request.headers.host, runtime.hostOptions)) {
        sendHostError(request, response);
        return;
      }
      next();
    },
    authMiddleware: async (request: Request, response: Response, next: NextFunction): Promise<void> => {
      if (options.disableAuth === true) {
        next();
        return;
      }
      const ip = request.ip ?? request.socket.remoteAddress ?? '';
      if (runtime?.limiter?.isBanned(ip) === true) {
        sendAuthRateLimit(request, response);
        return;
      }
      if (isBypassed(request, apiPrefixes, healthPath)) {
        next();
        return;
      }
      if (runtime === undefined) {
        next(new Error('HTTP authentication is not initialized'));
        return;
      }
      const header = request.headers.authorization;
      const candidate = extractBearer(header);
      if (header !== undefined) request.headers.authorization = REDACTED;
      if (candidate === null) {
        runtime.limiter?.recordFailure(ip);
        sendUnauthorized(request, response);
        return;
      }
      if (!(await runtime.validateCredential(candidate))) {
        runtime.limiter?.recordFailure(ip);
        sendUnauthorized(request, response);
        return;
      }
      next();
    },
    get authTokenService() {
      return runtime?.service ?? options.authTokenService;
    },
    async listen(host) {
      const auth = await initializeAuth(options);
      const exposureClass = classify(host, { bindClass: options.bindClass });
      runtime = {
        ...auth,
        exposureClass,
        hostOptions: {
          boundHost: host,
          extra: options.ALLOWED_HOSTS ?? _ALLOWED_HOSTS,
          disable: options.DISABLE_HOST_CHECK ?? _DISABLE_HOST_CHECK,
        },
        allowedOrigins: options.corsOrigins ?? [],
        limiter: exposureClass === 'loopback' ? undefined : createAuthFailureLimiter({ now: options.now }),
      };
    },
    async authorizeUpgrade(request) {
      if (runtime === undefined) return 401;
      if (!isAllowedHost(request.headers.host, runtime.hostOptions)) return 403;
      const origin = Array.isArray(request.headers.origin)
        ? request.headers.origin[0]
        : request.headers.origin;
      if (origin !== undefined && !isOriginAllowed(origin, request.headers.host, runtime.allowedOrigins)) {
        return 403;
      }
      if (options.disableAuth === true) return null;
      const candidate =
        extractBearer(request.headers.authorization) ??
        extractWsBearer(request.headers['sec-websocket-protocol']);
      if (candidate === null) return 401;
      try {
        return (await runtime.validateCredential(candidate)) ? null : 401;
      } catch {
        return 401;
      }
    },
    close() {
      runtime?.limiter?.dispose();
      runtime = undefined;
    },
  };
}

function isBypassed(request: Request, apiPrefixes: readonly string[], healthPath: string): boolean {
  if (request.method === 'OPTIONS') return true;
  const path = decodeRequestPath(request.url);
  if (path === null) return false;
  if (request.method === 'GET' && path === healthPath) return true;
  if (path === '/openapi.json') return false;
  return !apiPrefixes.some((prefix) => path.startsWith(prefix));
}

function decodeRequestPath(rawUrl: string): string | null {
  const path = rawUrl.split('?', 1)[0] ?? rawUrl;
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

function apiPrefix(prefix: string): string {
  return `${prefix.replace(/\/+$/, '')}/`;
}

function sendHostError(request: Request, response: Response): void {
  response.status(403).json({
    code: ErrorCode.INVALID_HOST,
    msg: formatHostErrorMessage(request.headers.host),
    data: null,
    request_id: requestId(request),
  });
}

function sendUnauthorized(request: Request, response: Response): void {
  response.status(401).json({
    code: ErrorCode.UNAUTHORIZED,
    msg: 'Unauthorized',
    data: null,
    request_id: requestId(request),
  });
}

function sendAuthRateLimit(request: Request, response: Response): void {
  response.status(429).json({
    code: ErrorCode.AUTH_RATE_LIMIT,
    msg: 'Too many failed auth attempts',
    data: null,
    request_id: requestId(request),
  });
}
