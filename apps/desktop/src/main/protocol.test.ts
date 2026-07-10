import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mimeFor, rendererUrl, handleRendererRequest } from './protocol';

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

  it('rejects directory traversal (..)', async () => {
    const root = await makeRoot();
    const res = await handleRendererRequest(
      { url: 'app://renderer/../secret' } as any,
      () => root,
    );
    expect(res.status).toBe(403);
  });
});
