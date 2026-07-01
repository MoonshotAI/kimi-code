/**
 * Security response headers for non-loopback exposure.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

export interface SecurityHeadersOptions {
  readonly tls: boolean;
}

const HSTS_VALUE = 'max-age=31536000';

export function createSecurityHeadersHook(
  opts: SecurityHeadersOptions,
): (req: FastifyRequest, reply: FastifyReply, payload: unknown) => Promise<unknown> {
  return async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'");
    if (opts.tls === true) {
      reply.header('Strict-Transport-Security', HSTS_VALUE);
    }
    return payload;
  };
}
