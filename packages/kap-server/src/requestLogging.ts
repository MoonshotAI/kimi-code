import type { FastifyInstance, FastifyReply } from 'fastify';

import { MEDIA_SIGNATURE_QUERY_PARAM } from './services/mediaSignature/constants';

function redactSignature(rawUrl: string): string {
  const queryIndex = rawUrl.indexOf('?');
  if (queryIndex < 0) return rawUrl;
  const params = new URLSearchParams(rawUrl.slice(queryIndex + 1));
  if (!params.has(MEDIA_SIGNATURE_QUERY_PARAM)) return rawUrl;
  params.set(MEDIA_SIGNATURE_QUERY_PARAM, '[redacted]');
  return `${rawUrl.slice(0, queryIndex)}?${params.toString()}`;
}

export function extractEnvelopeCode(payload: unknown): number | undefined {
  if (typeof payload !== 'string') {
    return undefined;
  }
  const match = /^\s*\{\s*"code"\s*:\s*(-?\d+)/.exec(payload);
  if (match === null) {
    return undefined;
  }
  const code = Number(match[1]);
  return Number.isSafeInteger(code) ? code : undefined;
}

export function registerRequestLogging(app: FastifyInstance): void {
  const codes = new WeakMap<FastifyReply, number>();

  app.addHook('onSend', (req, reply, payload, done) => {
    const code = extractEnvelopeCode(payload);
    if (code !== undefined) {
      codes.set(reply, code);
    }
    done(null, payload);
  });

  app.addHook('onResponse', (req, reply, done) => {
    req.log.info(
      {
        req: {
          method: req.method,
          url: redactSignature(req.url),
          version: req.headers['accept-version'],
          host: req.host,
          remoteAddress: req.ip,
          remotePort: req.socket === undefined ? undefined : req.socket.remotePort,
        },
        code: codes.get(reply),
        responseTime: reply.elapsedTime,
      },
      'request completed',
    );
    done();
  });
}
