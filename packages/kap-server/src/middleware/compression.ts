import { gzipSync } from 'node:zlib';

import type { FastifyInstance, FastifyReply } from 'fastify';

const MIN_COMPRESSIBLE_BYTES = 1024;
const COMPRESSIBLE_TYPES = new Set([
  'application/json',
  'application/javascript',
  'application/xml',
  'image/svg+xml',
]);
const UNCOMPRESSED_STATUS = new Set([204, 206, 304]);
const GZIP_LEVEL = 1;

export function acceptsGzipEncoding(acceptEncoding: string | string[] | undefined): boolean {
  if (acceptEncoding === undefined) return false;
  const value = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding;
  let wildcard = false;
  for (const token of value.split(',')) {
    const [encoding, ...params] = token.trim().toLowerCase().split(';');
    if (encoding !== 'gzip' && encoding !== '*') continue;
    const quality = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
    const acceptable = quality === undefined || Number(quality.slice(2)) > 0;
    if (encoding === 'gzip') return acceptable;
    wildcard = wildcard || acceptable;
  }
  return wildcard;
}

export function isGzipCompressibleType(contentType: unknown): boolean {
  if (typeof contentType !== 'string') return false;
  const mime = contentType.split(';', 1)[0]!.trim().toLowerCase();
  return mime.startsWith('text/') || COMPRESSIBLE_TYPES.has(mime);
}

function mergeVary(existing: unknown): string {
  if (typeof existing !== 'string' || existing.length === 0) return 'Accept-Encoding';
  const tokens = new Set(existing.split(',').map((token) => token.trim().toLowerCase()));
  if (tokens.has('*') || tokens.has('accept-encoding')) return existing;
  return `${existing}, Accept-Encoding`;
}

function compressibleBody(reply: FastifyReply, payload: unknown): Buffer | undefined {
  if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return undefined;
  if (UNCOMPRESSED_STATUS.has(reply.statusCode)) return undefined;
  if (reply.getHeader('content-encoding') !== undefined) return undefined;
  if (!isGzipCompressibleType(reply.getHeader('content-type'))) return undefined;
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return body.length < MIN_COMPRESSIBLE_BYTES ? undefined : body;
}

export function registerResponseCompression(app: FastifyInstance): void {
  app.addHook('onSend', (req, reply, payload, done) => {
    const body = compressibleBody(reply, payload);
    if (body === undefined) {
      done(null, payload);
      return;
    }
    reply.header('Vary', mergeVary(reply.getHeader('vary')));
    if (!acceptsGzipEncoding(req.headers['accept-encoding'])) {
      done(null, payload);
      return;
    }
    const compressed = gzipSync(body, { level: GZIP_LEVEL });
    reply.header('Content-Encoding', 'gzip');
    reply.header('Content-Length', String(compressed.length));
    done(null, compressed);
  });
}
