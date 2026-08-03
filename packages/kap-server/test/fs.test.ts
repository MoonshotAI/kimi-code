import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IModelCatalog } from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../src/protocol/error-codes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  /** Session work dir — kept separate from the server homeDir so the server's
   *  own state (session storage under homeDir) does not pollute `fs:list`. */
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
      // maxRetries: the async query-store shard writer can still be flushing
      // after close (ENOTEMPTY on macOS) — same retry pattern as sessions.test.ts.
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

  async function postFs<T>(id: string, action: string, body: unknown): Promise<Envelope<T>> {
    const res = await fetch(`${base}/api/v1/sessions/${id}/fs:${action}`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    } as never);
    return (await res.json()) as Envelope<T>;
  }

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

  it('fs:read maps a directory to FS_IS_DIRECTORY', async () => {
    const id = await createSession();
    const body = await postFs<null>(id, 'read', { path: '.' });
    expect(body.code).toBe(ErrorCode.FS_IS_DIRECTORY);
  });

  it('fs:read maps a permission-denied host error to FS_PERMISSION_DENIED', async () => {
    // Root bypasses permission checks, so EACCES never triggers there.
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
    // Register the workspace without creating any session (the kimi-web
    // new-session draft addresses the workspace directly).
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

      const res = await fetch(`${base}/api/v1/sessions/${id}/fs/docs/secret.txt:download`, {
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

    const res = await fetch(`${base}/api/v1/sessions/${id}/fs/a.txt:download`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('download-me');
    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();

    const cached = await fetch(`${base}/api/v1/sessions/${id}/fs/a.txt:download`, {
      headers: authHeaders(server as RunningServer, { 'if-none-match': etag as string }),
    } as never);
    expect(cached.status).toBe(304);
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/workspace/fs:search — session-less workspace file search.
  // -------------------------------------------------------------------------

  async function postWorkspaceSearch<T>(body: unknown): Promise<Envelope<T>> {
    const res = await fetch(`${base}/api/v1/workspace/fs:search`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
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

  it('workspace fs:search maps an unknown ref to WORKSPACE_NOT_FOUND', async () => {
    const body = await postWorkspaceSearch<null>({ workspace: 'does-not-exist', query: 'x' });
    expect(body.code).toBe(ErrorCode.WORKSPACE_NOT_FOUND);
  });

  it('workspace fs:search rejects a missing workspace field with VALIDATION_FAILED', async () => {
    const body = await postWorkspaceSearch<null>({ query: 'x' });
    expect(body.code).toBe(ErrorCode.VALIDATION_FAILED);
  });
});
