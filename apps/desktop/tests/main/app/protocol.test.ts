import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mimeFor, rendererUrl, rendererDevBase, handleRendererRequest, registerAppSchemes, createAssetFailureReporter } from '../../../src/main/app/protocol';

const electronMocks = vi.hoisted(() => ({ registerSchemesAsPrivileged: vi.fn() }));
vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: electronMocks.registerSchemesAsPrivileged } }));

describe('registerAppSchemes', () => {
  it('enables the V8 code cache for the renderer and screenshot schemes', () => {
    registerAppSchemes();
    expect(electronMocks.registerSchemesAsPrivileged).toHaveBeenCalledTimes(1);
    const [schemes] = electronMocks.registerSchemesAsPrivileged.mock.calls[0]!;
    expect(schemes).toEqual([
      { scheme: 'app', privileges: expect.objectContaining({ standard: true, secure: true, codeCache: true }) },
      { scheme: 'shot', privileges: expect.objectContaining({ standard: true, secure: true, codeCache: true }) },
    ]);
  });
});

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
  it('pins the native title bar opt-out only when requested', () => {
    expect(rendererUrl('http://127.0.0.1:1', undefined, undefined, false, true, false, true)).toContain('kimi_native_titlebar=1');
    expect(rendererUrl('http://127.0.0.1:1', undefined)).not.toContain('kimi_native_titlebar');
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
    expect(res.headers.get('document-policy')).toBe('include-js-call-stacks-in-crash-reports');
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
    expect(res.headers.get('document-policy')).toBeNull();
  });

  it('returns 404 for missing file', async () => {
    const root = await makeRoot();
    const res = await handleRendererRequest(
      { url: 'app://renderer/nope.js' } as any,
      () => root,
    );
    expect(res.status).toBe(404);
  });

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
    const outside = join(root, '..', 'kimi-renderer-secret.txt');
    await writeFile(outside, 'leaked');

    const literal = await handleRendererRequest(
      { url: 'app://renderer/../kimi-renderer-secret.txt' } as any,
      () => root,
    );
    expect(literal.status).toBe(403);

    const encoded = await handleRendererRequest(
      { url: 'app://renderer/assets/%2e%2e/%2e%2e/kimi-renderer-secret.txt' } as any,
      () => root,
    );
    expect(encoded.status).not.toBe(200);
  });

  describe('preview session serving', () => {
    it('serves the preview dist for the same paths the main session maps to its own root', async () => {
      const root = await makeRoot();
      const preview = await mkdtemp(join(tmpdir(), 'kimi-preview-'));
      await mkdir(join(preview, 'assets'), { recursive: true });
      await writeFile(join(preview, 'index.html'), '<h1>preview</h1>');
      await writeFile(join(preview, 'assets', 'p.js'), 'preview-js');

      const index = await handleRendererRequest(
        { url: 'app://renderer/index.html' } as any,
        () => preview,
      );
      expect(index.status).toBe(200);
      expect(await index.text()).toBe('<h1>preview</h1>');

      const asset = await handleRendererRequest(
        { url: 'app://renderer/assets/p.js' } as any,
        () => preview,
      );
      expect(asset.status).toBe(200);
      expect(await asset.text()).toBe('preview-js');

      const normal = await handleRendererRequest(
        { url: 'app://renderer/assets/app.js' } as any,
        () => root,
      );
      expect(normal.status).toBe(200);
      expect(await normal.text()).toBe('console.log(1)');
    });

    it('applies the SPA fallback inside the preview root too', async () => {
      const preview = await mkdtemp(join(tmpdir(), 'kimi-preview-'));
      await writeFile(join(preview, 'index.html'), '<h1>preview</h1>');
      const res = await handleRendererRequest(
        { url: 'app://renderer/sessions/abc' } as any,
        () => preview,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('<h1>preview</h1>');
    });

    it('404s when no preview dist is set (never leaks another root)', async () => {
      const res = await handleRendererRequest(
        { url: 'app://renderer/index.html' } as any,
        () => null,
      );
      expect(res.status).toBe(404);
    });

  });
});

describe('createAssetFailureReporter', () => {
  it('reports each failing renderer asset once, by path only', () => {
    const lines: string[] = [];
    const report = createAssetFailureReporter((line) => lines.push(line));
    report(404, 'app://renderer/assets/index-abc123.js?v=2#x');
    report(404, 'app://renderer/assets/index-abc123.js');
    report(403, 'app://renderer/../secret');
    report(404, 'app://renderer/favicon.ico');
    expect(lines).toEqual([
      '[asset] 404 /assets/index-abc123.js',
      '[asset] 403 /secret',
      '[asset] 404 /favicon.ico',
    ]);
  });

  it('stops after a bounded number of distinct failures', () => {
    const lines: string[] = [];
    const report = createAssetFailureReporter((line) => lines.push(line));
    for (let i = 0; i < 250; i += 1) report(404, `app://renderer/assets/chunk-${i}.js`);
    expect(lines).toHaveLength(200);
  });
});
