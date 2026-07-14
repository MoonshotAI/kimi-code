/**
 * Security response headers (ROADMAP M6.6).
 *
 * `createSecurityHeadersHook` builds a Fastify `onSend` hook that stamps a
 * small set of defensive headers on every response once the server is exposed
 * beyond loopback. Wired from `start.ts` only on non-loopback binds so the
 * loopback default keeps its lean response headers.
 *
 * Headers:
 *   - `X-Content-Type-Options: nosniff` — stop MIME sniffing.
 *   - `Referrer-Policy: no-referrer` — never leak the URL to third parties.
 *   - `Content-Security-Policy` — the bundled Web UI is same-origin. Images
 *     additionally allow `data:` for persisted base64 content and `blob:` for
 *     local attachment previews and authenticated media responses.
 *   - `Strict-Transport-Security` — ONLY when `opts.tls === true`. In this
 *     phase TLS is terminated by a reverse proxy (Caddy/nginx), so `start.ts`
 *     passes `tls: false` and HSTS is omitted here; the proxy is responsible
 *     for setting HSTS.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

export interface SecurityHeadersOptions {
  /** When true, also emit `Strict-Transport-Security`. */
  readonly tls: boolean;
}

const HSTS_VALUE = 'max-age=31536000';
const CONTENT_SECURITY_POLICY = "default-src 'self'; img-src 'self' data: blob:";

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
