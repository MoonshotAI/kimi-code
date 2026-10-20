import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';

import type { Request, Response } from 'express';

import { useHttpRoute } from '../scope';
import { ErrorCode, sendErr } from '../route/http';

export interface WebAssetOptions {
  readonly assetsDir: string;
  readonly prefix: string;
}

export function useWebAssetRoutes(options: WebAssetOptions): void {
  useHttpRoute({
    id: 'web.assets.root',
    method: 'GET',
    path: '/',
    handler: (request, response) => serveWebAsset(request, response, options),
  });

  useHttpRoute({
    id: 'web.assets.splat',
    method: 'GET',
    path: '/{*splat}',
    handler: (request, response) => serveWebAsset(request, response, options),
  });
}

async function serveWebAsset(request: Request, response: Response, options: WebAssetOptions): Promise<void> {
  const pathname = request.path;
  if (isReservedPath(pathname, options.prefix)) {
    sendErr(request, response, ErrorCode.ROUTE_NOT_FOUND, `route ${request.method} ${pathname} not found`);
    return;
  }
  const filePath = await resolveStaticFile(options.assetsDir, pathname);
  const fileInfo = filePath === undefined ? undefined : await stat(filePath).catch(() => undefined);
  if (filePath === undefined || fileInfo === undefined || !fileInfo.isFile()) {
    response.status(404).type('text/plain; charset=utf-8').send('Not found');
    return;
  }
  response.status(200);
  response.setHeader('content-type', mimeType(filePath));
  response.setHeader('cache-control', cacheControl(options.assetsDir, filePath));
  response.setHeader('content-length', fileInfo.size);
  createReadStream(filePath).pipe(response);
}

function isReservedPath(pathname: string, prefix: string): boolean {
  const base = prefix.replace(/\/+$/, '');
  return pathname === base || pathname.startsWith(`${base}/`);
}

async function resolveStaticFile(assetsDir: string, pathname: string): Promise<string | undefined> {
  const normalized = normalize(pathname).replace(/^(\.\.(?:[/\\]|$))+/, '');
  const rel = normalized === sep ? 'index.html' : normalized.replace(/^[/\\]/, '');
  const root = resolve(assetsDir);
  const candidate = resolve(root, rel.endsWith(sep) ? join(rel, 'index.html') : rel);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    return undefined;
  }
  const info = await stat(candidate).catch(() => undefined);
  if (info?.isFile() === true) {
    return candidate;
  }
  if (extname(pathname) !== '') {
    return undefined;
  }
  return join(root, 'index.html');
}

function cacheControl(assetsDir: string, filePath: string): string {
  const assetPath = relative(assetsDir, filePath);
  const fileName = filePath.slice(filePath.lastIndexOf(sep) + 1);
  if (assetPath.startsWith(`assets${sep}`) && /[-.][A-Za-z0-9_-]{8}\.[^.]+$/.test(fileName)) {
    return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
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
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.ico':
      return 'image/x-icon';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}
