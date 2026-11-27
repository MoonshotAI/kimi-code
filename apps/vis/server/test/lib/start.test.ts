import { describe, it, expect, afterEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import { startVisServer } from '../../src/start';

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { if (stop) await stop(); stop = null; });

describe('startVisServer', () => {
  it('serves the embedded web asset and the API on an auto-picked port', async () => {
    const html = '<!doctype html><title>vis</title>';
    const server = await startVisServer({
      port: 0,
      homeDir: '/tmp/does-not-exist-home',
      webAsset: { gzipped: new Uint8Array(gzipSync(Buffer.from(html))) },
    });
    stop = server.close;
    expect(server.port).toBeGreaterThan(0);

    const page = await fetch(`${server.url}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('<title>vis</title>');

    const spa = await fetch(`${server.url}sessions/anything`);
    expect(await spa.text()).toContain('<title>vis</title>');

    const api = await fetch(`${server.url}api/sessions`);
    expect(api.status).toBe(200);
  });

  it('rejects instead of hanging when the port is already bound', async () => {
    const first = await startVisServer({ port: 0, homeDir: '/tmp/does-not-exist-home' });
    stop = first.close;
    const taken = first.port;

    await expect(
      startVisServer({ port: taken, homeDir: '/tmp/does-not-exist-home' }),
    ).rejects.toThrow();
  });
});
