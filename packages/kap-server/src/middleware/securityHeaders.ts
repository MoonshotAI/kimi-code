import type { FastifyReply, FastifyRequest } from 'fastify';

export interface SecurityHeadersOptions {
  readonly tls: boolean;
}

const HSTS_VALUE = 'max-age=31536000';

function buildContentSecurityPolicy(env: NodeJS.ProcessEnv): string {
  const extra = (env['KIMI_CODE_FRAME_ANCESTORS'] ?? '')
    .split(/\s+/)
    .filter((source) => source.length > 0);
  const frameAncestors = ["'self'", 'vscode-webview:', ...extra].join(' ');
  return `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors ${frameAncestors}`;
}

export function createSecurityHeadersHook(
  opts: SecurityHeadersOptions,
): (req: FastifyRequest, reply: FastifyReply, payload: unknown) => Promise<unknown> {
  const contentSecurityPolicy = buildContentSecurityPolicy(process.env);
  return async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', contentSecurityPolicy);
    if (opts.tls === true) {
      reply.header('Strict-Transport-Security', HSTS_VALUE);
    }
    return payload;
  };
}
