import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSessionFixture } from '../fixtures/build';
import { blobsRoute } from '../../src/routes/blobs';

describe('blobs route', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('serves a blob with the requested content-type', async () => {
    const { home, sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const blobDir = join(sessionDir, 'agents', 'main', 'blobs');
    await mkdir(blobDir, { recursive: true });
    const hash = 'a'.repeat(64);
    await writeFile(join(blobDir, hash), Buffer.from('binary-content'));

    const app = blobsRoute(home);
    const res = await app.request(
      `/session_fixture/blobs/${hash}?agent=main&mime=image/png`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const body = await res.text();
    expect(body).toBe('binary-content');
  });

  it('defaults mime to application/octet-stream', async () => {
    const { home, sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const blobDir = join(sessionDir, 'agents', 'main', 'blobs');
    await mkdir(blobDir, { recursive: true });
    const hash = 'b'.repeat(64);
    await writeFile(join(blobDir, hash), Buffer.from('x'));

    const app = blobsRoute(home);
    const res = await app.request(
      `/session_fixture/blobs/${hash}?agent=main`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('returns 404 for missing session', async () => {
    const app = blobsRoute();
    const res = await app.request(
      `/no-such-session/blobs/${'c'.repeat(64)}?agent=main&mime=image/png`,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns 404 for missing agent', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const app = blobsRoute(home);
    const res = await app.request(
      `/session_fixture/blobs/${'d'.repeat(64)}?agent=no-such-agent&mime=image/png`,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns 404 for missing blob file', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const app = blobsRoute(home);
    const res = await app.request(
      `/session_fixture/blobs/${'e'.repeat(64)}?agent=main&mime=image/png`,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns 400 for invalid agent id', async () => {
    const app = blobsRoute();
    const res = await app.request(
      `/session_fixture/blobs/${'f'.repeat(64)}?agent=../escape&mime=image/png`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('returns 400 for invalid blob hash', async () => {
    const app = blobsRoute();
    const res = await app.request(
      `/session_fixture/blobs/not-a-hash?agent=main&mime=image/png`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });
});
