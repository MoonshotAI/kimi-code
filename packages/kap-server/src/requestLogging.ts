import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * Pull the envelope `code` out of a serialized JSON response body.
 *
 * Returns `undefined` for non-string payloads (buffers, streams) and for bodies
 * that are not envelopes (e.g. `/openapi.json`, static assets) — those simply
 * log without a `code` field.
 */
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

/**
 * Register the `onSend` + `onResponse` hooks that emit the access log line.
 *
 * The `onResponse` line mirrors Fastify's default shape (reqId via the child
 * logger, `req`, `responseTime`, `msg: 'request completed'`) but swaps
 * `res.statusCode` for the envelope `code`.
 */
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
          url: req.url,
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
