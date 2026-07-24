import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mimeFor, rendererUrl, rendererDevBase, handleRendererRequest } from '../../src/main/protocol';

describe('mimeFor', () => {
  it('maps common web extensions and falls back to octet-stream', () => {
    expect(mimeFor('index.html')).toBe('text/html; charset=utf-8');
    expect(mimeFor('assets/index-X.js')).toBe('text/javascript; charset=utf-8');
    expect(mimeFor('style.css')).toBe('text/css; charset=utf-8');
    expect(mimeFor('font.woff2')).toBe('font/woff2');
    expect(mimeFor('blob.unknown')).toBe('application/octet-stream');
  });
});

describe('rendererUrl', () => {
  it('builds app:// URL with query + token fragment', () => {
    const u = rendererUrl('http://127.0.0.1:54321', 'abc def');
    expect(u).toMatch(/^app:\/\/renderer\/index\.html\?/);
    expect(u).toContain('kimi_desktop=1');
    expect(u).toContain('kimi_origin=http%3A%2F%2F127.0.0.1%3A54321');
    expect(u).toMatch(/#token=abc%20def$/);
  });
  it('omits token fragment when undefined', () => {
    expect(rendererUrl('http://127.0.0.1:1', undefined)).not.toContain('#token=');
  });
  it('uses the given dev server base instead of app://renderer', () => {
    const u = rendererUrl('http://127.0.0.1:54321', 'abc', 'http://127.0.0.1:5174/');
    expect(u).toMatch(/^http:\/\/127\.0\.0\.1:5174\/\?/);
    expect(u).toContain('kimi_desktop=1');
    expect(u).toContain('kimi_origin=http%3A%2F%2F127.0.0.1%3A54321');
    expect(u).toMatch(/#token=abc$/);
  });
  it('pins the vibrancy state on every boot', () => {
    expect(rendererUrl('http://127.0.0.1:1', undefined, undefined, false, false)).toContain('kimi_vibrancy=0');
    expect(rendererUrl('http://127.0.0.1:1', undefined, undefined, false, true)).toContain('kimi_vibrancy=1');
    expect(rendererUrl('http://127.0.0.1:1', undefined)).toContain('kimi_vibrancy=1');
  });
});

describe('rendererDevBase', () => {
  it('returns undefined when unset or blank', () => {
    expect(rendererDevBase(undefined)).toBeUndefined();
    expect(rendererDevBase('   ')).toBeUndefined();
  });
  it('normalises a dev server URL (adds trailing slash)', () => {
    expect(rendererDevBase('http://127.0.0.1:5174')).toBe('http://127.0.0.1:5174/');
  });
  it('rejects non-http(s) and unparseable values', () => {
    expect(rendererDevBase('app://renderer')).toBeUndefined();
    expect(rendererDevBase('not a url')).toBeUndefined();
  });
});

describe('handleRendererRequest', () => {
  async function makeRoot() {
    const root = await mkdtemp(join(tmpdir(), 'kimi-renderer-'));
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'index.html'), '<h1>ok</h1>');
    await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)');
    return root;
  }

  it('serves index.html for / with correct mime', async () => {
    const root = await makeRoot();
    const res = await handleRendererRequest(
      { url: 'app://renderer/' } as any,
      () => root,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe('<h1>ok</h1>');
  });

  it('serves /assets/app.js', async () => {
    const root = await makeRoot();
    const res = await handleRendererRequest(
      { url: 'app://renderer/assets/app.js' } as any,
      () => root,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('returns 404 for missing file', async () => {
    const root = await makeRoot();
    const res = await handleRendererRequest(
      { url: 'app://renderer/nope.js' } as any,
      () => root,
    );
    expect(res.status).toBe(404);
  });

  // SPA fallback: the renderer's history routing pushes paths like
  // `/sessions/<id>` (and `/login` from the auth gate) onto the URL; a native
  // reload re-requests that path, which has no file in desktop-dist.
  it('serves index.html for SPA session routes (reload on a deep link)', async () => {
    const root = await makeRoot();
    const res = await handleRendererRequest(
      { url: 'app://renderer/sessions/abc' } as any,
      () => root,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe('<h1>ok</h1>');
  });

  it('serves index.html for the auth-gate /login path', async () => {
    const root = await makeRoot();
    const res = await handleRendererRequest(
      { url: 'app://renderer/login' } as any,
      () => root,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<h1>ok</h1>');
  });

  it('404s an extensionless path when index.html itself is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-renderer-'));
    const res = await handleRendererRequest(
      { url: 'app://renderer/sessions/abc' } as any,
      () => root,
    );
    expect(res.status).toBe(404);
  });

  it('serves files from the configured desktop-dist root (app://renderer/<path>)', async () => {
    const root = await makeRoot();
    await writeFile(join(root, 'assets', 'marker.js'), 'desktop-dist-root');
    const res = await handleRendererRequest(
      { url: 'app://renderer/assets/marker.js' } as any,
      () => root,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('desktop-dist-root');
  });

  it('rejects directory traversal (..) in the raw target', async () => {
    const root = await makeRoot();
    const res = await handleRendererRequest(
      { url: 'app://renderer/../secret' } as any,
      () => root,
    );
    expect(res.status).toBe(403);
  });

  it('never serves a file outside the root via literal or encoded `..`', async () => {
    const root = await makeRoot();
    // A sibling of the root, i.e. outside it. Traversal must never return this.
    const outside = join(root, '..', 'kimi-renderer-secret.txt');
    await writeFile(outside, 'leaked');

    // Layer 1: literal `..` in the raw target is rejected before parsing.
    const literal = await handleRendererRequest(
      { url: 'app://renderer/../kimi-renderer-secret.txt' } as any,
      () => root,
    );
    expect(literal.status).toBe(403);

    // Layers 2 + 3: the URL parser percent-decodes and collapses `%2e%2e`, so an
    // encoded traversal never resolves to the out-of-root file either — it is
    // forbidden (403) or simply not found (404), but is NEVER 200 with the secret.
    const encoded = await handleRendererRequest(
      { url: 'app://renderer/assets/%2e%2e/%2e%2e/kimi-renderer-secret.txt' } as any,
      () => root,
    );
    expect(encoded.status).not.toBe(200);
  });
});
