import { createReadStream, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';

import type { FastifyReply, FastifyRequest } from 'fastify';

interface WebAssetRouteHost {
  get(
    path: string,
    handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  ): unknown;
}

interface StaticFile {
  path: string;
  stats: Stats;
}

interface EncodedVariant extends StaticFile {
  encoding: string;
  etagSuffix: string;
}

const COMPRESSIBLE_EXTENSIONS = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.svg',
  '.json',
  '.map',
  '.wasm',
  '.txt',
]);

const PRECOMPRESSED_ENCODINGS = [
  { encoding: 'br', extension: '.br', etagSuffix: '-br' },
  { encoding: 'gzip', extension: '.gz', etagSuffix: '-gz' },
];

export async function registerWebAssetRoutes(
  app: WebAssetRouteHost,
  assetsDir: string,
): Promise<void> {
  await assertWebAssets(assetsDir);

  app.get('/', async (req, reply) => serveWebAsset(req, reply, assetsDir));
  app.get('/*', async (req, reply) => serveWebAsset(req, reply, assetsDir));
}

async function assertWebAssets(assetsDir: string): Promise<void> {
  try {
    const info = await stat(join(assetsDir, 'index.html'));
    if (!info.isFile()) {
      throw new Error('index.html is not a file');
    }
  } catch {
    throw new Error(
      `Kimi web assets were not found at ${assetsDir}. Run the package build before starting the server.`,
    );
  }
}

async function serveWebAsset(
  req: FastifyRequest,
  reply: FastifyReply,
  assetsDir: string,
): Promise<unknown> {
  const requestUrl = new URL(req.url, 'http://kimi-web.local');
  if (isReservedPath(requestUrl.pathname)) {
    return reply.callNotFound();
  }

  const file = await resolveStaticFile(assetsDir, requestUrl.pathname);
  if (file === undefined) {
    return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
  }

  const compressible = COMPRESSIBLE_EXTENSIONS.has(extname(file.path));
  const variant = compressible
    ? await findEncodedVariant(file, headerValue(req.headers['accept-encoding']))
    : undefined;
  const source = variant ?? file;
  const etag = weakEtag(source.stats, variant?.etagSuffix ?? '');

  reply.header('ETag', etag).header('Cache-Control', cacheControl(assetsDir, file.path));
  if (compressible) {
    reply.header('Vary', 'Accept-Encoding');
  }
  if (matchesIfNoneMatch(headerValue(req.headers['if-none-match']), etag)) {
    return reply.code(304).send();
  }

  reply
    .type(mimeType(file.path))
    .header('Last-Modified', source.stats.mtime.toUTCString())
    .header('Content-Length', String(source.stats.size));
  if (variant !== undefined) {
    reply.header('Content-Encoding', variant.encoding);
  }
  return reply.send(createReadStream(source.path));
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(',') : value;
}

async function findEncodedVariant(
  file: StaticFile,
  acceptEncoding: string | undefined,
): Promise<EncodedVariant | undefined> {
  if (acceptEncoding === undefined) {
    return undefined;
  }
  const accepted = parseAcceptEncoding(acceptEncoding);
  const candidates = PRECOMPRESSED_ENCODINGS.map((candidate) => ({
    candidate,
    weight: encodingWeight(accepted, candidate.encoding),
  }))
    .filter(({ weight }) => weight > 0)
    .toSorted((a, b) => b.weight - a.weight);
  for (const { candidate } of candidates) {
    const path = `${file.path}${candidate.extension}`;
    const stats = await stat(path).catch(() => undefined);
    if (stats?.isFile() === true && stats.mtimeMs >= file.stats.mtimeMs) {
      return { path, stats, encoding: candidate.encoding, etagSuffix: candidate.etagSuffix };
    }
  }
  return undefined;
}

function parseAcceptEncoding(header: string): Map<string, number> {
  const weights = new Map<string, number>();
  for (const entry of header.split(',')) {
    const [name = '', ...params] = entry.trim().split(';');
    const coding = name.trim().toLowerCase();
    if (coding === '') {
      continue;
    }
    const qParam = params.map((p) => p.trim()).find((p) => p.toLowerCase().startsWith('q='));
    const q = qParam === undefined ? 1 : Number.parseFloat(qParam.slice(2));
    weights.set(coding, Number.isNaN(q) ? 0 : q);
  }
  return weights;
}

function encodingWeight(weights: Map<string, number>, encoding: string): number {
  return weights.get(encoding) ?? weights.get('*') ?? 0;
}

function weakEtag(stats: Stats, suffix: string): string {
  return `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}${suffix}"`;
}

function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }
  const opaque = stripWeakPrefix(etag);
  return header.split(',').some((tag) => {
    const trimmed = tag.trim();
    return trimmed === '*' || stripWeakPrefix(trimmed) === opaque;
  });
}

function stripWeakPrefix(tag: string): string {
  return tag.startsWith('W/') ? tag.slice(2) : tag;
}

function cacheControl(assetsDir: string, filePath: string): string {
  const assetPath = relative(assetsDir, filePath);
  const fileName = filePath.slice(filePath.lastIndexOf(sep) + 1);
  if (assetPath.startsWith(`assets${sep}`) && /[-.][A-Za-z0-9_-]{8}\.[^.]+$/.test(fileName)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
}

async function resolveStaticFile(
  assetsDir: string,
  pathname: string,
): Promise<StaticFile | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }

  const normalized = normalize(decoded).replace(/^(\.\.(?:[/\\]|$))+/, '');
  const relative = normalized === sep ? 'index.html' : normalized.replace(/^[/\\]/, '');
  const root = resolve(assetsDir);
  const candidate = resolve(
    root,
    relative.endsWith(sep) ? join(relative, 'index.html') : relative,
  );
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    return undefined;
  }

  const stats = await stat(candidate).catch(() => undefined);
  if (stats?.isFile() === true) {
    return { path: candidate, stats };
  }
  if (extname(pathname) !== '') {
    return undefined;
  }
  const indexPath = join(root, 'index.html');
  const indexStats = await stat(indexPath).catch(() => undefined);
  if (indexStats?.isFile() !== true) {
    return undefined;
  }
  return { path: indexPath, stats: indexStats };
}

function isReservedPath(pathname: string): boolean {
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/documentation' ||
    pathname.startsWith('/documentation/')
  );
}

function mimeType(filePath: string): string {
  switch (extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
    case '.map':
      return 'application/json; charset=utf-8';
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    case '.woff2':
      return 'font/woff2';
    case '.woff':
      return 'font/woff';
    case '.ttf':
      return 'font/ttf';
    case '.wasm':
      return 'application/wasm';
    case '.riv':
      return 'application/octet-stream';
    default:
      return 'application/octet-stream';
  }
}
