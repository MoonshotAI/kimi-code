import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';

import { buildSessionFixture } from '../fixtures/build';
import { tasksRoute } from '../../src/routes/tasks';

describe('tasks route', () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => { if (cleanup) await cleanup(); cleanup = null; });

  // Tasks live under the spawning agent's homedir (<session>/agents/main/tasks),
  // NOT the session root — seed there so the test mirrors real on-disk layout.
  async function seed(sessionDir: string): Promise<void> {
    const dir = join(sessionDir, 'agents', 'main', 'tasks');
    await mkdir(join(dir, 'bash-12345678'), { recursive: true });
    await writeFile(join(dir, 'bash-12345678.json'), JSON.stringify({
      taskId: 'bash-12345678', kind: 'process', description: 'build',
      command: 'pnpm build', pid: 7, exitCode: 0, status: 'completed',
      detached: true, startedAt: 100, endedAt: 200,
    }));
    await writeFile(join(dir, 'bash-12345678', 'output.log'), 'line one\nline two\n');
  }

  it('GET /:id/tasks returns entries with output metadata', async () => {
    const { home, sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    await seed(sessionDir);

    const app = tasksRoute(home);
    const res = await app.request('/session_fixture/tasks');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      tasks: { task: { taskId: string }; agentId: string; outputSizeBytes: number; outputExists: boolean }[];
    };
    expect(body.sessionId).toBe('session_fixture');
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]!.task.taskId).toBe('bash-12345678');
    expect(body.tasks[0]!.agentId).toBe('main');
    expect(body.tasks[0]!.outputExists).toBe(true);
    expect(body.tasks[0]!.outputSizeBytes).toBe('line one\nline two\n'.length);
  });

  it('GET /:id/tasks returns [] when there are no tasks', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const app = tasksRoute(home);
    const res = await app.request('/session_fixture/tasks');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tasks: unknown[] }).tasks).toEqual([]);
  });

  it('GET /:id/tasks/:taskId/output pages by byte window', async () => {
    const { home, sessionDir, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    await seed(sessionDir);
    const app = tasksRoute(home);

    const res = await app.request('/session_fixture/tasks/bash-12345678/output?offset=0&limit=8');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; size: number; eof: boolean; offset: number; nextOffset: number };
    expect(body.content).toBe('line one');
    expect(body.size).toBe(18);
    expect(body.eof).toBe(false);
    expect(body.offset).toBe(0);
    expect(body.nextOffset).toBe(8);
  });

  it('GET output returns empty window for a task with no log', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const app = tasksRoute(home);
    const res = await app.request('/session_fixture/tasks/bash-00000000/output');
    expect(res.status).toBe(200);
    expect((await res.json())).toMatchObject({ size: 0, content: '', eof: true });
  });

  it('rejects an unsafe task id with 400', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const app = tasksRoute(home);
    const res = await app.request('/session_fixture/tasks/..%2Fescape/output');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('returns 404 for a missing session', async () => {
    const { home, cleanup: c } = await buildSessionFixture('sample-main');
    cleanup = c;
    const app = tasksRoute(home);
    const res = await app.request('/no-such-session/tasks');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});
