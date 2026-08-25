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
): string {
  const params = new URLSearchParams({
    kimi_desktop: '1',
    platform: process.platform,
    kimi_origin: origin,
  });
  // Onboarding completion, persisted by the main process in ui-state.json and
  // injected here so the renderer's first-run gate does not depend on
  // origin-scoped localStorage (dev-server ports shift between runs).
  if (onboarded) params.set('kimi_onboarded', '1');
  // The vibrancy state rides the same channel, pinned on every boot (not only
  // on opt-out) so an SPA reload that lost the boot query can tell "enabled"
  // apart from "query dropped" (composables/useVibrancy.ts mirrors it into
  // sessionStorage, the desktopFlag pattern).
  params.set('kimi_vibrancy', vibrancy ? '1' : '0');
  const hash = token === undefined ? '' : `#token=${encodeURIComponent(token)}`;
  return `${base}?${params.toString()}${hash}`;
}

/**
 * Normalise the `KIMI_RENDERER_DEV_URL` env var (set by scripts/dev.mjs for
 * renderer HMR). Returns the dev server base URL to load instead of
 * `app://renderer/index.html`, or undefined when unset/invalid/non-http(s).
 */
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

/**
 * Map `app://renderer/<path>` to `<distRoot>/<path>` (a desktop renderer
 * build, `desktop-dist`) with MIME + traversal protection. Returns a Response
 * for `protocol.handle`; a null root (no preview build active) answers 404.
 *
 * The same handler serves two per-session registrations:
 * - the default session (main window): the normal dist — see
 *   registerRendererProtocol;
 * - the PR-preview session partition (preview-window.ts): the preview
 *   worktree's dist — see registerPreviewRendererProtocol. Both windows share
 *   scheme and origin (the embedded server's origin allowlist needs no
 *   change) while each session resolves `app://renderer/*` to its own build,
 *   so in-app URL pushes (`/sessions/<id>`) and reloads can never leak the
 *   preview window onto the regular build.
 */
export async function handleRendererRequest(
  request: Request,
  getDistRoot: () => string | null,
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
  const root = getDistRoot();
  if (root === null) {
    return new Response('not found', { status: 404 });
  }
  const rel = decodedPathname === '/' ? '/index.html' : decodedPathname;
  const filePath = resolve(join(root, rel));
  if (!filePath.startsWith(root)) {
    return new Response('forbidden', { status: 403 });
  }
  // SPA fallback (mirrors kap-server's webAssets): the renderer's history
  // routing pushes extensionless navigation URLs (`/sessions/<id>`, `/login`)
  // that have no file in desktop-dist — serve index.html so a native reload
  // (cmd+r) lands back in the app. Asset misses with an extension keep their
  // 404 instead of being fed HTML.
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
  return new Response(stream as unknown as ResponseBody, {
    headers: { 'content-type': mimeFor(target) },
  });
}

export function registerRendererProtocol(getRendererDistRoot: () => string): void {
  protocol.handle(RENDERER_SCHEME, (request) => handleRendererRequest(request, getRendererDistRoot));
}

/** Serve the preview dist for `app://renderer/*` inside the preview window's
    session partition (PR preview, preview-window.ts). */
export function registerPreviewRendererProtocol(
  previewSession: Electron.Session,
  getPreviewDistRoot: () => string | null,
): void {
  previewSession.protocol.handle(RENDERER_SCHEME, (request) => handleRendererRequest(request, getPreviewDistRoot));
}
