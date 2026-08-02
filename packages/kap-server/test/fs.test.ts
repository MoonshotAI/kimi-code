/**
 * Engine-mode `/api/v1/sessions/{sid}/fs:*` — the read-class filesystem
 * surface served by the Rust engine.
 *
 * Only `list` / `read` / `stat` / `search` exist in engine mode (the v2
 * `mkdir` / `stat_many` / `grep` / `git_status` / `diff` actions were retired
 * with the v2 engine). Error semantics: engine `is_error` results map to
 * `FS_PATH_NOT_FOUND`; `fs:stat` is a plain node:fs stat (no etag).
 */

import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ErrorCode } from '../src/protocol/error-codes';
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

interface FsEntryWire {
  path: string;
  name: string;
  kind: string;
  size?: number;
  modified_at: string;
  etag?: string;
  mime?: string;
}

describe('engine-mode /api/v1/sessions/{sid}/fs:*', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  /** Session work dir — kept separate from the server homeDir so the server's
   *  own state (session storage under homeDir) does not pollute `fs:list`. */
  let work: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-engine-fs-home-'));
    work = await mkdtemp(join(tmpdir(), 'kimi-engine-fs-work-'));
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
    if (work !== undefined) {
      await rm(work, { recursive: true, force: true });
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
  });

  it('fs:stat maps a missing path to FS_PATH_NOT_FOUND', async () => {
    const id = await createSession();
    const body = await postFs<null>(id, 'stat', { path: 'nope.txt' });
    expect(body.code).toBe(ErrorCode.FS_PATH_NOT_FOUND);
  });

  it('fs:read returns utf8 content', async () => {
    await writeFile(join(work!, 'a.txt'), 'hello world');
    const id = await createSession();
    const body = await postFs<{ content: string; encoding: string; size: number }>(
      id,
      'read',
      { path: 'a.txt' },
    );
    expect(body.code).toBe(0);
    expect(body.data.content).toBe('hello world');
    expect(body.data.encoding).toBe('utf8');
    expect(body.data.size).toBe(11);
  });

  it('fs:read maps a directory to FS_PATH_NOT_FOUND (engine is_error)', async () => {
    const id = await createSession();
    const body = await postFs<null>(id, 'read', { path: '.' });
    expect(body.code).toBe(ErrorCode.FS_PATH_NOT_FOUND);
  });

  it.skipIf(process.platform === 'win32')(
    'fs:read maps a permission-denied host error to FS_PATH_NOT_FOUND (engine is_error)',
    async () => {
      // Root bypasses permission checks, so EACCES never triggers there.
      if (process.getuid?.() === 0) return;
      const file = join(work!, 'locked.txt');
      await writeFile(file, 'secret');
      await chmod(file, 0o000);
      try {
        const id = await createSession();
        const body = await postFs<null>(id, 'read', { path: 'locked.txt' });
        expect(body.code).toBe(ErrorCode.FS_PATH_NOT_FOUND);
      } finally {
        await chmod(file, 0o644);
      }
    },
  );

  it('fs:list returns items', async () => {
    await writeFile(join(work!, 'a.txt'), '');
    await writeFile(join(work!, 'b.txt'), '');
    const id = await createSession();
    const body = await postFs<{ items: FsEntryWire[]; truncated: boolean }>(id, 'list', {});
    expect(body.code).toBe(0);
    const names = body.data.items.map((i) => i.name).toSorted();
    expect(names).toEqual(['a.txt', 'b.txt']);
    expect(body.data.truncated).toBe(false);
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

  it('rejects an unsupported action (mkdir/grep/git_status retired) with VALIDATION_FAILED', async () => {
    const id = await createSession();
    for (const action of ['mkdir', 'stat_many', 'grep', 'git_status']) {
      const body = await postFs<null>(id, action, {});
      expect(body.code, action).toBe(ErrorCode.VALIDATION_FAILED);
    }
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

  it('serves fs actions when the session cwd itself goes through a symlink', async () => {
    const link = join(tmpdir(), `kimi-engine-fs-cwd-link-${process.pid}`);
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
});
