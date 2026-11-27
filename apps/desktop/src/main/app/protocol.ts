import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { protocol } from 'electron';

import { log } from '../diagnostics/log';

export const RENDERER_SCHEME = 'app';
export const RENDERER_HOST = 'renderer';

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
  corsEnabled: true,
  codeCache: true,
};

export function registerAppSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: RENDERER_SCHEME, privileges: priv },
    { scheme: 'shot', privileges: priv },
  ]);
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

const DEFAULT_RENDERER_BASE = `${RENDERER_SCHEME}://${RENDERER_HOST}/index.html`;

export function rendererUrl(
  origin: string,
  token: string | undefined,
  base: string = DEFAULT_RENDERER_BASE,
  onboarded = false,
  vibrancy = true,
  embedded = false,
  nativeTitleBar = false,
): string {
  const params = new URLSearchParams({
    kimi_desktop: '1',
    platform: process.platform,
    kimi_origin: origin,
  });
  if (embedded) params.set('kimi_embedded', '1');
  if (onboarded) params.set('kimi_onboarded', '1');
  params.set('kimi_vibrancy', vibrancy ? '1' : '0');
  if (nativeTitleBar) params.set('kimi_native_titlebar', '1');
  const hash = token === undefined ? '' : `#token=${encodeURIComponent(token)}`;
  return `${base}?${params.toString()}${hash}`;
}

export function rendererDevBase(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export async function handleRendererRequest(
  request: Request,
  getDistRoot: () => string | null,
): Promise<Response> {
  const url = new URL(request.url);
  const rawTarget = request.url.slice(`${url.protocol}//${url.host}`.length);
  const rawPath = rawTarget.split(/[?#]/)[0] ?? '/';
  if (rawPath.split('/').some((seg) => seg === '..')) {
    return new Response('forbidden', { status: 403 });
  }
  const decodedPathname = decodeURIComponent(url.pathname);
  if (decodedPathname.split('/').some((seg) => seg === '..')) {
    return new Response('forbidden', { status: 403 });
  }
  const root = getDistRoot();
  if (root === null) {
    return new Response('not found', { status: 404 });
  }
  const rel = decodedPathname === '/' ? '/index.html' : decodedPathname;
  const filePath = resolve(join(root, rel));
  if (!filePath.startsWith(root)) {
    return new Response('forbidden', { status: 403 });
  }
  let target = filePath;
  if (!(await isRegularFile(target))) {
    if (extname(decodedPathname) !== '') {
      return new Response('not found', { status: 404 });
    }
    target = join(root, 'index.html');
    if (!(await isRegularFile(target))) {
      return new Response('not found', { status: 404 });
    }
  }
  const stream = createReadStream(target);
  const headers: Record<string, string> = { 'content-type': mimeFor(target) };
  if (extname(target).toLowerCase() === '.html') {
    headers['document-policy'] = 'include-js-call-stacks-in-crash-reports';
  }
  return new Response(stream as unknown as ResponseBody, { headers });
}

const MAX_REPORTED_ASSET_FAILURES = 200;

export function createAssetFailureReporter(
  report: (line: string) => void = (line) => log.warn(line),
): (status: number, requestUrl: string) => void {
  const reported = new Set<string>();
  return (status, requestUrl) => {
    let path: string;
    try {
      path = new URL(requestUrl).pathname;
    } catch {
      path = '?';
    }
    const key = `${status} ${path}`;
    if (reported.has(key) || reported.size >= MAX_REPORTED_ASSET_FAILURES) return;
    reported.add(key);
    report(`[asset] ${key}`);
  };
}

export function registerRendererProtocol(getRendererDistRoot: () => string): void {
  const reportFailure = createAssetFailureReporter();
  protocol.handle(RENDERER_SCHEME, async (request) => {
    const response = await handleRendererRequest(request, getRendererDistRoot);
    if (response.status >= 400) reportFailure(response.status, request.url);
    return response;
  });
}
