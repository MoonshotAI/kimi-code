import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';

import { buildSessionFixture } from '../fixtures/build';
import { cronRoute } from '../../src/routes/cron';

describe('cron route', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('GET /:id/cron returns the persisted cron tasks', async () => {
    const { home, sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    // Cron lives under the main agent's homedir, not the session root.
    const dir = join(sessionDir, 'agents', 'main', 'cron');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a1b2c3d4.json'), JSON.stringify({
      id: 'a1b2c3d4', cron: '0 9 * * *', prompt: 'standup', createdAt: 1, recurring: true,
    }));

    const app = cronRoute(home);
    const res = await app.request('/session_fixture/cron');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; cron: { id: string; cron: string }[] };
    expect(body.sessionId).toBe('session_fixture');
    expect(body.cron).toHaveLength(1);
    expect(body.cron[0]).toMatchObject({ id: 'a1b2c3d4', cron: '0 9 * * *', prompt: 'standup' });
  });

  it('GET /:id/cron returns [] when there are no cron tasks', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const app = cronRoute(home);
    const res = await app.request('/session_fixture/cron');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { cron: unknown[] }).cron).toEqual([]);
  });

  it('returns 404 for a missing session', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const app = cronRoute(home);
    const res = await app.request('/no-such-session/cron');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});
