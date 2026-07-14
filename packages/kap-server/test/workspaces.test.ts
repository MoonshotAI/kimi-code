import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

interface WorkspaceWire {
  id: string;
  root: string;
  name: string;
  is_git_repo: boolean;
  branch: string | null;
  created_at: string;
  last_opened_at: string;
  session_count: number;
}

interface ListWire {
  items: WorkspaceWire[];
}

describe('server-v2 /api/v1/workspaces', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-workspaces-'));
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const hasBody = body !== undefined;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(
        server as RunningServer,
        hasBody ? { 'content-type': 'application/json' } : {},
      ),
      body: hasBody ? JSON.stringify(body) : undefined,
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function patchJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'PATCH',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify(body ?? {}),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function deleteJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'DELETE',
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  /** Lay down a minimal git fixture: `.git/HEAD` referring to a branch. */
  async function makeGitRepo(root: string, branch: string): Promise<void> {
    await mkdir(join(root, '.git'), { recursive: true });
    await writeFile(join(root, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`, 'utf8');
  }

  it('creates a workspace with the full wire shape', async () => {
    const root = home as string;
    const { status, body } = await postJson<WorkspaceWire>('/api/v1/workspaces', {
      root,
      name: 'proj',
    });
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.root).toBe(root);
    expect(body.data.name).toBe('proj');
    expect(body.data.id).toMatch(/^wd_[a-z0-9._-]+_[0-9a-f]{12}$/);
    expect(typeof body.data.is_git_repo).toBe('boolean');
    expect(body.data.branch).toBeNull();
    expect(typeof body.data.session_count).toBe('number');
    expect(Number.isNaN(Date.parse(body.data.created_at))).toBe(false);
    expect(Number.isNaN(Date.parse(body.data.last_opened_at))).toBe(false);
  });

  it('resolves branch from .git/HEAD (and null when detached)', async () => {
    const repo = join(home as string, 'repo');
    await makeGitRepo(repo, 'feature/x');
    const created = await postJson<WorkspaceWire>('/api/v1/workspaces', { root: repo });
    expect(created.body.data.is_git_repo).toBe(true);
    expect(created.body.data.branch).toBe('feature/x');

    const detached = join(home as string, 'detached');
    await mkdir(join(detached, '.git'), { recursive: true });
    await writeFile(
      join(detached, '.git', 'HEAD'),
      '0123456789abcdef0123456789abcdef01234567\n',
      'utf8',
    );
    const det = await postJson<WorkspaceWire>('/api/v1/workspaces', { root: detached });
    expect(det.body.data.is_git_repo).toBe(true);
    expect(det.body.data.branch).toBeNull();
  });

  it('resolves branch through a .git worktree file', async () => {
    const root = join(home as string, 'worktree');
    const realGitDir = join(home as string, 'real-git');
    await mkdir(realGitDir, { recursive: true });
    await writeFile(join(realGitDir, 'HEAD'), 'ref: refs/heads/wt-branch\n', 'utf8');
    await mkdir(root, { recursive: true });
    await writeFile(join(root, '.git'), `gitdir: ${realGitDir}\n`, 'utf8');

    const { body } = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
    expect(body.data.is_git_repo).toBe(true);
    expect(body.data.branch).toBe('wt-branch');
  });

  it('derives the default name from the root when name is omitted', async () => {
    const root = home as string;
    const { body } = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
    expect(body.code).toBe(0);
    expect(body.data.name.length).toBeGreaterThan(0);
  });

  it('is idempotent on root (createOrTouch)', async () => {
    const root = home as string;
    const first = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
    const second = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
    expect(first.body.data.id).toBe(second.body.data.id);
  });

  it('rejects a relative root (40001)', async () => {
    const { body } = await postJson<null>('/api/v1/workspaces', { root: 'relative/path' });
    expect(body.code).toBe(40001);
    expect(body.details?.[0]?.path).toBe('root');
  });

  it('rejects a nonexistent root (40409)', async () => {
    const missing = join(home as string, 'does-not-exist');
    const { body } = await postJson<null>('/api/v1/workspaces', { root: missing });
    expect(body.code).toBe(40409);
  });

  it('lists registered workspaces', async () => {
    const root = home as string;
    const created = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
    const { body } = await getJson<ListWire>('/api/v1/workspaces');
    expect(body.code).toBe(0);
    expect(body.data.items.some((w) => w.id === created.body.data.id)).toBe(true);
  });

  it('renames a workspace via PATCH', async () => {
    const root = home as string;
    const created = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
    const id = created.body.data.id;

    const updated = await patchJson<WorkspaceWire>(`/api/v1/workspaces/${id}`, { name: 'renamed' });
    expect(updated.body.code).toBe(0);
    expect(updated.body.data.name).toBe('renamed');
    expect(updated.body.data.id).toBe(id);
  });

  it('returns 40410 when patching an unknown workspace', async () => {
    const { body } = await patchJson<null>('/api/v1/workspaces/wd_missing_000000000000', {
      name: 'nope',
    });
    expect(body.code).toBe(40410);
  });

  it('deletes a workspace and 40410 on a second delete', async () => {
    const root = home as string;
    const created = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
    const id = created.body.data.id;

    const deleted = await deleteJson<{ deleted: boolean }>(`/api/v1/workspaces/${id}`);
    expect(deleted.body.code).toBe(0);
    expect(deleted.body.data).toEqual({ deleted: true });

    const again = await deleteJson<null>(`/api/v1/workspaces/${id}`);
    expect(again.body.code).toBe(40410);
  });

  it('reflects session_count for sessions created in the workspace', async () => {
    const root = home as string;
    const created = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
    expect(created.body.data.session_count).toBe(0);

    // Create a session bound to this workspace via cwd.
    const session = await postJson<{ id: string }>('/api/v1/sessions', { metadata: { cwd: root } });
    expect(session.body.code).toBe(0);

    const { body } = await getJson<ListWire>('/api/v1/workspaces');
    const ws = body.data.items.find((w) => w.id === created.body.data.id);
    expect(ws?.session_count).toBe(1);
  });

  it('excludes archived sessions from session_count', async () => {
    const root = home as string;
    const created = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
    const session = await postJson<{ id: string }>('/api/v1/sessions', {
      metadata: { cwd: root },
    });
    expect(session.body.code).toBe(0);

    const archive = await postJson<{ archived: boolean }>(
      `/api/v1/sessions/${session.body.data.id}:archive`,
    );
    expect(archive.body.code).toBe(0);

    const { body } = await getJson<ListWire>('/api/v1/workspaces');
    const workspace = body.data.items.find((item) => item.id === created.body.data.id);
    expect(workspace?.session_count).toBe(0);
  });
});
