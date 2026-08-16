import type { FastifyReply, FastifyRequest } from 'fastify';

export interface SecurityHeadersOptions {
  /** When true, also emit `Strict-Transport-Security`. */
  readonly tls: boolean;
}

const HSTS_VALUE = 'max-age=31536000';
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'self'";

/**
 * Build the `onSend` hook. Returns the payload unchanged so Fastify continues
 * the response pipeline with the headers applied.
 */
export function createSecurityHeadersHook(
  opts: SecurityHeadersOptions,
): (req: FastifyRequest, reply: FastifyReply, payload: unknown) => Promise<unknown> {
  return async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    if (opts.tls === true) {
      reply.header('Strict-Transport-Security', HSTS_VALUE);
    }
    return payload;
  };
}
