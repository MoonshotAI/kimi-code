/**
 * Origin / CORS allowlist middleware.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { stripPort } from './hostnames';

const CORS_ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const CORS_ALLOW_HEADERS = 'Content-Type, Authorization';

export interface OriginHookOptions {
  readonly allowedOrigins?: readonly string[];
}

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

export function isOriginAllowed(
  origin: string | undefined,
  host: string | undefined,
  allowed: readonly string[],
): boolean {
  const oh = originHost(origin);
  if (oh === undefined) {
    return true;
  }
  if (host !== undefined && stripPort(oh) === stripPort(host)) {
    return true;
  }
  return allowed.includes(origin as string);
}

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
      reply.header('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
      reply.header('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        return reply.code(204).send();
      }
      return;
    }
    if (req.method === 'OPTIONS') {
      return reply.code(204).send();
    }
  };
}
