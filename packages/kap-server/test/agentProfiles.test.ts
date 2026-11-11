import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../src/start';
import { authHeaders } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('server-v2 /api/v1 agent-profiles', () => {
  let server: RunningServer | undefined;
  let home: string;
  let base: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-agent-profiles-'));
    await mkdir(join(home, 'agents'), { recursive: true });
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  beforeEach(async () => {
    await rm(join(home, 'agents'), { recursive: true, force: true });
    await mkdir(join(home, 'agents'), { recursive: true });
  });

  afterAll(async () => {
    await server?.close();
    await rm(home, { recursive: true, force: true });
  });

  async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: Envelope<T> }> {
    const headers = new Headers(authHeaders(server as RunningServer));
    if (init?.body !== undefined) headers.set('content-type', 'application/json');
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    const response = await fetch(`${base}/api/v1${path}`, {
      ...init,
      headers,
    });
    return { status: response.status, body: await response.json() as Envelope<T> };
  }

  it('creates, lists and reads a user agent profile', async () => {
    const created = await api<any>('/agent-profiles', {
      method: 'POST',
      body: JSON.stringify({ name: 'code-reviewer', description: 'Review code', prompt: 'Review the diff.' }),
    });
    expect(created.status).toBe(200);
    expect(created.body.code).toBe(0);
    expect(created.body.data.agent).toMatchObject({
      name: 'code-reviewer',
      description: 'Review code',
      prompt: 'Review the diff.',
    });
    expect(created.body.data.agent.etag).toHaveLength(64);

    const list = await api<any>('/agent-profiles');
    expect(list.body.data.agents).toHaveLength(1);
    expect(list.body.data.agents[0].name).toBe('code-reviewer');

    const detail = await api<any>('/agent-profiles/code-reviewer');
    expect(detail.body.data.agent.prompt).toBe('Review the diff.');
    expect(await readFile(join(home, 'agents', 'code-reviewer.md'), 'utf8')).toContain('Review the diff.');
  });

  it('updates and renames a profile', async () => {
    const created = await api<any>('/agent-profiles', {
      method: 'POST',
      body: JSON.stringify({ name: 'old-name', description: 'Old', prompt: 'Old.' }),
    });
    const etag = created.body.data.agent.etag;

    const updated = await api<any>('/agent-profiles/old-name', {
      method: 'PUT',
      body: JSON.stringify({ new_name: 'new-name', description: 'New', prompt: 'New.', etag }),
    });
    expect(updated.body.code).toBe(0);
    expect(updated.body.data.agent).toMatchObject({ name: 'new-name', description: 'New', prompt: 'New.' });

    await expect(readFile(join(home, 'agents', 'old-name.md'), 'utf8')).rejects.toThrow();
    expect(await readFile(join(home, 'agents', 'new-name.md'), 'utf8')).toContain('name: new-name');
  });

  it('returns domain errors for conflicts, stale content and missing profiles', async () => {
    const builtin = await api<any>('/agent-profiles', {
      method: 'POST',
      body: JSON.stringify({ name: 'coder', description: 'Conflict', prompt: 'Conflict.' }),
    });
    expect(builtin.body.code).toBe(40936);

    const created = await api<any>('/agent-profiles', {
      method: 'POST',
      body: JSON.stringify({ name: 'reviewer', description: 'Review', prompt: 'Review.' }),
    });
    const stale = await api<any>('/agent-profiles/reviewer', {
      method: 'PUT',
      body: JSON.stringify({ description: 'One', prompt: 'One.', etag: created.body.data.agent.etag }),
    });
    expect(stale.body.code).toBe(0);
    const repeated = await api<any>('/agent-profiles/reviewer', {
      method: 'PUT',
      body: JSON.stringify({ description: 'Two', prompt: 'Two.', etag: created.body.data.agent.etag }),
    });
    expect(repeated.body.code).toBe(40937);

    const missing = await api<any>('/agent-profiles/missing');
    expect(missing.body.code).toBe(40422);
  });

  it('deletes with the current etag', async () => {
    const created = await api<any>('/agent-profiles', {
      method: 'POST',
      body: JSON.stringify({ name: 'reviewer', description: 'Review', prompt: 'Review.' }),
    });
    const etag = created.body.data.agent.etag;

    const deleted = await api<any>(`/agent-profiles/reviewer?etag=${etag}`, { method: 'DELETE' });
    expect(deleted.body).toMatchObject({ code: 0 });
    expect(deleted.body.data.deleted).toBe(true);
    expect((await api<any>('/agent-profiles/reviewer')).body.code).toBe(40422);
  });

  it('reports invalid files and refreshes runtime catalogs', async () => {
    await writeFile(join(home, 'agents', 'broken.md'), 'not an agent');

    const list = await api<any>('/agent-profiles');
    expect(list.body.data.skipped).toHaveLength(1);
    expect(list.body.data.skipped[0].path).toContain('broken.md');

    const refreshed = await api<any>('/agent-profiles:refresh', { method: 'POST', body: '{}' });
    expect(refreshed.body.code).toBe(0);
    expect(refreshed.body.data.refreshed).toBe(true);
  });
});
