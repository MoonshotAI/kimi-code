import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { protocol } from 'electron';

export const RENDERER_SCHEME = 'app';
export const RENDERER_HOST = 'renderer';

// Node's global fetch types expose `Request` / `Response` here but not the
// `BodyInit` name; derive the accepted body type from the `Response`
// constructor instead of naming `BodyInit` directly.
type ResponseBody = ConstructorParameters<typeof Response>[0];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

export function mimeFor(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

const priv = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  // See Global Constraints: verify CORS behaviour in Task 2.5; flip to false
  // only if `app://`→`http://127.0.0.1` is blocked and the loopback server is
  // confirmed to ignore Origin (local trusted context).
  corsEnabled: true,
};

export function registerRendererScheme(): void {
  // MUST run before `app.whenReady()`.
  protocol.registerSchemesAsPrivileged([
    { scheme: RENDERER_SCHEME, privileges: priv },
  ]);
}

export function rendererUrl(origin: string, token: string | undefined): string {
  const base = `${RENDERER_SCHEME}://${RENDERER_HOST}/index.html`;
  const params = new URLSearchParams({
    kimi_desktop: '1',
    platform: process.platform,
    kimi_origin: origin,
  });
  const hash = token === undefined ? '' : `#token=${encodeURIComponent(token)}`;
  return `${base}?${params.toString()}${hash}`;
}

/**
 * Map `app://renderer/<path>` to `<rendererDistRoot>/<path>` (the desktop
 * renderer build, `desktop-dist`) with MIME + traversal protection. Returns a
 * Response for `protocol.handle`.
 */
export async function handleRendererRequest(
  request: Request,
  getRendererDistRoot: () => string,
): Promise<Response> {
  const url = new URL(request.url);
  // Reject traversal before the URL parser collapses `..`: inspect the raw
  // request target (everything after scheme+host, minus query/fragment) so a
  // request like `app://renderer/../secret` is forbidden instead of being
  // silently rewritten to `/secret`.
  const rawTarget = request.url.slice(`${url.protocol}//${url.host}`.length);
  const rawPath = rawTarget.split(/[?#]/)[0] ?? '/';
  if (rawPath.split('/').some((seg) => seg === '..')) {
    return new Response('forbidden', { status: 403 });
  }
  // Normalise and forbid traversal. URL pathname is already percent-decoded
  // and collapsed, but guard against sneaky `..` after decoding anyway.
  const decodedPathname = decodeURIComponent(url.pathname);
  if (decodedPathname.split('/').some((seg) => seg === '..')) {
    return new Response('forbidden', { status: 403 });
  }
  const rel = decodedPathname === '/' ? '/index.html' : decodedPathname;
  const root = getRendererDistRoot();
  const filePath = resolve(join(root, rel));
  if (!filePath.startsWith(root)) {
    return new Response('forbidden', { status: 403 });
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return new Response('not found', { status: 404 });
    }
  } catch {
    return new Response('not found', { status: 404 });
  }
  const stream = createReadStream(filePath);
  return new Response(stream as unknown as ResponseBody, {
    headers: { 'content-type': mimeFor(filePath) },
  });
}

export function registerRendererProtocol(getRendererDistRoot: () => string): void {
  protocol.handle(RENDERER_SCHEME, (request) => handleRendererRequest(request, getRendererDistRoot));
}
