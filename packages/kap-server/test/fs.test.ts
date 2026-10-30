import { execFileSync } from 'node:child_process';
import { IEnvironmentService } from '@moonshot-ai/agent-core-v2';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { IModelCatalog, ISessionManager, IWorkspaceInstanceManager } from '@moonshot-ai/agent-core-v2';
import { HostFileSystem } from '@moonshot-ai/agent-core-v2/os/backends/node-local/hostFsService';
import { HostProcessService } from '@moonshot-ai/agent-core-v2/os/backends/node-local/hostProcessService';
import { FakeEnvironment } from '@moonshot-ai/agent-core-v2/environment/fakeEnvironment';
import type { EnvironmentCapability } from '@moonshot-ai/agent-core-v2/environment/environment';
import { ErrorCode } from '../src/protocol/error-codes';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';
import { fakeModelCatalog } from './helpers/fakeModelCatalog';

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
  is_directory?: boolean;
}

describe('server-v2 /api/v1 fs routes', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let work: string | undefined;
  let base: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-home-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [[IModelCatalog, fakeModelCatalog()]],
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-work-'));
  });

  afterEach(async () => {
    if (work !== undefined) {
      await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      work = undefined;
    }
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      home = undefined;
    }
  });

  function git(cwd: string, ...args: string[]): void {
    execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  async function createWorkspaceSession(root: string, additionalDirs: string[]): Promise<string> {
    const workspaceRes = await fetch(`${base}/api/v1/workspaces`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ root, additional_dirs: additionalDirs }),
    } as never);
    const workspace = (await workspaceRes.json()) as Envelope<{ id: string }>;
    expect(workspace.code).toBe(0);
    const sessionRes = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ workspace_id: workspace.data.id }),
    } as never);
    const session = (await sessionRes.json()) as Envelope<{ id: string }>;
    expect(session.code).toBe(0);
    return session.data.id;
  }

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

  it('serves fs actions from a local session workspace', async () => {
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

  it('serves fs actions and downloads from the environment the session was created on', async () => {
    await writeFile(join(work!, 'selected.txt'), 'local');
    const remote = await realpath(await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-remote-')));
    await writeFile(join(remote, 'selected.txt'), 'remote');
    const provider = await server!.core.accessor.get(IEnvironmentService).addProvider({
      id: 'remote-session-provider',
      attach: async (host) => {
        const environment = Object.assign(
          new FakeEnvironment(
            { environmentId: 'remote-session', generation: 'remote-generation' },
            { capabilities: ['fs', 'process'] },
          ),
          { fs: new HostFileSystem(), process: new HostProcessService() },
        );
        const registration = host.registerEnvironment(environment);
        return { dispose: () => registration.remove() };
      },
    });
    try {
      const created = await fetch(`${base}/api/v1/sessions`, {
        method: 'POST',
        headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
        body: JSON.stringify({ metadata: { cwd: work as string }, environment_id: 'remote-session', environment_cwd: remote }),
      } as never);
      const session = (await created.json()) as Envelope<{ id: string }>;
      expect(session.code).toBe(0);
      const body = await postFs<{ content: string }>(session.data.id, 'read', { path: 'selected.txt' });
      expect(body.code).toBe(0);
      expect(body.data.content).toBe('remote');
      const download = await fetch(`${base}/api/v1/sessions/${session.data.id}/fs/selected.txt:download`, {
        headers: authHeaders(server as RunningServer),
      } as never);
      expect(await download.text()).toBe('remote');
      const opened = await postFs<null>(session.data.id, 'reveal', { path: 'selected.txt' });
      expect(opened.code).not.toBe(0);
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
    const names = body.data.items.map((i) => i.name).toSorted();
    expect(names).toEqual(['a.txt', 'b.txt']);
    expect(body.data.truncated).toBe(false);
  });

  it('fs:list expands in-workspace symlink directories and keeps outside links closed', async () => {
    await mkdir(join(work!, 'real/nested'), { recursive: true });
    await writeFile(join(work!, 'real/nested/inside.txt'), '');
    await symlink(join(work!, 'real'), join(work!, 'link'));
    const outside = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-outside-'));
    await writeFile(join(outside, 'secret.txt'), '');
    await symlink(outside, join(work!, 'outside-link'));
    try {
      const id = await createSession();
      const recursive = await postFs<{
        items: FsEntryWire[];
        truncated: boolean;
        children_by_path?: Record<string, FsEntryWire[]>;
      }>(id, 'list', { depth: 2 });
      expect(recursive.code).toBe(0);
      expect(recursive.data.items.find((i) => i.path === 'link')).toMatchObject({
        kind: 'symlink',
        is_directory: true,
      });
      expect(recursive.data.children_by_path?.['link']?.map((i) => i.name)).toContain('nested');
      expect(
        recursive.data.items.find((i) => i.path === 'outside-link')?.is_directory,
      ).toBeUndefined();

      const direct = await postFs<{ items: FsEntryWire[] }>(id, 'list', { path: 'link' });
      expect(direct.code).toBe(0);
      expect(direct.data.items.map((i) => i.name)).toEqual(['nested']);

      const escaped = await postFs<null>(id, 'list', { path: 'outside-link' });
      expect(escaped.code).toBe(ErrorCode.FS_PATH_ESCAPES_SESSION);

      const allowed = await postFs<{
        items: FsEntryWire[];
        children_by_path?: Record<string, FsEntryWire[]>;
      }>(id, 'list', { depth: 2, allow_external_symlinks: true });
      expect(allowed.code).toBe(0);
      expect(allowed.data.items.find((i) => i.path === 'outside-link')).toMatchObject({
        kind: 'symlink',
        is_directory: true,
      });
      expect(allowed.data.children_by_path?.['outside-link']?.map((i) => i.name)).toEqual([
        'secret.txt',
      ]);

      const allowedDirect = await postFs<{ items: FsEntryWire[] }>(id, 'list', {
        path: 'outside-link',
        allow_external_symlinks: true,
      });
      expect(allowedDirect.data.items.map((i) => i.name)).toEqual(['secret.txt']);

      const allowedRead = await postFs<{ content: string }>(id, 'read', {
        path: 'outside-link/secret.txt',
        allow_external_symlinks: true,
      });
      expect(allowedRead.code).toBe(0);
      expect(allowedRead.data.content).toBe('');

      const allowedDownload = await fetch(
        `${base}/api/v1/sessions/${id}/fs/outside-link/secret.txt:download?allow_external_symlinks=true`,
        { headers: authHeaders(server as RunningServer) } as never,
      );
      expect(allowedDownload.status).toBe(200);
      expect(await allowedDownload.text()).toBe('');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('fs:list keeps gitignored paths hidden unless allowed via allow_ignored_globs', async () => {
    await writeFile(join(work!, '.gitignore'), 'ignored-dir/\n.tmp/\n');
    await mkdir(join(work!, 'ignored-dir'));
    await mkdir(join(work!, '.tmp'));
    await writeFile(join(work!, '.tmp/keep.txt'), '');
    await writeFile(join(work!, 'visible.txt'), '');
    const id = await createSession();

    const filtered = await postFs<{ items: FsEntryWire[]; truncated: boolean }>(id, 'list', {});
    const filteredNames = filtered.data.items.map((i) => i.name);
    expect(filteredNames).not.toContain('ignored-dir');
    expect(filteredNames).not.toContain('.tmp');
    expect(filteredNames).toContain('visible.txt');

    const allowed = await postFs<{ items: FsEntryWire[]; truncated: boolean }>(id, 'list', {
      show_hidden: true,
      allow_ignored_globs: ['ignored-dir', '.tmp', '.tmp/**'],
    });
    const allowedNames = allowed.data.items.map((i) => i.name);
    expect(allowedNames).toContain('ignored-dir');
    expect(allowedNames).toContain('.tmp');
    expect(allowedNames).toContain('visible.txt');

    const children = await postFs<{ items: FsEntryWire[]; truncated: boolean }>(id, 'list', {
      path: '.tmp',
      show_hidden: true,
      allow_ignored_globs: ['.tmp', '.tmp/**'],
    });
    expect(children.data.items.map((i) => i.name)).toContain('keep.txt');
  });

  it('fs:list traverses ignored ancestor directories of allowed matches', async () => {
    await writeFile(join(work!, '.gitignore'), 'ignored-dir/\n');
    await mkdir(join(work!, 'ignored-dir/nested'), { recursive: true });
    await writeFile(join(work!, 'ignored-dir/nested/keep.txt'), '');
    await writeFile(join(work!, 'ignored-dir/drop.txt'), '');
    await writeFile(join(work!, 'visible.txt'), '');
    const id = await createSession();
    const globs = ['ignored-dir/nested/keep.txt'];

    const root = await postFs<{ items: FsEntryWire[]; truncated: boolean }>(id, 'list', {
      allow_ignored_globs: globs,
    });
    const rootNames = root.data.items.map((i) => i.name);
    expect(rootNames).toContain('ignored-dir');
    expect(rootNames).toContain('visible.txt');

    const mid = await postFs<{ items: FsEntryWire[]; truncated: boolean }>(id, 'list', {
      path: 'ignored-dir',
      allow_ignored_globs: globs,
    });
    expect(mid.data.items.map((i) => i.name)).toEqual(['nested']);

    const leaf = await postFs<{ items: FsEntryWire[]; truncated: boolean }>(id, 'list', {
      path: 'ignored-dir/nested',
      allow_ignored_globs: globs,
    });
    expect(leaf.data.items.map((i) => i.name)).toEqual(['keep.txt']);

    const recursive = await postFs<{
      items: FsEntryWire[];
      truncated: boolean;
      children_by_path?: Record<string, FsEntryWire[]>;
    }>(id, 'list', { depth: 3, allow_ignored_globs: globs });
    const descendants = Object.values(recursive.data.children_by_path ?? {})
      .flat()
      .map((i) => i.path);
    expect(descendants).toContain('ignored-dir/nested');
    expect(descendants).toContain('ignored-dir/nested/keep.txt');
    expect(descendants).not.toContain('ignored-dir/drop.txt');
  });

  it('fs:list does not surface a non-directory prefix of an allowed glob', async () => {
    await writeFile(join(work!, '.gitignore'), 'data.bin\n');
    await writeFile(join(work!, 'data.bin'), '');
    const id = await createSession();

    const body = await postFs<{ items: FsEntryWire[]; truncated: boolean }>(id, 'list', {
      allow_ignored_globs: ['data.bin/keep.txt'],
    });
    expect(body.data.items.map((i) => i.name)).not.toContain('data.bin');
  });

  it('fs:list traverses ignored ancestors across wildcard glob segments', async () => {
    await writeFile(join(work!, '.gitignore'), 'ignored-a/\nignored-b/\nignored-dir/\nother-dir/\n');
    await mkdir(join(work!, 'ignored-a'), { recursive: true });
    await mkdir(join(work!, 'ignored-b'), { recursive: true });
    await mkdir(join(work!, 'ignored-dir/sub'), { recursive: true });
    await mkdir(join(work!, 'other-dir'), { recursive: true });
    await writeFile(join(work!, 'ignored-a/keep.txt'), '');
    await writeFile(join(work!, 'ignored-b/drop.txt'), '');
    await writeFile(join(work!, 'ignored-dir/sub/keep.txt'), '');
    await writeFile(join(work!, 'ignored-dir/sub/notkeep.txt'), '');
    await writeFile(join(work!, 'ignored-dir/drop.txt'), '');
    await writeFile(join(work!, 'other-dir/drop.txt'), '');
    const id = await createSession();

    const wildcard = await postFs<{ items: FsEntryWire[]; truncated: boolean }>(id, 'list', {
      allow_ignored_globs: ['ignored-*/keep.txt'],
    });
    const wildcardNames = wildcard.data.items.map((i) => i.name);
    expect(wildcardNames).toContain('ignored-a');
    expect(wildcardNames).not.toContain('ignored-b');
    expect(wildcardNames).not.toContain('other-dir');

    const mid = await postFs<{ items: FsEntryWire[]; truncated: boolean }>(id, 'list', {
      path: 'ignored-dir',
      allow_ignored_globs: ['ignored-dir/**/keep.txt'],
    });
    expect(mid.data.items.map((i) => i.name)).toEqual(['sub']);

    const leaf = await postFs<{ items: FsEntryWire[]; truncated: boolean }>(id, 'list', {
      path: 'ignored-dir/sub',
      allow_ignored_globs: ['ignored-dir/**/keep.txt'],
    });
    expect(leaf.data.items.map((i) => i.name)).toEqual(['keep.txt']);

    const brace = await postFs<{ items: FsEntryWire[]; truncated: boolean }>(id, 'list', {
      allow_ignored_globs: ['{ignored-a/keep.txt,other}'],
    });
    const braceNames = brace.data.items.map((i) => i.name);
    expect(braceNames).toContain('ignored-a');
    expect(braceNames).not.toContain('ignored-b');
  });

  it('fs:list tolerates empty glob patterns', async () => {
    await writeFile(join(work!, 'a.txt'), '');
    const id = await createSession();
    const body = await postFs<{ items: FsEntryWire[]; truncated: boolean }>(id, 'list', {
      exclude_globs: [''],
      allow_ignored_globs: [''],
    });
    expect(body.code).toBe(0);
    expect(body.data.items.map((i) => i.name)).toContain('a.txt');
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

  it('fs:git_status selects and scopes an additional root', async () => {
    const extra = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-extra-'));
    try {
      for (const [cwd, name] of [[work!, 'main.txt'], [extra, 'extra.txt']] as const) {
        git(cwd, 'init', '-b', 'main');
        git(cwd, 'config', 'user.email', 'test@example.com');
        git(cwd, 'config', 'user.name', 'Test');
        await writeFile(join(cwd, name), 'one\n');
        git(cwd, 'add', '-A');
        git(cwd, 'commit', '-m', 'init');
        await writeFile(join(cwd, name), 'one\ntwo\n');
      }
      const id = await createWorkspaceSession(work!, [extra]);

      const primary = await postFs<{ branch: string; entries: Record<string, string>; additions: number }>(id, 'git_status', { root: work });
      const additional = await postFs<{ branch: string; entries: Record<string, string>; additions: number }>(id, 'git_status', { root: extra, include_pull_request: false });
      const pullRequest = await postFs<null>(id, 'pull_request', { root: extra });
      const batch = await postFs<{ results: Record<string, { entries: Record<string, string> }> }>(id, 'git_status:batch', { roots: [work, extra], include_pull_request: false });
      const prBatch = await postFs<{ results: Record<string, null> }>(id, 'pull_request:batch', { roots: [work, extra] });
      const additionalDiff = await postFs<{ path: string; diff: string }>(id, 'diff', { root: extra, path: 'extra.txt' });
      const fileRoot = await postFs<null>(id, 'git_status', { root: 'main.txt' });
      const outside = await postFs<null>(id, 'git_status', { root: tmpdir() });

      expect(primary.code).toBe(0);
      expect(primary.data.entries).toEqual({ 'main.txt': 'modified' });
      expect(primary.data.additions).toBe(1);
      expect(additional.code).toBe(0);
      expect(additional.data.branch).toBe('main');
      expect(additional.data.entries).toEqual({ 'extra.txt': 'modified' });
      expect(additional.data.additions).toBe(1);
      expect(pullRequest.code).toBe(0);
      expect(pullRequest.data).toBeNull();
      expect(batch.code).toBe(0);
      expect(batch.data.results[work!]?.entries).toEqual({ 'main.txt': 'modified' });
      expect(batch.data.results[extra]?.entries).toEqual({ 'extra.txt': 'modified' });
      expect(prBatch.code).toBe(0);
      expect(prBatch.data.results).toEqual({ [work!]: null, [extra]: null });
      expect(additionalDiff.code).toBe(0);
      expect(additionalDiff.data.path).toBe('extra.txt');
      expect(additionalDiff.data.diff).toContain('+two');
      expect(fileRoot.code).toBe(ErrorCode.FS_GIT_UNAVAILABLE);
      expect(outside.code).toBe(ErrorCode.FS_PATH_ESCAPES_SESSION);
    } finally {
      await rm(extra, { recursive: true, force: true });
    }
  }, 20000);

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

  async function postWorkspaceList<T>(body: unknown): Promise<Envelope<T>> {
    const res = await fetch(`${base}/api/v1/workspace/fs:list`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    } as never);
    return (await res.json()) as Envelope<T>;
  }

  it('workspace fs:list expands symlink directories without a session', async () => {
    await mkdir(join(work!, 'real/nested'), { recursive: true });
    await writeFile(join(work!, 'real/nested/inside.txt'), '');
    await symlink(join(work!, 'real'), join(work!, 'link'));

    const root = await postWorkspaceList<{
      items: FsEntryWire[];
      truncated: boolean;
      children_by_path?: Record<string, FsEntryWire[]>;
    }>({ workspace: work, depth: 2 });
    expect(root.code).toBe(0);
    expect(root.data.items.find((i) => i.path === 'link')).toMatchObject({
      kind: 'symlink',
      is_directory: true,
    });
    expect(root.data.children_by_path?.['link']?.map((i) => i.name)).toContain('nested');

    const children = await postWorkspaceList<{ items: FsEntryWire[] }>({
      workspace: work,
      path: 'link',
    });
    expect(children.code).toBe(0);
    expect(children.data.items.map((i) => i.name)).toEqual(['nested']);

    const missing = await postWorkspaceList<null>({
      workspace: work,
      path: 'does-not-exist',
    });
    expect(missing.code).toBe(ErrorCode.FS_PATH_NOT_FOUND);
  });

  it('workspace fs:list maps permission errors to FS_PERMISSION_DENIED', async () => {
    if (process.getuid?.() === 0) return;
    const blocked = join(work!, 'blocked');
    await mkdir(blocked);
    await chmod(blocked, 0o000);
    try {
      const body = await postWorkspaceList<null>({ workspace: blocked });
      expect(body.code).toBe(ErrorCode.FS_PERMISSION_DENIED);
    } finally {
      await chmod(blocked, 0o755);
    }
  });

  it('workspace fs:list can open external symlink directories when enabled', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-workspace-outside-'));
    await writeFile(join(outside, 'secret.txt'), '');
    await symlink(outside, join(work!, 'outside-link'));
    try {
      const root = await postWorkspaceList<{
        items: FsEntryWire[];
        children_by_path?: Record<string, FsEntryWire[]>;
      }>({ workspace: work, depth: 2, allow_external_symlinks: true });
      expect(root.code).toBe(0);
      expect(root.data.items.find((i) => i.path === 'outside-link')).toMatchObject({
        kind: 'symlink',
        is_directory: true,
      });
      expect(root.data.children_by_path?.['outside-link']?.map((i) => i.name)).toEqual([
        'secret.txt',
      ]);

      const children = await postWorkspaceList<{ items: FsEntryWire[] }>({
        workspace: work,
        path: 'outside-link',
        allow_external_symlinks: true,
      });
      expect(children.code).toBe(0);
      expect(children.data.items.map((i) => i.name)).toEqual(['secret.txt']);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  interface RegisteredWorkspaceWire {
    id: string;
    root: string;
    additional_dirs: string[];
  }

  async function createRegisteredWorkspace(additionalDirs: readonly string[] = []): Promise<RegisteredWorkspaceWire> {
    const res = await fetch(`${base}/api/v1/workspaces`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ root: work, additional_dirs: [...additionalDirs] }),
    } as never);
    const body = (await res.json()) as Envelope<RegisteredWorkspaceWire>;
    expect(body.code).toBe(0);
    return body.data;
  }

  async function updateRegisteredWorkspaceDirs(id: string, additionalDirs: readonly string[]): Promise<void> {
    const res = await fetch(`${base}/api/v1/workspaces/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ additional_dirs: [...additionalDirs] }),
    } as never);
    const body = (await res.json()) as Envelope<RegisteredWorkspaceWire>;
    expect(body.code).toBe(0);
  }

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

  it('workspace fs:search serves the local workspace', async () => {
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
      body: JSON.stringify(body),
    } as never);
    return (await res.json()) as Envelope<T>;
  }

  it('workspace fs:suggest searches registered source folders with root-specific paths', async () => {
    const extra = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-extra-'));
    try {
      await writeFile(join(work!, 'primary-only.ts'), '');
      await writeFile(join(work!, 'shared.ts'), 'primary');
      await writeFile(join(extra, 'secondary-only.ts'), '');
      await writeFile(join(extra, 'shared.ts'), 'secondary');
      const workspace = await createRegisteredWorkspace([extra]);
      const extraShared = join(extra, 'shared.ts').split(sep).join('/');
      const extraSecondary = join(extra, 'secondary-only.ts').split(sep).join('/');

      const shared = await postWorkspaceSuggest<{ items: SuggestItemWire[] }>({
        workspace: workspace.id,
        query: 'shared',
      });
      expect(shared.code).toBe(0);
      expect(shared.data.items.map((item) => item.path)).toHaveLength(2);
      expect(shared.data.items.map((item) => item.path)).toEqual(
        expect.arrayContaining(['shared.ts', extraShared]),
      );

      const secondary = await postWorkspaceSuggest<{ items: SuggestItemWire[] }>({
        workspace: workspace.id,
        query: 'secondary-only',
      });
      expect(secondary.code).toBe(0);
      expect(secondary.data.items.map((item) => item.path)).toEqual([extraSecondary]);

      const empty = await postWorkspaceSuggest<{ items: SuggestItemWire[] }>({
        workspace: workspace.id,
        query: '',
      });
      expect(empty.code).toBe(0);
      expect(empty.data.items.map((item) => item.path)).toEqual(
        expect.arrayContaining(['primary-only.ts', 'shared.ts', extraSecondary, extraShared]),
      );
    } finally {
      await rm(extra, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('workspace fs:search searches registered source folders including cold session refs', async () => {
    const extra = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-extra-'));
    try {
      await writeFile(join(work!, 'shared.ts'), 'primary');
      await writeFile(join(extra, 'shared.ts'), 'secondary');
      await writeFile(join(extra, 'secondary-only.ts'), '');
      const workspace = await createRegisteredWorkspace([extra]);
      const extraShared = join(extra, 'shared.ts').split(sep).join('/');
      const extraSecondary = join(extra, 'secondary-only.ts').split(sep).join('/');

      const shared = await postWorkspaceSearch<{ items: SuggestItemWire[] }>({
        workspace: workspace.id,
        query: 'shared',
      });
      expect(shared.code).toBe(0);
      expect(shared.data.items.map((item) => item.path)).toHaveLength(2);
      expect(shared.data.items.map((item) => item.path)).toEqual(
        expect.arrayContaining(['shared.ts', extraShared]),
      );

      const empty = await postWorkspaceSearch<{ items: SuggestItemWire[] }>({
        workspace: workspace.id,
        query: '',
      });
      expect(empty.code).toBe(0);
      expect(empty.data.items.map((item) => item.path)).toEqual(
        expect.arrayContaining(['shared.ts', extraShared, extraSecondary]),
      );

      const cold = await postFs<{ items: SuggestItemWire[] }>(workspace.id, 'search', {
        query: 'secondary-only',
      });
      expect(cold.code).toBe(0);
      expect(cold.data.items.map((item) => item.path)).toEqual([extraSecondary]);
    } finally {
      await rm(extra, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('workspace fs routes use the latest registered source folders after materialization', async () => {
    const removed = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-removed-'));
    const added = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-added-'));
    try {
      await writeFile(join(removed, 'removed-only.ts'), '');
      await writeFile(join(added, 'added-only.ts'), '');
      const workspace = await createRegisteredWorkspace([removed]);
      const removedPath = join(removed, 'removed-only.ts').split(sep).join('/');
      const addedPath = join(added, 'added-only.ts').split(sep).join('/');

      const initial = await postWorkspaceSuggest<{ items: SuggestItemWire[] }>({
        workspace: workspace.id,
        query: 'removed-only',
      });
      expect(initial.code).toBe(0);
      expect(initial.data.items.map((item) => item.path)).toEqual([removedPath]);

      await updateRegisteredWorkspaceDirs(workspace.id, [removed, added]);
      const withAdded = await postWorkspaceSuggest<{ items: SuggestItemWire[] }>({
        workspace: workspace.id,
        query: 'added-only',
      });
      expect(withAdded.code).toBe(0);
      expect(withAdded.data.items.map((item) => item.path)).toEqual([addedPath]);

      await updateRegisteredWorkspaceDirs(workspace.id, [added]);
      const afterRemoval = await postWorkspaceSuggest<{ items: SuggestItemWire[] }>({
        workspace: workspace.id,
        query: 'removed-only',
      });
      expect(afterRemoval.code).toBe(0);
      expect(afterRemoval.data.items).toEqual([]);
    } finally {
      await Promise.all([
        rm(removed, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
        rm(added, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ]);
    }
  });

  it('workspace fs:list respects registered source folder boundaries', async () => {
    const extra = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-extra-'));
    const outside = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-outside-'));
    try {
      await writeFile(join(work!, 'primary.ts'), '');
      await writeFile(join(extra, 'secondary.ts'), '');
      await writeFile(join(outside, 'outside.ts'), '');
      const workspace = await createRegisteredWorkspace([extra]);

      const primary = await postWorkspaceList<{ items: FsEntryWire[] }>({
        workspace: workspace.id,
        path: '.',
      });
      expect(primary.code).toBe(0);
      expect(primary.data.items.map((item) => item.path)).toEqual(['primary.ts']);

      const additional = await postWorkspaceList<{ items: FsEntryWire[] }>({
        workspace: workspace.id,
        path: extra,
      });
      expect(additional.code).toBe(0);
      expect(additional.data.items.map((item) => item.path)).toEqual(['secondary.ts']);

      const rejected = await postWorkspaceList<null>({
        workspace: workspace.id,
        path: outside,
      });
      expect(rejected.code).toBe(ErrorCode.FS_PATH_ESCAPES_SESSION);
    } finally {
      await Promise.all([
        rm(extra, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
        rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ]);
    }
  });

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

  it('workspace fs routes keep additional dirs scoped to the requested registered workspace', async () => {
    const shared = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-shared-'));
    const firstOnly = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-first-'));
    const secondOnly = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-second-'));
    try {
      await writeFile(join(shared, 'shared-file.ts'), '');
      await writeFile(join(firstOnly, 'first-only.ts'), '');
      await writeFile(join(secondOnly, 'second-only.ts'), '');
      const create = async (additionalDirs: string[]): Promise<string> => {
        const res = await fetch(`${base}/api/v1/workspaces`, {
          method: 'POST',
          headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
          body: JSON.stringify({ root: work, additional_dirs: additionalDirs }),
        } as never);
        const created = (await res.json()) as Envelope<{ id: string }>;
        expect(created.code).toBe(0);
        return created.data.id;
      };
      const first = await create([shared, firstOnly]);
      const second = await create([shared, secondOnly]);

      const listed = await postWorkspaceList<{ items: FsEntryWire[] }>({ workspace: first, path: shared });
      expect(listed.code).toBe(0);
      expect(listed.data.items.map((item) => item.name)).toContain('shared-file.ts');

      const firstSearch = await postWorkspaceSearch<{ items: { path: string }[] }>({
        workspace: first,
        query: 'only',
      });
      const secondSearch = await postWorkspaceSearch<{ items: { path: string }[] }>({
        workspace: second,
        query: 'only',
      });
      expect(firstSearch.code).toBe(0);
      expect(secondSearch.code).toBe(0);
      expect(firstSearch.data.items.some((item) => item.path.endsWith('first-only.ts'))).toBe(true);
      expect(firstSearch.data.items.some((item) => item.path.endsWith('second-only.ts'))).toBe(false);
      expect(secondSearch.data.items.some((item) => item.path.endsWith('second-only.ts'))).toBe(true);
      expect(secondSearch.data.items.some((item) => item.path.endsWith('first-only.ts'))).toBe(false);

      const suggested = await postWorkspaceSuggest<{ items: SuggestItemWire[] }>({
        workspace: second,
        query: 'shared-file',
      });
      expect(suggested.code).toBe(0);
      expect(suggested.data.items.some((item) => item.path.endsWith('shared-file.ts'))).toBe(true);

      const res = await fetch(`${base}/api/v1/workspaces`, {
        headers: authHeaders(server as RunningServer),
      } as never);
      const workspaces = (await res.json()) as Envelope<{
        items: { id: string; root: string; additional_dirs: string[] }[];
      }>;
      expect(workspaces.data.items.some((item) => [shared, firstOnly, secondOnly].includes(item.root))).toBe(false);
    } finally {
      await rm(shared, { recursive: true, force: true });
      await rm(firstOnly, { recursive: true, force: true });
      await rm(secondOnly, { recursive: true, force: true });
    }
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

  it('workspace fs:suggest serves the local workspace', async () => {
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

    const workAliases = new Set([work!, await realpath(work!)]);
    expect((await listWorkspaces()).some((w) => workAliases.has(w.root))).toBe(false);
    expect(
      server!.core.accessor
        .get(IWorkspaceInstanceManager)
        .list()
        .some((w) => workAliases.has(w.root)),
    ).toBe(false);

    const again = await postRootSuggest<{ items: SuggestItemWire[] }>({
      roots: [work],
      query: 'kappa',
    });
    expect(again.code).toBe(0);
    expect((await listWorkspaces()).some((w) => workAliases.has(w.root))).toBe(false);
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
});
