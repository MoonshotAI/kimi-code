import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { IAtomicDocumentStore, IWorkspaceInstanceManager } from '@moonshot-ai/agent-core-v2';
import { encodeWorkDirKey } from '@moonshot-ai/agent-core-v2/_base/utils/workdir-slug';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: ({ path: string; message: string } | { path: string; directory: string })[];
}

interface WorkspaceWire {
  id: string;
  root: string;
  name: string;
  kind: 'managed' | 'implicit';
  additional_dirs: string[];
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

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-workspaces-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
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
    expect(body.data.id).toMatch(/^wm_[0-9a-f-]{36}$/);
    expect(body.data.additional_dirs).toEqual([]);
    expect(typeof body.data.session_count).toBe('number');
    expect(Number.isNaN(Date.parse(body.data.created_at))).toBe(false);
    expect(Number.isNaN(Date.parse(body.data.last_opened_at))).toBe(false);
  });

  it('derives the default name from the root when name is omitted', async () => {
    const root = home as string;
    const { body } = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
    expect(body.code).toBe(0);
    expect(body.data.name.length).toBeGreaterThan(0);
  });

  it('mints a fresh wm_ id per call and dedupes retries by idempotency_key', async () => {
    const root = home as string;
    const first = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
    const second = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
    expect(first.body.data.id).not.toBe(second.body.data.id);

    const keyed = await postJson<WorkspaceWire>('/api/v1/workspaces', {
      root,
      idempotency_key: 'retry-key-1',
    });
    const retried = await postJson<WorkspaceWire>('/api/v1/workspaces', {
      root,
      idempotency_key: 'retry-key-1',
    });
    expect(retried.body.data.id).toBe(keyed.body.data.id);
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

  it('attributes sessions by channel: explicit workspace_id to its bucket, cwd to the hash bucket', async () => {
    const root = home as string;
    const created = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
    const wmId = created.body.data.id;
    expect(created.body.data.session_count).toBe(0);

    const explicit = await postJson<{ id: string; workspace_id: string }>('/api/v1/sessions', {
      workspace_id: wmId,
    });
    expect(explicit.body.code).toBe(0);
    expect(explicit.body.data.workspace_id).toBe(wmId);

    const viaCwd = await postJson<{ id: string; workspace_id: string }>('/api/v1/sessions', {
      metadata: { cwd: root },
    });
    expect(viaCwd.body.code).toBe(0);
    expect(viaCwd.body.data.workspace_id).toMatch(/^wd_[a-z0-9._-]+_[0-9a-f]{12}$/);
    const wdId = viaCwd.body.data.workspace_id;
    expect(wdId).not.toBe(wmId);

    const { body } = await getJson<ListWire>('/api/v1/workspaces');
    const wm = body.data.items.find((w) => w.id === wmId);
    const wd = body.data.items.find((w) => w.id === wdId);
    expect(wm?.session_count).toBe(1);
    expect(wd?.session_count).toBe(1);

    const wmSessions = await getJson<{ items: { id: string }[] }>(
      `/api/v1/sessions?workspace_id=${encodeURIComponent(wmId)}`,
    );
    expect(wmSessions.body.data.items.map((s) => s.id)).toEqual([explicit.body.data.id]);
    const wdSessions = await getJson<{ items: { id: string }[] }>(
      `/api/v1/sessions?workspace_id=${encodeURIComponent(wdId)}`,
    );
    expect(wdSessions.body.data.items.map((s) => s.id)).toEqual([viaCwd.body.data.id]);
  });

  it('creates a workspace with additional_dirs and reflects them in GET', async () => {
    const root = home as string;
    const extraA = join(root, 'extra-a');
    const extraB = join(root, 'nested', 'extra-b');
    await mkdir(extraA, { recursive: true });
    await mkdir(extraB, { recursive: true });

    const created = await postJson<WorkspaceWire>('/api/v1/workspaces', {
      root,
      additional_dirs: [extraA, 'nested/extra-b'],
    });
    expect(created.body.code).toBe(0);
    expect(created.body.data.additional_dirs).toEqual([extraA, extraB]);

    const { body } = await getJson<ListWire>('/api/v1/workspaces');
    const ws = body.data.items.find((w) => w.id === created.body.data.id);
    expect(ws?.additional_dirs).toEqual([extraA, extraB]);
  });

  it('rejects invalid additional_dirs on create (40409 / 40006)', async () => {
    const root = home as string;
    const missing = await postJson<null>('/api/v1/workspaces', {
      root,
      additional_dirs: [join(root, 'does-not-exist')],
    });
    expect(missing.body.code).toBe(40409);

    const dupRoot = await postJson<null>('/api/v1/workspaces', {
      root,
      additional_dirs: [root],
    });
    expect(dupRoot.body.code).toBe(40006);
    expect(dupRoot.body.msg).toBe(`Duplicate source folder: ${root}`);
    expect(dupRoot.body.details).toEqual([{ path: 'additional_dirs.0', directory: root }]);

    const extra = join(root, 'extra-dup');
    await mkdir(extra, { recursive: true });
    const dup = await postJson<null>('/api/v1/workspaces', {
      root,
      additional_dirs: [extra, `${extra}/`],
    });
    expect(dup.body.code).toBe(40006);
    expect(dup.body.msg).toBe(`Duplicate source folder: ${extra}`);
    expect(dup.body.details).toEqual([{ path: 'additional_dirs.1', directory: extra }]);
  });

  it('replaces additional_dirs wholesale via PATCH and validates input', async () => {
    const root = home as string;
    const extraA = join(root, 'patch-a');
    const extraB = join(root, 'patch-b');
    await mkdir(extraA, { recursive: true });
    await mkdir(extraB, { recursive: true });
    const created = await postJson<WorkspaceWire>('/api/v1/workspaces', {
      root,
      additional_dirs: [extraA],
    });
    const id = created.body.data.id;

    const replaced = await patchJson<WorkspaceWire>(`/api/v1/workspaces/${id}`, {
      additional_dirs: [extraB],
      name: 'renamed',
    });
    expect(replaced.body.code).toBe(0);
    expect(replaced.body.data.additional_dirs).toEqual([extraB]);
    expect(replaced.body.data.name).toBe('renamed');

    const nameOnly = await patchJson<WorkspaceWire>(`/api/v1/workspaces/${id}`, { name: 'again' });
    expect(nameOnly.body.data.additional_dirs).toEqual([extraB]);

    const cleared = await patchJson<WorkspaceWire>(`/api/v1/workspaces/${id}`, {
      additional_dirs: [],
    });
    expect(cleared.body.data.additional_dirs).toEqual([]);

    const empty = await patchJson<null>(`/api/v1/workspaces/${id}`, {});
    expect(empty.body.code).toBe(40001);

    const missing = await patchJson<null>(`/api/v1/workspaces/${id}`, {
      additional_dirs: [join(root, 'does-not-exist')],
    });
    expect(missing.body.code).toBe(40409);

    const dupRoot = await patchJson<null>(`/api/v1/workspaces/${id}`, { additional_dirs: [root] });
    expect(dupRoot.body.code).toBe(40006);
    expect(dupRoot.body.msg).toBe(`Duplicate source folder: ${root}`);
    expect(dupRoot.body.details).toEqual([{ path: 'additional_dirs.0', directory: root }]);

    const dup = await patchJson<null>(`/api/v1/workspaces/${id}`, {
      additional_dirs: [extraB, `${extraB}/`],
    });
    expect(dup.body.code).toBe(40006);
    expect(dup.body.msg).toBe(`Duplicate source folder: ${extraB}`);
    expect(dup.body.details).toEqual([{ path: 'additional_dirs.1', directory: extraB }]);

    const unknown = await patchJson<null>(
      '/api/v1/workspaces/wm_00000000-0000-0000-0000-000000000000',
      { name: 'nope' },
    );
    expect(unknown.body.code).toBe(40410);
  });

  it('promotes a source folder to primary (atomic swap, bucket unchanged)', async () => {
    const root = home as string;
    const extra = join(root, 'primary-candidate');
    await mkdir(extra, { recursive: true });
    const created = await postJson<WorkspaceWire>('/api/v1/workspaces', {
      root,
      additional_dirs: [extra],
    });
    const id = created.body.data.id;

    const promoted = await postJson<WorkspaceWire>(`/api/v1/workspaces/${id}/primary`, {
      path: extra,
    });
    expect(promoted.body.code).toBe(0);
    expect(promoted.body.data.id).toBe(id);
    expect(promoted.body.data.root).toBe(extra);
    expect(promoted.body.data.additional_dirs).toEqual([root]);

    const session = await postJson<{ workspace_id: string; metadata: { cwd: string } }>(
      '/api/v1/sessions',
      { workspace_id: id },
    );
    expect(session.body.code).toBe(0);
    expect(session.body.data.workspace_id).toBe(id);
    expect(session.body.data.metadata.cwd).toBe(extra);
  });

  it('rejects invalid primary paths and unknown workspaces (40001/40409/40410)', async () => {
    const root = home as string;
    const created = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
    const id = created.body.data.id;

    const outside = join(root, 'outside-dir');
    await mkdir(outside, { recursive: true });
    const notInSet = await postJson<null>(`/api/v1/workspaces/${id}/primary`, { path: outside });
    expect(notInSet.body.code).toBe(40001);
    expect(notInSet.body.details?.[0]?.path).toBe('path');

    const vanished = join(root, 'vanished-dir');
    await mkdir(vanished, { recursive: true });
    const widened = await patchJson<WorkspaceWire>(`/api/v1/workspaces/${id}`, {
      additional_dirs: [vanished],
    });
    expect(widened.body.code).toBe(0);
    await rm(vanished, { recursive: true, force: true });
    const gone = await postJson<null>(`/api/v1/workspaces/${id}/primary`, { path: vanished });
    expect(gone.body.code).toBe(40409);

    const unknown = await postJson<null>(
      '/api/v1/workspaces/wm_00000000-0000-0000-0000-000000000000/primary',
      { path: root },
    );
    expect(unknown.body.code).toBe(40410);
  });

  it('create ignores the primary local.toml additional_dir and leaves the file untouched', async () => {
    const root = home as string;
    const extra = join(root, 'toml-extra');
    await mkdir(extra, { recursive: true });
    await mkdir(join(root, '.kimi-code'), { recursive: true });
    await writeFile(
      join(root, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = ["${extra}"]\n`,
      'utf8',
    );

    const created = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
    expect(created.body.code).toBe(0);
    expect(created.body.data.additional_dirs).toEqual([]);
    expect(created.body.data.kind).toBe('managed');
    const text = await readFile(join(root, '.kimi-code', 'local.toml'), 'utf8');
    expect(text).toContain('toml-extra');
  });

  it('project-config-dirs reads local.toml dirs without mutating anything', async () => {
    const root = home as string;
    const extra = join(root, 'toml-import');
    await mkdir(extra, { recursive: true });
    await mkdir(join(root, '.kimi-code'), { recursive: true });
    await writeFile(
      join(root, '.kimi-code', 'local.toml'),
      `[workspace]\nadditional_dir = ["${extra}"]\n`,
      'utf8',
    );

    const read = await getJson<{ additional_dirs: string[] }>(
      `/api/v1/workspaces/project-config-dirs?root=${encodeURIComponent(root)}`,
    );
    expect(read.body.code).toBe(0);
    expect(read.body.data.additional_dirs).toEqual([extra]);

    const created = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
    expect(created.body.data.additional_dirs).toEqual([]);
    const text = await readFile(join(root, '.kimi-code', 'local.toml'), 'utf8');
    expect(text).toContain('toml-import');

    const missing = await getJson<{ additional_dirs: string[] }>(
      '/api/v1/workspaces/project-config-dirs?root=',
    );
    expect(missing.body.code).not.toBe(0);
  });

  it('sums session_count across legacy split buckets of one root', async () => {
    const typedRoot = 'C:\\Users\\Foo\\Proj';
    const lowerRoot = 'c:\\users\\foo\\proj';
    const typedId = encodeWorkDirKey(typedRoot);
    const lowerId = encodeWorkDirKey(lowerRoot);
    await writeFile(
      join(home as string, 'projects.json'),
      JSON.stringify({
        schema_version: 2,
        projects: {
          [typedId]: {
            root: typedRoot,
            name: 'proj',
            kind: 'implicit',
            created_at: '2024-01-01T00:00:00.000Z',
            last_opened_at: '2024-01-01T00:00:00.000Z',
          },
          [lowerId]: {
            root: lowerRoot,
            name: 'proj',
            kind: 'implicit',
            created_at: '2024-01-01T00:00:00.000Z',
            last_opened_at: '2024-01-01T00:00:00.000Z',
          },
        },
        deleted_project_ids: [],
      }),
      'utf8',
    );
    const seedBucket = async (
      wsId: string,
      sid: string,
      meta: Record<string, unknown>,
    ): Promise<void> => {
      const dir = join(home as string, 'sessions', wsId, sid);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'state.json'),
        JSON.stringify({ version: 2, cwd: typedRoot, createdAt: 1, updatedAt: 1, ...meta }),
        'utf8',
      );
    };
    await seedBucket(typedId, 's-typed', {});
    await seedBucket(lowerId, 's-lower', { archived: true, updatedAt: 2 });

    await vi.waitFor(async () => {
      const { body } = await getJson<ListWire>('/api/v1/workspaces');
      expect(body.code).toBe(0);
      const unions = body.data.items.filter((w) => [typedId, lowerId].includes(w.id));
      expect(unions).toHaveLength(1);
      expect(unions[0]?.session_count).toBe(2);
    });
  });

  it('reads and writes trust without materializing the workspace runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-server-v2-workspaces-trust-no-runtime-'));
    try {
      const created = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
      expect(created.body.code).toBe(0);
      const id = created.body.data.id;
      const manager = (server as RunningServer).core.accessor.get(IWorkspaceInstanceManager);
      const acquire = vi.spyOn(manager, 'acquire').mockRejectedValue(
        new Error('runtime environment unavailable'),
      );
      try {
        const initial = await getJson<{ trusted: boolean }>(`/api/v1/workspaces/${id}/trust`);
        expect(initial.body.code).toBe(0);
        expect(initial.body.data.trusted).toBe(false);

        const trusted = await postJson<{ trusted: boolean }>(`/api/v1/workspaces/${id}/trust`);
        expect(trusted.body.code).toBe(0);
        expect(trusted.body.data.trusted).toBe(true);

        const revoked = await postJson<{ trusted: boolean }>(`/api/v1/workspaces/${id}/untrust`);
        expect(revoked.body.code).toBe(0);
        expect(revoked.body.data.trusted).toBe(false);
        expect(acquire).not.toHaveBeenCalled();
      } finally {
        acquire.mockRestore();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns trust storage errors with their original message and request id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-server-v2-workspaces-trust-error-'));
    try {
      const created = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
      const id = created.body.data.id;
      const docs = (server as RunningServer).core.accessor.get(IAtomicDocumentStore);
      const failure = new Error('trust storage unavailable');
      const read = vi.spyOn(docs, 'get').mockRejectedValue(failure);
      try {
        const responses = [
          await getJson<{ trusted: boolean }>(`/api/v1/workspaces/${id}/trust`),
          await postJson<{ trusted: boolean }>(`/api/v1/workspaces/${id}/trust`),
          await postJson<{ trusted: boolean }>(`/api/v1/workspaces/${id}/untrust`),
        ];
        for (const response of responses) {
          expect(response.body.code).toBe(50001);
          expect(response.body.msg).toBe(failure.message);
          expect(response.body.request_id).not.toBe('');
        }
      } finally {
        read.mockRestore();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns trust write and delete failures and allows later mutations to succeed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-server-v2-workspaces-trust-mutation-error-'));
    try {
      const created = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
      const id = created.body.data.id;
      const docs = (server as RunningServer).core.accessor.get(IAtomicDocumentStore);
      await getJson<{ trusted: boolean }>(`/api/v1/workspaces/${id}/trust`);

      const writeFailure = new Error('trust marker write failed');
      const write = vi.spyOn(docs, 'set').mockRejectedValueOnce(writeFailure);
      const writeError = await postJson<{ trusted: boolean }>(`/api/v1/workspaces/${id}/trust`);
      expect(writeError.body.code).toBe(50001);
      expect(writeError.body.msg).toBe(writeFailure.message);
      expect(writeError.body.request_id).not.toBe('');
      write.mockRestore();

      const trusted = await postJson<{ trusted: boolean }>(`/api/v1/workspaces/${id}/trust`);
      expect(trusted.body.code).toBe(0);
      expect(trusted.body.data.trusted).toBe(true);

      const deleteFailure = new Error('trust marker delete failed');
      const deletion = vi.spyOn(docs, 'delete').mockRejectedValueOnce(deleteFailure);
      const deleteError = await postJson<{ trusted: boolean }>(`/api/v1/workspaces/${id}/untrust`);
      expect(deleteError.body.code).toBe(50001);
      expect(deleteError.body.msg).toBe(deleteFailure.message);
      expect(deleteError.body.request_id).not.toBe('');
      deletion.mockRestore();

      const revoked = await postJson<{ trusted: boolean }>(`/api/v1/workspaces/${id}/untrust`);
      expect(revoked.body.code).toBe(0);
      expect(revoked.body.data.trusted).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reloads project config when trust initialization recovers to an existing marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-server-v2-workspaces-trust-recovery-'));
    try {
      await mkdir(join(root, '.kimi-code'), { recursive: true });
      await writeFile(
        join(root, '.kimi-code', 'mcp.json'),
        JSON.stringify({ mcpServers: { projectOnly: { command: 'project-only' } } }),
        'utf8',
      );
      const created = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
      const id = created.body.data.id;
      const docs = (server as RunningServer).core.accessor.get(IAtomicDocumentStore);
      await docs.set('workspace-trust', encodeWorkDirKey(root), { root, trustedAt: 1 });
      const manager = (server as RunningServer).core.accessor.get(IWorkspaceInstanceManager);
      const read = docs.get.bind(docs);
      let shouldFail = true;
      let failed = false;
      const get = vi.spyOn(docs, 'get').mockImplementation(async <T>(scope: string, key: string) => {
        if (shouldFail && scope === 'workspace-trust') {
          shouldFail = false;
          failed = true;
          throw new Error('temporary trust read failure');
        }
        return read<T>(scope, key);
      });
      let release: (() => void) | undefined;
      try {
        const lease = await manager.acquire({ workspaceId: id, root });
        release = () => lease.dispose();
        const workspace = lease.instance;
        await workspace.program.mcpConfig.ready;
        expect(failed).toBe(true);
        expect(workspace.program.mcpConfig.servers()).toEqual({});
        const recovered: boolean[] = [];
        workspace.program.trust.onDidChange((change) => recovered.push(change.trusted));

        const trusted = await postJson<{ trusted: boolean }>(`/api/v1/workspaces/${id}/trust`);
        expect(trusted.body.code).toBe(0);
        expect(trusted.body.data.trusted).toBe(true);
        expect(workspace.program.trust.isTrusted()).toBe(true);

        await vi.waitFor(() => {
          expect(workspace.program.mcpConfig.servers()).toHaveProperty('projectOnly');
        });
        expect(recovered).toEqual([true]);
      } finally {
        get.mockRestore();
        release?.();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reloads project config after a failed initial read under the environment override', async () => {
    vi.stubEnv('KIMI_CODE_TRUST_WORKSPACE', '1');
    const root = await mkdtemp(join(tmpdir(), 'kimi-server-v2-workspaces-trust-env-recovery-'));
    try {
      await mkdir(join(root, '.kimi-code'), { recursive: true });
      await writeFile(
        join(root, '.kimi-code', 'mcp.json'),
        JSON.stringify({ mcpServers: { projectOnly: { command: 'project-only' } } }),
        'utf8',
      );
      const created = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
      const id = created.body.data.id;
      const docs = (server as RunningServer).core.accessor.get(IAtomicDocumentStore);
      const manager = (server as RunningServer).core.accessor.get(IWorkspaceInstanceManager);
      const read = docs.get.bind(docs);
      let shouldFail = true;
      let failed = false;
      const get = vi.spyOn(docs, 'get').mockImplementation(async <T>(scope: string, key: string) => {
        if (shouldFail && scope === 'workspace-trust') {
          shouldFail = false;
          failed = true;
          throw new Error('temporary trust read failure');
        }
        return read<T>(scope, key);
      });
      let release: (() => void) | undefined;
      try {
        const lease = await manager.acquire({ workspaceId: id, root });
        release = () => lease.dispose();
        const workspace = lease.instance;
        await workspace.program.mcpConfig.ready;
        expect(failed).toBe(true);
        expect(workspace.program.mcpConfig.servers()).toEqual({});

        const revoked = await postJson<{ trusted: boolean }>(`/api/v1/workspaces/${id}/untrust`);
        expect(revoked.body.code).toBe(0);
        expect(revoked.body.data.trusted).toBe(true);

        await vi.waitFor(() => {
          expect(workspace.program.mcpConfig.servers()).toHaveProperty('projectOnly');
        });
      } finally {
        get.mockRestore();
        release?.();
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('shares route trust changes with an already materialized workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kimi-server-v2-workspaces-trust-shared-'));
    const created = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
    expect(created.body.code).toBe(0);
    const id = created.body.data.id;
    const manager = (server as RunningServer).core.accessor.get(IWorkspaceInstanceManager);
    let release: (() => void) | undefined;
    try {
      const lease = await manager.acquire({ workspaceId: id, root });
      release = () => lease.dispose();
      const workspace = lease.instance;
      await workspace.program.trust.ready;
      const events: boolean[] = [];
      workspace.program.trust.onDidChange((change) => events.push(change.trusted));

      const trusted = await postJson<{ trusted: boolean }>(`/api/v1/workspaces/${id}/trust`);
      expect(trusted.body.code).toBe(0);
      expect(workspace.program.trust.isTrusted()).toBe(true);

      const revoked = await postJson<{ trusted: boolean }>(`/api/v1/workspaces/${id}/untrust`);
      expect(revoked.body.code).toBe(0);
      expect(workspace.program.trust.isTrusted()).toBe(false);
      expect(events).toEqual([true, false]);
    } finally {
      release?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports the effective trust state after untrust while KIMI_CODE_TRUST_WORKSPACE is set', async () => {
    vi.stubEnv('KIMI_CODE_TRUST_WORKSPACE', '1');
    const root = await mkdtemp(join(tmpdir(), 'kimi-server-v2-workspaces-trust-env-'));
    try {
      const created = await postJson<WorkspaceWire>('/api/v1/workspaces', { root });
      expect(created.body.code).toBe(0);
      const id = created.body.data.id;

      const revoked = await postJson<{ trusted: boolean }>(`/api/v1/workspaces/${id}/untrust`);
      expect(revoked.body.code).toBe(0);
      expect(revoked.body.data.trusted).toBe(true);

      const read = await getJson<{ trusted: boolean }>(`/api/v1/workspaces/${id}/trust`);
      expect(read.body.code).toBe(0);
      expect(read.body.data.trusted).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  });
});
