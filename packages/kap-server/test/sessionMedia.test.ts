import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function privateHttpOrigin(port: number): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.address.startsWith('10.') || entry.address.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(entry.address)) {
        return `http://${entry.address}:${port}`;
      }
    }
  }
  throw new Error('no RFC1918 interface is available for the remote image fixture');
}

describe('server-v2 session remote images', () => {
  let daemon: RunningServer;
  let home: string;
  let imageServer: Server;
  let imageOrigin: string;
  let imagePort: number;
  let base: string;
  let changed = false;
  let forwardedAuthorization: string | undefined;
  let forwardedCookie: string | undefined;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-session-remote-image-'));
    daemon = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${daemon.port}`;
    imageServer = createServer((req, res) => {
      forwardedAuthorization = req.headers.authorization;
      forwardedCookie = req.headers.cookie;
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (pathname === '/redirect') {
        res.writeHead(302, { location: '/image.png' }).end();
        return;
      }
      if (pathname === '/redirect-loop') {
        res.writeHead(302, { location: '/redirect-loop' }).end();
        return;
      }
      if (pathname === '/redirect-blocked') {
        res.writeHead(302, { location: `http://127.0.0.1:${imagePort}/image.png` }).end();
        return;
      }
      if (pathname === '/html.png') {
        res.writeHead(200, { 'content-type': 'image/png' }).end('<html>not an image</html>');
        return;
      }
      if (pathname === '/large.png') {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(10 * 1024 * 1024 + 1) }).end();
        return;
      }
      if (pathname === '/stream-large.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]));
        return;
      }
      const bytes = changed ? Buffer.concat([PNG, Buffer.from([0])]) : PNG;
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': bytes.length }).end(bytes);
    });
    await new Promise<void>((resolve) => imageServer.listen(0, '0.0.0.0', resolve));
    const address = imageServer.address();
    if (address === null || typeof address === 'string') throw new Error('image server did not start');
    imagePort = address.port;
    imageOrigin = privateHttpOrigin(imagePort);
  });

  afterAll(async () => {
    await Promise.all([
      daemon.close(),
      new Promise<void>((resolve, reject) => {
        imageServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    ]);
    await rm(home, { recursive: true, force: true });
  });

  async function post<T>(path: string, body: unknown): Promise<{ status: number; body: { code: number; data: T } }> {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(daemon, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as { code: number; data: T } };
  }

  async function createSession(): Promise<string> {
    const created = await post<{ id: string }>('/api/v1/sessions', { metadata: { cwd: home } });
    expect(created.body.code).toBe(0);
    return created.body.data.id;
  }

  it('creates and downloads session-canonical images with deterministic deduplication', async () => {
    const sessionId = await createSession();
    const url = `${imageOrigin}/redirect`;
    const first = await post<{ id: string; media_type: string; size: number }>(
      `/api/v1/sessions/${sessionId}/media`,
      { url },
    );
    expect(first.status).toBe(200);
    expect(first.body.data.media_type).toBe('image/png');
    expect(first.body.data.size).toBe(PNG.length);
    const second = await post<{ id: string }>(`/api/v1/sessions/${sessionId}/media`, { url });
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(forwardedAuthorization).toBeUndefined();
    expect(forwardedCookie).toBeUndefined();

    const download = await fetch(`${base}/api/v1/sessions/${sessionId}/media/${first.body.data.id}`, {
      headers: authHeaders(daemon),
    });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await download.arrayBuffer()).equals(PNG)).toBe(true);

    changed = true;
    const updated = await post<{ id: string; size: number }>(`/api/v1/sessions/${sessionId}/media`, { url });
    expect(updated.body.data.id).not.toBe(first.body.data.id);
    expect(updated.body.data.size).toBe(PNG.length + 1);
    changed = false;
  });

  it('rejects non-image content, oversized bodies, invalid URLs, and redirect loops', async () => {
    const sessionId = await createSession();
    const html = await post<{ code: number }>(`/api/v1/sessions/${sessionId}/media`, {
      url: `${imageOrigin}/html.png`,
    });
    expect(html.status).toBe(400);
    expect(html.body.code).toBe(40001);

    const large = await post<{ code: number }>(`/api/v1/sessions/${sessionId}/media`, {
      url: `${imageOrigin}/large.png`,
    });
    expect(large.status).toBe(413);
    expect(large.body.code).toBe(41301);

    const streamed = await post<{ code: number }>(`/api/v1/sessions/${sessionId}/media`, {
      url: `${imageOrigin}/stream-large.png`,
    });
    expect(streamed.status).toBe(413);
    expect(streamed.body.code).toBe(41301);

    for (const target of [
      `http://127.0.0.1:${imagePort}/image.png`,
      `http://localhost:${imagePort}/image.png`,
      'http://169.254.169.254/latest/meta-data',
      `${imageOrigin}/redirect-blocked`,
    ]) {
      const blocked = await post<{ code: number }>(`/api/v1/sessions/${sessionId}/media`, { url: target });
      expect(blocked.status).toBe(400);
      expect(blocked.body.code).toBe(40001);
    }

    const invalid = await post<{ code: number }>(`/api/v1/sessions/${sessionId}/media`, {
      url: 'data:image/png;base64,AA',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe(40001);

    const redirects = await post<{ code: number }>(`/api/v1/sessions/${sessionId}/media`, {
      url: `${imageOrigin}/redirect-loop`,
    });
    expect(redirects.status).toBe(502);
    expect(redirects.body.code).toBe(50001);

    const missing = await post<{ code: number }>('/api/v1/sessions/session_missing/media', {
      url: `${imageOrigin}/image.png`,
    });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe(40401);
  });
});
