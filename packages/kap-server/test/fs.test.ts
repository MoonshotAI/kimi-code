import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { IModelCatalog, IWorkspaceInstanceManager } from '@moonshot-ai/agent-core-v2';
import { HostFileSystem } from '@moonshot-ai/agent-core-v2/os/backends/node-local/hostFsService';
import { FakeRuntime } from '@moonshot-ai/agent-core-v2/runtime/fakeRuntime';
import { ErrorCode } from '../src/protocol/error-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

interface FsEntryWire {
  path: string;
  name: string;
  kind: string;
  size?: number;
  modified_at: string;
  etag?: string;
  mime?: string;
}

describe('server-v2 /api/v1 fs routes', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let work: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-home-'));
    work = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-work-'));
    const modelCatalog: IModelCatalog = {
      _serviceBrand: undefined,
      get: () => {
        throw new Error('modelCatalog.get not exercised in this test');
      },
      getRequester: () => {
        throw new Error('modelCatalog.getRequester not exercised in this test');
      },
      inspect: () => {
        throw new Error('modelCatalog.inspect not exercised in this test');
      },
      ping: () => {
        throw new Error('modelCatalog.ping not exercised in this test');
      },
      findByName: () => [],
      listModels: async () => [],
      listProviders: async () => [],
      getProvider: async () => {
        throw new Error('modelCatalog.getProvider not exercised in this test');
      },
      setDefaultModel: async () => {
        throw new Error('modelCatalog.setDefaultModel not exercised in this test');
      },
    };
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[IModelCatalog, modelCatalog]],
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      home = undefined;
    }
    if (work !== undefined) {
      await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      work = undefined;
    }
  });

  async function createSession(): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: work as string } }),
    } as never);
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function postFs<T>(id: string, action: string, body: unknown, runtimeId = 'local'): Promise<Envelope<T>> {
    const res = await fetch(`${base}/api/v1/sessions/${id}/fs:${action}`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ runtime_id: runtimeId, ...(body as object) }),
    } as never);
    return (await res.json()) as Envelope<T>;
  }

  it('defaults fs actions to the local runtime when runtime_id is omitted', async () => {
    await writeFile(join(work!, 'a.txt'), 'hello');
    const id = await createSession();
    const res = await fetch(`${base}/api/v1/sessions/${id}/fs:stat`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ path: 'a.txt' }),
    } as never);
    const body = (await res.json()) as Envelope<FsEntryWire>;
    expect(body.code).toBe(0);
    expect(body.data.name).toBe('a.txt');
  });

  it('fs:stat returns a file entry with the protocol shape', async () => {
    await writeFile(join(work!, 'a.txt'), 'hello');
    const id = await createSession();
    const body = await postFs<FsEntryWire>(id, 'stat', { path: 'a.txt' });
    expect(body.code).toBe(0);
    expect(body.data.name).toBe('a.txt');
    expect(body.data.kind).toBe('file');
    expect(body.data.size).toBe(5);
    expect(typeof body.data.modified_at).toBe('string');
    expect(typeof body.data.etag).toBe('string');
  });

  it('fs:stat maps a missing path to FS_PATH_NOT_FOUND', async () => {
    const id = await createSession();
    const body = await postFs<null>(id, 'stat', { path: 'nope.txt' });
    expect(body.code).toBe(ErrorCode.FS_PATH_NOT_FOUND);
  });

  it('fs:read returns utf-8 content', async () => {
    await writeFile(join(work!, 'a.txt'), 'hello world');
    const id = await createSession();
    const body = await postFs<{ content: string; encoding: string; size: number }>(
      id,
      'read',
      { path: 'a.txt' },
    );
    expect(body.code).toBe(0);
    expect(body.data.content).toBe('hello world');
    expect(body.data.encoding).toBe('utf-8');
    expect(body.data.size).toBe(11);
  });

  it('fs:read uses the selected non-local runtime and mapped workspace root', async () => {
    await writeFile(join(work!, 'selected.txt'), 'local');
    const remote = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-remote-'));
    await writeFile(join(remote, 'selected.txt'), 'remote');
    const id = await createSession();
    const provider = await server!.core.accessor.get(IWorkspaceInstanceManager).addProvider({
      id: 'remote-test-provider',
      imports: { root: [], imports: [], local: [] },
      attach: async (context, host) => {
        const runtime = Object.assign(
          new FakeRuntime(
            { workspaceId: context.id, runtimeId: 'remote-test', generation: 'remote-generation' },
            {
              capabilities: ['fs'],
              mapWorkspaceRoots: () => ({ workDir: remote, additionalDirs: [] }),
            },
          ),
          { fs: new HostFileSystem() },
        );
        const registration = host.registerRuntime(runtime);
        return { dispose: () => registration.remove() };
      },
    });
    try {
      const body = await postFs<{ content: string }>(
        id,
        'read',
        { path: 'selected.txt' },
        'remote-test',
      );
      expect(body.code).toBe(0);
      expect(body.data.content).toBe('remote');
    } finally {
      await provider.dispose();
      await rm(remote, { recursive: true, force: true });
    }
  });

  it('fs:read maps a directory to FS_IS_DIRECTORY', async () => {
    const id = await createSession();
    const body = await postFs<null>(id, 'read', { path: '.' });
    expect(body.code).toBe(ErrorCode.FS_IS_DIRECTORY);
  });

  it('fs:read maps a permission-denied host error to FS_PERMISSION_DENIED', async () => {
    if (process.getuid?.() === 0) return;
    const file = join(work!, 'locked.txt');
    await writeFile(file, 'secret');
    await chmod(file, 0o000);
    try {
      const id = await createSession();
      const body = await postFs<null>(id, 'read', { path: 'locked.txt' });
      expect(body.code).toBe(ErrorCode.FS_PERMISSION_DENIED);
    } finally {
      await chmod(file, 0o644);
    }
  });

  it('fs:list returns items', async () => {
    await writeFile(join(work!, 'a.txt'), '');
    await writeFile(join(work!, 'b.txt'), '');
    const id = await createSession();
    const body = await postFs<{ items: FsEntryWire[]; truncated: boolean }>(id, 'list', {});
    expect(body.code).toBe(0);
    const names = body.data.items.map((i) => i.name).sort();
    expect(names).toEqual(['a.txt', 'b.txt']);
    expect(body.data.truncated).toBe(false);
  });

  it('fs:mkdir creates a directory and rejects duplicates', async () => {
    const id = await createSession();
    const created = await postFs<FsEntryWire>(id, 'mkdir', { path: 'sub' });
    expect(created.code).toBe(0);
    expect(created.data.kind).toBe('directory');

    const dup = await postFs<null>(id, 'mkdir', { path: 'sub' });
    expect(dup.code).toBe(ErrorCode.FS_ALREADY_EXISTS);
  });

  it('fs:stat_many returns null for missing paths', async () => {
    await writeFile(join(work!, 'a.txt'), 'hi');
    const id = await createSession();
    const body = await postFs<{ entries: Record<string, FsEntryWire | null> }>(
      id,
      'stat_many',
      { paths: ['a.txt', 'missing.txt'] },
    );
    expect(body.code).toBe(0);
    expect(body.data.entries['a.txt']?.kind).toBe('file');
    expect(body.data.entries['missing.txt']).toBeNull();
  });

  it('fs:search finds files by query', async () => {
    await writeFile(join(work!, 'alpha.ts'), '');
    await writeFile(join(work!, 'beta.ts'), '');
    const id = await createSession();
    const body = await postFs<{ items: { path: string }[]; truncated: boolean }>(
      id,
      'search',
      { query: 'alpha' },
    );
    expect(body.code).toBe(0);
    expect(body.data.items.map((i) => i.path)).toContain('alpha.ts');
  });

  it('fs:search resolves a registered workspace id when no session exists', async () => {
    await writeFile(join(work!, 'gamma.ts'), '');
    const res = await fetch(`${base}/api/v1/workspaces`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ root: work }),
    } as never);
    const created = (await res.json()) as Envelope<{ id: string }>;
    expect(created.code).toBe(0);
    const body = await postFs<{ items: { path: string }[]; truncated: boolean }>(
      created.data.id,
      'search',
      { query: 'gamma' },
    );
    expect(body.code).toBe(0);
    expect(body.data.items.map((i) => i.path)).toContain('gamma.ts');
  });

  it('fs:search resolves an unregistered workspace root path', async () => {
    await writeFile(join(work!, 'delta.ts'), '');
    const body = await postFs<{ items: { path: string }[]; truncated: boolean }>(
      encodeURIComponent(work!),
      'search',
      { query: 'delta' },
    );
    expect(body.code).toBe(0);
    expect(body.data.items.map((i) => i.path)).toContain('delta.ts');
  });

  it('fs:search still maps an unknown ref to SESSION_NOT_FOUND', async () => {
    const body = await postFs<null>('does-not-exist', 'search', { query: 'x' });
    expect(body.code).toBe(ErrorCode.SESSION_NOT_FOUND);
  });

  it('fs:grep finds matching lines', async () => {
    await writeFile(join(work!, 'a.txt'), 'hello world\nfoo bar\n');
    const id = await createSession();
    const body = await postFs<{ files: { path: string; matches: unknown[] }[] }>(
      id,
      'grep',
      { pattern: 'hello' },
    );
    expect(body.code).toBe(0);
    expect(body.data.files.length).toBeGreaterThanOrEqual(1);
  });

  it('fs:git_status maps a non-git workspace to FS_GIT_UNAVAILABLE', async () => {
    const id = await createSession();
    const body = await postFs<null>(id, 'git_status', {});
    expect(body.code).toBe(ErrorCode.FS_GIT_UNAVAILABLE);
  });

  it('rejects an unknown action with VALIDATION_FAILED', async () => {
    const id = await createSession();
    const body = await postFs<null>(id, 'bogus', {});
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('maps an unknown session to SESSION_NOT_FOUND', async () => {
    const body = await postFs<null>('does-not-exist', 'stat', { path: 'a.txt' });
    expect(body.code).toBe(ErrorCode.SESSION_NOT_FOUND);
  });

  it('rejects a path that escapes the workspace', async () => {
    const id = await createSession();
    const body = await postFs<null>(id, 'stat', { path: '../etc/passwd' });
    expect(body.code).toBe(ErrorCode.FS_PATH_ESCAPES_SESSION);
  });

  it('rejects reads and downloads that escape the workspace through a symlink', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-outside-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'top-secret');
      await symlink(outside, join(work!, 'docs'), 'dir');
      const id = await createSession();

      const body = await postFs<null>(id, 'read', { path: 'docs/secret.txt' });
      expect(body.code).toBe(ErrorCode.FS_PATH_ESCAPES_SESSION);

      const res = await fetch(`${base}/api/v1/sessions/${id}/fs/docs/secret.txt:download?runtime_id=local`, {
        headers: authHeaders(server as RunningServer),
      } as never);
      const downloadBody = (await res.json()) as Envelope<null>;
      expect(downloadBody.code).toBe(ErrorCode.FS_PATH_ESCAPES_SESSION);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('serves fs actions when the session cwd itself goes through a symlink', async () => {
    const link = join(tmpdir(), `kimi-server-v2-fs-cwd-link-${process.pid}`);
    await symlink(work!, link, 'dir');
    try {
      const res = await fetch(`${base}/api/v1/sessions`, {
        method: 'POST',
        headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ metadata: { cwd: link } }),
      } as never);
      const body = (await res.json()) as Envelope<{ id: string }>;
      expect(body.code).toBe(0);

      await writeFile(join(work!, 'via-link.txt'), 'through-link');
      const read = await postFs<{ content: string }>(body.data.id, 'read', {
        path: 'via-link.txt',
      });
      expect(read.code).toBe(0);
      expect(read.data.content).toBe('through-link');
    } finally {
      await rm(link, { force: true });
    }
  });

  it('GET fs/{path}:download streams the file and honors If-None-Match', async () => {
    await writeFile(join(work!, 'a.txt'), 'download-me');
    const id = await createSession();

    const res = await fetch(`${base}/api/v1/sessions/${id}/fs/a.txt:download?runtime_id=local`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('download-me');
    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();

    const cached = await fetch(`${base}/api/v1/sessions/${id}/fs/a.txt:download?runtime_id=local`, {
      headers: authHeaders(server as RunningServer, { 'if-none-match': etag as string }),
    } as never);
    expect(cached.status).toBe(304);
  });

  it('GET fs/{path}:download defaults to the local runtime when runtime_id is omitted', async () => {
    await writeFile(join(work!, 'b.txt'), 'compat-download');
    const id = await createSession();

    const res = await fetch(`${base}/api/v1/sessions/${id}/fs/b.txt:download`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('compat-download');
  });

  it('GET fs/{path}:download untracks the stream from the runtime generation after completion', async () => {
    await writeFile(join(work!, 'c.txt'), 'tracked-download');
    const id = await createSession();
    const instance = server!.core.accessor.get(IWorkspaceInstanceManager).findByRoot(work!);
    expect(instance).toBeDefined();
    const generations = (instance!.runtimes as unknown as {
      currentGenerations: Map<string, { resources: Set<unknown> }>;
    }).currentGenerations;
    const resources = generations.get('local')!.resources;
    const baseline = resources.size;

    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`${base}/api/v1/sessions/${id}/fs/c.txt:download?runtime_id=local`, {
        headers: authHeaders(server as RunningServer),
      } as never);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('tracked-download');
      await vi.waitFor(() => expect(resources.size).toBe(baseline));
    }
  });

  async function postWorkspaceSearch<T>(body: unknown): Promise<Envelope<T>> {
    const res = await fetch(`${base}/api/v1/workspace/fs:search`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ runtime_id: 'local', ...(body as object) }),
    } as never);
    return (await res.json()) as Envelope<T>;
  }

  it('workspace fs:search finds files by registered workspace id', async () => {
    await writeFile(join(work!, 'epsilon.ts'), '');
    const res = await fetch(`${base}/api/v1/workspaces`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ root: work }),
    } as never);
    const created = (await res.json()) as Envelope<{ id: string }>;
    expect(created.code).toBe(0);

    const body = await postWorkspaceSearch<{ items: { path: string }[]; truncated: boolean }>({
      workspace: created.data.id,
      query: 'epsilon',
    });
    expect(body.code).toBe(0);
    expect(body.data.items.map((i) => i.path)).toContain('epsilon.ts');
  });

  it('workspace fs:search finds files by absolute root path', async () => {
    await writeFile(join(work!, 'zeta.ts'), '');
    const body = await postWorkspaceSearch<{ items: { path: string }[]; truncated: boolean }>({
      workspace: work,
      query: 'zeta',
    });
    expect(body.code).toBe(0);
    expect(body.data.items.map((i) => i.path)).toContain('zeta.ts');
  });

  it('workspace fs:search lists top-level entries for an empty query', async () => {
    await writeFile(join(work!, 'eta.ts'), '');
    const body = await postWorkspaceSearch<{ items: { path: string }[]; truncated: boolean }>({
      workspace: work,
      query: '',
    });
    expect(body.code).toBe(0);
    expect(body.data.items.map((i) => i.path)).toContain('eta.ts');
  });

  it('workspace fs:search defaults to the local runtime when runtime_id is omitted', async () => {
    await writeFile(join(work!, 'theta.ts'), '');
    const res = await fetch(`${base}/api/v1/workspace/fs:search`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ workspace: work, query: 'theta' }),
    } as never);
    const body = (await res.json()) as Envelope<{ items: { path: string }[]; truncated: boolean }>;
    expect(body.code).toBe(0);
    expect(body.data.items.map((i) => i.path)).toContain('theta.ts');
  });

  it('workspace fs:search maps an unknown ref to WORKSPACE_NOT_FOUND', async () => {
    const body = await postWorkspaceSearch<null>({ workspace: 'does-not-exist', query: 'x' });
    expect(body.code).toBe(ErrorCode.WORKSPACE_NOT_FOUND);
  });

  it('workspace fs:search rejects a missing workspace field with VALIDATION_FAILED', async () => {
    const body = await postWorkspaceSearch<null>({ query: 'x' });
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  interface SuggestItemWire {
    path: string;
    name: string;
    kind: string;
    score: number;
    match_positions: number[];
  }

  async function postWorkspaceSuggest<T>(body: unknown): Promise<Envelope<T>> {
    const res = await fetch(`${base}/api/v1/workspace/fs:suggest`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ runtime_id: 'local', ...(body as object) }),
    } as never);
    return (await res.json()) as Envelope<T>;
  }

  it('workspace fs:suggest finds files by registered workspace id', async () => {
    await writeFile(join(work!, 'epsilon.ts'), '');
    const res = await fetch(`${base}/api/v1/workspaces`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ root: work }),
    } as never);
    const created = (await res.json()) as Envelope<{ id: string }>;
    expect(created.code).toBe(0);

    const body = await postWorkspaceSuggest<{ items: SuggestItemWire[]; truncated: boolean }>({
      workspace: created.data.id,
      query: 'epsilon',
    });
    expect(body.code).toBe(0);
    expect(body.data.items.map((i) => i.path)).toContain('epsilon.ts');
  });

  it('workspace fs:suggest finds files by absolute root path', async () => {
    await writeFile(join(work!, 'zeta.ts'), '');
    const body = await postWorkspaceSuggest<{ items: SuggestItemWire[]; truncated: boolean }>({
      workspace: work,
      query: 'zeta',
    });
    expect(body.code).toBe(0);
    expect(body.data.items.map((i) => i.path)).toContain('zeta.ts');
  });

  it('workspace fs:suggest lists top-level entries for an empty query', async () => {
    await writeFile(join(work!, 'eta.ts'), '');
    const body = await postWorkspaceSuggest<{ items: SuggestItemWire[]; truncated: boolean }>({
      workspace: work,
      query: '',
    });
    expect(body.code).toBe(0);
    expect(body.data.items.map((i) => i.path)).toContain('eta.ts');
  });

  it('workspace fs:suggest matches path segments and returns scored items', async () => {
    await mkdir(join(work!, 'apps'));
    await mkdir(join(work!, 'apps', 'desktop'));
    await writeFile(join(work!, 'apps', 'desktop', 'package.json'), '{}');
    const body = await postWorkspaceSuggest<{ items: SuggestItemWire[]; truncated: boolean }>({
      workspace: work,
      query: 'apps/de',
    });
    expect(body.code).toBe(0);
    expect(body.data.items.length).toBeGreaterThan(0);
    expect(body.data.items[0]?.path).toBe('apps/desktop');
    expect(body.data.items[0]?.kind).toBe('directory');
    expect(body.data.items.map((i) => i.path)).toContain('apps/desktop/package.json');
    for (const item of body.data.items) {
      expect(item.score).toBeGreaterThan(0);
      expect(item.score).toBeLessThanOrEqual(1);
      expect(Array.isArray(item.match_positions)).toBe(true);
    }
  });

  it('workspace fs:suggest returns an empty list when a path-form query has no match', async () => {
    const body = await postWorkspaceSuggest<{ items: SuggestItemWire[]; truncated: boolean }>({
      workspace: work,
      query: 'zzz/qqq',
    });
    expect(body.code).toBe(0);
    expect(body.data.items).toEqual([]);
    expect(body.data.truncated).toBe(false);
  });

  it('workspace fs:suggest hides dotfiles by default and shows them with show_hidden', async () => {
    await writeFile(join(work!, '.theta.ts'), '');
    const hidden = await postWorkspaceSuggest<{ items: SuggestItemWire[] }>({
      workspace: work,
      query: 'theta',
    });
    expect(hidden.code).toBe(0);
    expect(hidden.data.items.map((i) => i.path)).not.toContain('.theta.ts');

    const shown = await postWorkspaceSuggest<{ items: SuggestItemWire[] }>({
      workspace: work,
      query: 'theta',
      show_hidden: true,
    });
    expect(shown.code).toBe(0);
    expect(shown.data.items.map((i) => i.path)).toContain('.theta.ts');
  });

  it('workspace fs:suggest defaults to the local runtime when runtime_id is omitted', async () => {
    await writeFile(join(work!, 'iota.ts'), '');
    const res = await fetch(`${base}/api/v1/workspace/fs:suggest`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ workspace: work, query: 'iota' }),
    } as never);
    const body = (await res.json()) as Envelope<{ items: SuggestItemWire[]; truncated: boolean }>;
    expect(body.code).toBe(0);
    expect(body.data.items.map((i) => i.path)).toContain('iota.ts');
  });

  it('workspace fs:suggest maps an unknown ref to WORKSPACE_NOT_FOUND', async () => {
    const body = await postWorkspaceSuggest<null>({ workspace: 'does-not-exist', query: 'x' });
    expect(body.code).toBe(ErrorCode.WORKSPACE_NOT_FOUND);
  });

  it('workspace fs:suggest rejects a missing workspace field with VALIDATION_FAILED', async () => {
    const body = await postWorkspaceSuggest<null>({ query: 'x' });
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('workspace fs:suggest rejects a missing query field with VALIDATION_FAILED', async () => {
    const body = await postWorkspaceSuggest<null>({ workspace: work });
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  async function postRootSuggest<T>(body: unknown): Promise<Envelope<T>> {
    const res = await fetch(`${base}/api/v1/fs:suggest`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    } as never);
    return (await res.json()) as Envelope<T>;
  }

  async function listWorkspaces(): Promise<{ id: string; root: string }[]> {
    const res = await fetch(`${base}/api/v1/workspaces`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const body = (await res.json()) as Envelope<{ items: { id: string; root: string }[] }>;
    expect(body.code).toBe(0);
    return body.data.items;
  }

  it('fs:suggest serves an unregistered root without touching the workspace catalog', async () => {
    await writeFile(join(work!, 'kappa.ts'), '');
    const body = await postRootSuggest<{ items: SuggestItemWire[]; truncated: boolean }>({
      roots: [work],
      query: 'kappa',
    });
    expect(body.code).toBe(0);
    expect(body.data.items.map((i) => i.path)).toContain('kappa.ts');

    expect(await listWorkspaces()).toEqual([]);
    expect(server!.core.accessor.get(IWorkspaceInstanceManager).list()).toEqual([]);

    const again = await postRootSuggest<{ items: SuggestItemWire[] }>({
      roots: [work],
      query: 'kappa',
    });
    expect(again.code).toBe(0);
    expect(await listWorkspaces()).toEqual([]);
  });

  it('fs:suggest matches the workspace route for the same single root', async () => {
    await mkdir(join(work!, 'apps'));
    await mkdir(join(work!, 'apps', 'desktop'));
    await writeFile(join(work!, 'apps', 'desktop', 'package.json'), '{}');
    await writeFile(join(work!, 'README.md'), '');
    const viaWorkspace = await postWorkspaceSuggest<{ items: SuggestItemWire[]; truncated: boolean }>({
      workspace: work,
      query: 'apps/de',
    });
    const viaRoots = await postRootSuggest<{ items: SuggestItemWire[]; truncated: boolean }>({
      roots: [work],
      query: 'apps/de',
    });
    expect(viaWorkspace.code).toBe(0);
    expect(viaRoots.code).toBe(0);
    expect(viaRoots.data).toEqual(viaWorkspace.data);
  });

  it('fs:suggest merges candidates across roots with relative paths for the primary root only', async () => {
    const extra = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-extra-'));
    try {
      await writeFile(join(work!, 'shared-name.ts'), '');
      await mkdir(join(extra, 'lib'));
      await writeFile(join(extra, 'lib', 'util.ts'), '');
      const body = await postRootSuggest<{ items: SuggestItemWire[]; truncated: boolean }>({
        roots: [work, extra],
        query: 'util',
      });
      expect(body.code).toBe(0);
      expect(body.data.items.map((i) => i.path)).toContain(join(extra, 'lib', 'util.ts').split(sep).join('/'));
      const shared = await postRootSuggest<{ items: SuggestItemWire[] }>({
        roots: [work, extra],
        query: 'shared',
      });
      expect(shared.data.items.map((i) => i.path)).toContain('shared-name.ts');
    } finally {
      await rm(extra, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('fs:suggest lists top-level entries of every root for an empty query', async () => {
    const extra = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-extra-'));
    try {
      await writeFile(join(work!, 'top-work.ts'), '');
      await writeFile(join(extra, 'top-extra.ts'), '');
      const body = await postRootSuggest<{ items: SuggestItemWire[]; truncated: boolean }>({
        roots: [work, extra],
        query: '',
      });
      expect(body.code).toBe(0);
      const paths = body.data.items.map((i) => i.path);
      expect(paths).toContain('top-work.ts');
      expect(paths).toContain(join(extra, 'top-extra.ts').split(sep).join('/'));
    } finally {
      await rm(extra, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('fs:suggest deduplicates overlapping roots', async () => {
    await mkdir(join(work!, 'sub'));
    await writeFile(join(work!, 'sub', 'dup.ts'), '');
    await writeFile(join(work!, 'top.ts'), '');
    const nested = await postRootSuggest<{ items: SuggestItemWire[] }>({
      roots: [work, join(work!, 'sub')],
      query: 'dup',
    });
    expect(nested.code).toBe(0);
    expect(nested.data.items.filter((i) => i.path === join('sub', 'dup.ts').split(sep).join('/'))).toHaveLength(1);

    const reversed = await postRootSuggest<{ items: SuggestItemWire[] }>({
      roots: [join(work!, 'sub'), work],
      query: 'dup',
    });
    expect(reversed.code).toBe(0);
    expect(reversed.data.items.filter((i) => i.path === 'dup.ts')).toHaveLength(1);
    const top = await postRootSuggest<{ items: SuggestItemWire[] }>({
      roots: [join(work!, 'sub'), work],
      query: 'top',
    });
    expect(top.data.items.map((i) => i.path)).toContain(join(work!, 'top.ts').split(sep).join('/'));
  });

  it('fs:suggest applies the limit to the merged ranking across roots', async () => {
    const extra = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-extra-'));
    try {
      await writeFile(join(work!, 'a1.ts'), '');
      await writeFile(join(extra, 'a2.ts'), '');
      await writeFile(join(extra, 'a3.ts'), '');
      const body = await postRootSuggest<{ items: SuggestItemWire[]; truncated: boolean }>({
        roots: [work, extra],
        query: 'a',
        limit: 2,
      });
      expect(body.code).toBe(0);
      expect(body.data.items).toHaveLength(2);
      expect(body.data.truncated).toBe(true);
    } finally {
      await rm(extra, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('fs:suggest honors follow_gitignore on each root', async () => {
    const extra = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-extra-'));
    try {
      await writeFile(join(extra, '.gitignore'), 'ignored-extra.ts\n');
      await writeFile(join(extra, 'ignored-extra.ts'), '');
      const followed = await postRootSuggest<{ items: SuggestItemWire[] }>({
        roots: [extra],
        query: 'ignored',
      });
      expect(followed.code).toBe(0);
      expect(followed.data.items).toEqual([]);
      const ignored = await postRootSuggest<{ items: SuggestItemWire[] }>({
        roots: [extra],
        query: 'ignored',
        follow_gitignore: false,
      });
      expect(ignored.code).toBe(0);
      expect(ignored.data.items.map((i) => i.path)).toContain('ignored-extra.ts');
    } finally {
      await rm(extra, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('fs:suggest maps a missing root to FS_PATH_NOT_FOUND', async () => {
    const body = await postRootSuggest<null>({
      roots: [join(work!, 'no-such-dir')],
      query: 'x',
    });
    expect(body.code).toBe(ErrorCode.FS_PATH_NOT_FOUND);
  });

  it('fs:suggest maps a non-directory root to FS_PATH_NOT_FOUND', async () => {
    await writeFile(join(work!, 'a-file.ts'), '');
    const body = await postRootSuggest<null>({ roots: [join(work!, 'a-file.ts')], query: 'x' });
    expect(body.code).toBe(ErrorCode.FS_PATH_NOT_FOUND);
  });

  it('fs:suggest rejects a relative root with VALIDATION_FAILED', async () => {
    const body = await postRootSuggest<null>({ roots: ['relative/path'], query: 'x' });
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('fs:suggest rejects a missing roots field with VALIDATION_FAILED', async () => {
    const body = await postRootSuggest<null>({ query: 'x' });
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('fs:suggest rejects more than 32 roots with VALIDATION_FAILED', async () => {
    const roots = Array.from({ length: 33 }, (_, i) => join(work!, `root-${i}`));
    const body = await postRootSuggest<null>({ roots, query: 'x' });
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('fs:suggest rejects a missing query field with VALIDATION_FAILED', async () => {
    const body = await postRootSuggest<null>({ roots: [work] });
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('fs:suggest maps an unknown runtime to RUNTIME_NOT_FOUND', async () => {
    const body = await postRootSuggest<null>({
      roots: [work],
      query: 'x',
      runtime_id: 'no-such-runtime',
    });
    expect(body.code).toBe(ErrorCode.RUNTIME_NOT_FOUND);
  });
});
