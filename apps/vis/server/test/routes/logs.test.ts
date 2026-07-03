import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';

import { buildSessionFixture } from '../fixtures/build';
import { logsRoute } from '../../src/routes/logs';

interface LogsBody {
  available: { session: boolean; global: boolean };
  lines: { message: string; level: string | null; fields: Record<string, string> }[];
}

describe('logs route (local sessions)', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  it('reads the session log from the session dir and the global log from KIMI_CODE_HOME', async () => {
    const { home, sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    // Per-session log lives under the session dir…
    await mkdir(join(sessionDir, 'logs'), { recursive: true });
    await writeFile(join(sessionDir, 'logs', 'kimi-code.log'), '2026-06-01T00:00:00.000Z INFO  session boot  k=v\n');
    // …but the shared global log lives at <home>/logs/kimi-code.log, NOT under
    // the session dir. Before the fix this was reported as unavailable.
    await mkdir(join(home, 'logs'), { recursive: true });
    await writeFile(join(home, 'logs', 'kimi-code.log'), '2026-06-01T00:00:01.000Z WARN  global thing  g=1\n');

    const app = logsRoute(home);

    const sessionRes = await app.request('/session_fixture/logs');
    expect(sessionRes.status).toBe(200);
    const sb = (await sessionRes.json()) as LogsBody;
    expect(sb.available).toEqual({ session: true, global: true });
    expect(sb.lines[0]!.message).toBe('session boot');

    const globalRes = await app.request('/session_fixture/logs?which=global');
    expect(globalRes.status).toBe(200);
    const gb = (await globalRes.json()) as LogsBody;
    expect(gb.lines[0]!.message).toBe('global thing');
    expect(gb.lines[0]!.level).toBe('WARN');
    expect(gb.lines[0]!.fields).toEqual({ g: '1' });
  });

  it('reports global unavailable for a local session with no home global log', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const res = await logsRoute(home).request('/session_fixture/logs');
    expect(res.status).toBe(200);
    expect(((await res.json()) as LogsBody).available.global).toBe(false);
  });

  it('discovers a rotated session log when the active file has rotated away', async () => {
    const { home, sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    await mkdir(join(sessionDir, 'logs'), { recursive: true });
    // Only an archive exists — no active kimi-code.log.
    await writeFile(join(sessionDir, 'logs', 'kimi-code.log.1'), '2026-06-01T00:00:00.000Z INFO  rotated only  r=1\n');

    const res = await logsRoute(home).request('/session_fixture/logs');
    const b = (await res.json()) as LogsBody;
    expect(b.available.session).toBe(true);
    expect(b.lines[0]!.message).toBe('rotated only');
  });

  it('concatenates rotated + active session logs oldest-first', async () => {
    const { home, sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    await mkdir(join(sessionDir, 'logs'), { recursive: true });
    await writeFile(join(sessionDir, 'logs', 'kimi-code.log.2'), '2026-06-01T00:00:00.000Z INFO  oldest\n');
    await writeFile(join(sessionDir, 'logs', 'kimi-code.log.1'), '2026-06-01T00:00:01.000Z INFO  middle\n');
    await writeFile(join(sessionDir, 'logs', 'kimi-code.log'), '2026-06-01T00:00:02.000Z INFO  newest\n');

    const res = await logsRoute(home).request('/session_fixture/logs');
    const b = (await res.json()) as LogsBody;
    expect(b.lines.map((l) => l.message)).toEqual(['oldest', 'middle', 'newest']);
  });
});
