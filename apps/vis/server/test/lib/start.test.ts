import { describe, it, expect, afterEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import { startVisServer } from '../../src/start';

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { if (stop) await stop(); stop = null; });

describe('startVisServer', () => {
  it('serves the embedded web asset and the API on an auto-picked port', async () => {
    const html = '<!doctype html><title>vis</title>';
    const server = await startVisServer({
      port: 0,                               // auto-pick
      homeDir: '/tmp/does-not-exist-home',   // no sessions; API still responds
      webAsset: { gzipped: new Uint8Array(gzipSync(Buffer.from(html))) },
    });
    stop = server.close;
    expect(server.port).toBeGreaterThan(0);

    const page = await fetch(`${server.url}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('<title>vis</title>'); // fetch auto-inflates gzip

    const spa = await fetch(`${server.url}sessions/anything`);
    expect(await spa.text()).toContain('<title>vis</title>'); // SPA fallback

    const api = await fetch(`${server.url}api/sessions`);
    expect(api.status).toBe(200); // empty list for a missing home, not a crash
  });

  it('rejects instead of hanging when the port is already bound', async () => {
    const first = await startVisServer({ port: 0, homeDir: '/tmp/does-not-exist-home' });
    stop = first.close;
    const taken = first.port;

    // A second bind on the same port must REJECT (EADDRINUSE), not hang
    // forever or escape as an uncaughtException.
    await expect(
      startVisServer({ port: taken, homeDir: '/tmp/does-not-exist-home' }),
    ).rejects.toThrow();
  });
});
