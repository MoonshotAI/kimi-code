import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { IModelCatalog, IWorkspaceInstanceManager } from '@moonshot-ai/agent-core-v2';
import { HostFileSystem } from '@moonshot-ai/agent-core-v2/os/backends/node-local/hostFsService';
import type { IHostFileSystem } from '@moonshot-ai/agent-core-v2/os/interface/hostFileSystem';
import { FakeRuntime } from '@moonshot-ai/agent-core-v2/runtime/fakeRuntime';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';

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

interface BrowseEntryWire {
  name: string;
  path: string;
  is_dir: true;
}

interface BrowseWire {
  path: string;
  parent: string | null;
  entries: BrowseEntryWire[];
}

interface HomeWire {
  home: string;
  recent_roots: string[];
}

describe('server-v2 /api/v1 fs folder picker', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let instancesDir: string | undefined;
  let base: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-'));
    instancesDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-instances-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      instancesDir,
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
    if (instancesDir !== undefined) {
      await rm(instancesDir, { recursive: true, force: true });
      instancesDir = undefined;
    }
  });

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

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

  it('defaults browse to $HOME when path is omitted', async () => {
    const { status, body } = await getJson<BrowseWire>('/api/v1/fs:browse');
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.path).toBe(await realpath(homedir()));
    expect(typeof body.data.parent === 'string' || body.data.parent === null).toBe(true);
    expect(Array.isArray(body.data.entries)).toBe(true);
  });

  it('does not serve the double-colon URL (v1 parity: only /fs:browse is valid)', async () => {
    const res = await fetch(`${base}/api/v1/fs::browse`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    expect(res.status).toBe(404);
  });

  it('lists only directories and filters files', async () => {
    const root = await mkdtemp(join(home as string, 'browse-filter-'));
    await mkdir(join(root, 'alpha'));
    await mkdir(join(root, 'beta'));
    await writeFile(join(root, 'README.md'), 'hi');

    const { body } = await getJson<BrowseWire>(
      `/api/v1/fs:browse?path=${encodeURIComponent(root)}`,
    );
    expect(body.code).toBe(0);
    expect(body.data.path).toBe(await realpath(root));
    const names = body.data.entries.map((e) => e.name).toSorted();
    expect(names).toEqual(['alpha', 'beta']);
    for (const entry of body.data.entries) {
      expect(entry.is_dir).toBe(true);
      expect(entry.path).toBe(join(await realpath(root), entry.name));
    }
  });

  it('sorts dot-directories after regular ones', async () => {
    const root = await mkdtemp(join(home as string, 'browse-dots-'));
    await mkdir(join(root, '.zeta'));
    await mkdir(join(root, 'alpha'));

    const { body } = await getJson<BrowseWire>(
      `/api/v1/fs:browse?path=${encodeURIComponent(root)}`,
    );
    expect(body.code).toBe(0);
    expect(body.data.entries.map((e) => e.name)).toEqual(['alpha', '.zeta']);
  });

  it('returns parent=null for the filesystem root', async () => {
    const { body } = await getJson<BrowseWire>('/api/v1/fs:browse?path=%2F');
    expect(body.code).toBe(0);
    expect(body.data.path).toBe('/');
    expect(body.data.parent).toBeNull();
  });

  it('rejects a relative path (40001)', async () => {
    const { body } = await getJson<null>(
      `/api/v1/fs:browse?path=${encodeURIComponent('relative/path')}`,
    );
    expect(body.code).toBe(40001);
  });

  it('rejects a nonexistent path (40409)', async () => {
    const missing = join(home as string, 'does-not-exist');
    const { body } = await getJson<null>(`/api/v1/fs:browse?path=${encodeURIComponent(missing)}`);
    expect(body.code).toBe(40409);
  });

  it('returns an empty recent_roots when no workspaces are registered', async () => {
    const { status, body } = await getJson<HomeWire>('/api/v1/fs:home');
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.home).toBe(homedir());
    expect(body.data.recent_roots).toEqual([]);
  });

  it('reflects registered workspace roots in recent_roots', async () => {
    const root = home as string;
    const created = await postJson<{ id: string }>('/api/v1/workspaces', { root });
    expect(created.body.code).toBe(0);

    const { body } = await getJson<HomeWire>('/api/v1/fs:home');
    expect(body.code).toBe(0);
    expect(body.data.recent_roots).toContain(root);
  });
});

describe('server-v2 /api/v1 fs:mkdir', () => {
  let server: RunningServer | undefined;
  let dir: string | undefined;
  let instancesDir: string | undefined;
  let base: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fsmkdir-'));
    instancesDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fsmkdir-instances-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: dir,
      instancesDir,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
    if (instancesDir !== undefined) {
      await rm(instancesDir, { recursive: true, force: true });
      instancesDir = undefined;
    }
  });

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('creates a directory that fs:browse then lists', async () => {
    const target = join(dir as string, 'fresh-folder');

    const { status, body } = await postJson<{ path: string }>('/api/v1/fs:mkdir', {
      path: target,
    });
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.path).toBe(target);

    const browse = await fetch(
      `${base}/api/v1/fs:browse?path=${encodeURIComponent(dir as string)}`,
      { headers: authHeaders(server as RunningServer) } as never,
    );
    const browseBody = (await browse.json()) as Envelope<BrowseWire>;
    expect(browseBody.data.entries.map((e) => e.name)).toContain('fresh-folder');
  });

  it('rejects a relative path (40001)', async () => {
    const { body } = await postJson<null>('/api/v1/fs:mkdir', { path: 'relative/folder' });
    expect(body.code).toBe(40001);
  });

  it('rejects an existing directory (40919)', async () => {
    const target = join(dir as string, 'already-here');
    await mkdir(target);

    const { body } = await postJson<null>('/api/v1/fs:mkdir', { path: target });
    expect(body.code).toBe(40919);
  });

  it('rejects an existing file (40919)', async () => {
    const target = join(dir as string, 'file.txt');
    await writeFile(target, 'hi');

    const { body } = await postJson<null>('/api/v1/fs:mkdir', { path: target });
    expect(body.code).toBe(40919);
  });

  it('rejects a missing parent (40409)', async () => {
    const target = join(dir as string, 'no-such-parent', 'child');
    const { body } = await postJson<null>('/api/v1/fs:mkdir', { path: target });
    expect(body.code).toBe(40409);
  });

  it('does not serve the double-colon URL', async () => {
    const res = await fetch(`${base}/api/v1/fs::mkdir`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ path: join(dir as string, 'x') }),
    } as never);
    expect(res.status).toBe(404);
  });
});

describe('server-v2 /api/v1 fs:content', () => {
  let server: RunningServer | undefined;
  let dir: string | undefined;
  let instancesDir: string | undefined;
  let base: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fscontent-'));
    instancesDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fscontent-instances-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: dir,
      instancesDir,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
    if (instancesDir !== undefined) {
      await rm(instancesDir, { recursive: true, force: true });
      instancesDir = undefined;
    }
  });

  function contentUrl(path: string): string {
    return `${base}/api/v1/fs:content?path=${encodeURIComponent(path)}`;
  }

  async function getContent(
    path: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(contentUrl(path), {
      headers: { connection: 'close', ...authHeaders(server as RunningServer), ...headers },
    } as never);
  }

  it('serves a text file raw with mime, etag, and length headers', async () => {
    const file = join(dir as string, 'hello.md');
    await writeFile(file, '# hi\n');

    const res = await getContent(file);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(res.headers.get('content-length')).toBe('5');
    expect(typeof res.headers.get('etag')).toBe('string');
    expect(typeof res.headers.get('last-modified')).toBe('string');
    expect(await res.text()).toBe('# hi\n');
  });

  it('serves an unknown-extension text file as text/plain', async () => {
    const file = join(dir as string, 'notes.weird');
    await writeFile(file, 'just text');

    const res = await getContent(file);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('serves a UTF-8 Chinese .log file as text/plain', async () => {
    const file = join(dir as string, 'server.log');
    const log = '2026-08-16 INFO 启动完成 ✅\n'.repeat(100);
    await writeFile(file, log);

    const res = await getContent(file);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe(log);
  });

  it('serves binary files byte-for-byte with an octet-stream fallback mime', async () => {
    const file = join(dir as string, 'blob.bin');
    const original = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x10, 0x80]);
    await writeFile(file, original);

    const res = await getContent(file);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/octet-stream');
    expect(Buffer.from(await res.arrayBuffer()).equals(original)).toBe(true);
  });

  it('guesses image mime from the extension', async () => {
    const file = join(dir as string, 'pic.png');
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

    const res = await getContent(file);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
  });

  it('answers If-None-Match with 304 when the etag matches', async () => {
    const file = join(dir as string, 'cached.txt');
    await writeFile(file, 'cache me');

    const first = await getContent(file);
    const etag = first.headers.get('etag') as string;

    const res = await getContent(file, { 'if-none-match': etag });
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe(etag);
    expect(await res.text()).toBe('');
  });

  it('honors single-range requests with 206', async () => {
    const file = join(dir as string, 'long.txt');
    await writeFile(file, '0123456789');

    const res = await getContent(file, { range: 'bytes=2-5' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(res.headers.get('content-length')).toBe('4');
    expect(await res.text()).toBe('2345');
  });

  it('rejects a relative path (40001)', async () => {
    const res = await getContent('relative/path.txt');
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40001);
  });

  it('rejects a nonexistent path (40409)', async () => {
    const res = await getContent(join(dir as string, 'does-not-exist.txt'));
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40409);
  });

  it('rejects a directory path (40906)', async () => {
    const res = await getContent(dir as string);
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40906);
  });

  it.skipIf(process.platform === 'win32')('rejects non-regular files (40001)', async () => {
    const res = await getContent('/dev/null');
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40001);
  });

  it('does not serve the double-colon URL', async () => {
    const res = await fetch(`${base}/api/v1/fs::content?path=%2Ftmp`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    expect(res.status).toBe(404);
  });
});

function mappingHostFs(remoteRoot: string): IHostFileSystem {
  const inner = new HostFileSystem();
  const map = (path: string): string => join(remoteRoot, path);
  const unmap = (path: string): string =>
    path === remoteRoot
      ? '/'
      : path.startsWith(`${remoteRoot}/`)
        ? path.slice(remoteRoot.length)
        : path;
  return {
    _serviceBrand: undefined,
    readText: (path, options) => inner.readText(map(path), options),
    writeText: (path, data) => inner.writeText(map(path), data),
    appendText: (path, data) => inner.appendText(map(path), data),
    readBytes: (path, n, offset) => inner.readBytes(map(path), n, offset),
    writeBytes: (path, data) => inner.writeBytes(map(path), data),
    readLines: (path, options) => inner.readLines(map(path), options),
    createExclusive: (path, data) => inner.createExclusive(map(path), data),
    stat: (path) => inner.stat(map(path)),
    lstat: (path) => inner.lstat(map(path)),
    readdir: (path) => inner.readdir(map(path)),
    mkdir: (path, options) => inner.mkdir(map(path), options),
    remove: (path) => inner.remove(map(path)),
    realpath: async (path) => unmap(await inner.realpath(map(path))),
  };
}

describe('server-v2 /api/v1 fs:content and fs:mkdir with runtime_id', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let localRoot: string | undefined;
  let remoteRoot: string | undefined;
  let provider: { dispose(): void | Promise<void> } | undefined;
  let base: string;
  let sessionId: string;
  let workspaceId: string;
  const remoteRoots = new Map<string, string>();

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fsrt-home-'));
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
    localRoot = await realpath(await mkdtemp(join(tmpdir(), 'kimi-server-v2-fsrt-local-')));
    remoteRoot = await realpath(await mkdtemp(join(tmpdir(), 'kimi-server-v2-fsrt-remote-')));
    remoteRoots.set(localRoot, remoteRoot);
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: localRoot } }),
    } as never);
    const created = (await res.json()) as Envelope<{ id: string; workspace_id: string }>;
    if (created.code !== 0) throw new Error(`session create failed: ${created.msg}`);
    sessionId = created.data.id;
    workspaceId = created.data.workspace_id;
    provider = await server!.core.accessor.get(IWorkspaceInstanceManager).addProvider({
      id: 'remote-test-provider',
      imports: { root: [], imports: [], local: [] },
      attach: async (context, host) => {
        const runtime = Object.assign(
          new FakeRuntime(
            { workspaceId: context.id, runtimeId: 'remote-test', generation: 'remote-generation' },
            { capabilities: ['fs'] },
          ),
          { fs: mappingHostFs(remoteRoots.get(context.root) ?? (remoteRoot as string)) },
        );
        const registration = host.registerRuntime(runtime);
        return { dispose: () => registration.remove() };
      },
    });
  });

  afterEach(async () => {
    if (provider !== undefined) {
      await provider.dispose();
      provider = undefined;
    }
    for (const root of [...remoteRoots.keys(), ...remoteRoots.values()]) {
      await rm(root, { recursive: true, force: true });
    }
    remoteRoots.clear();
    localRoot = undefined;
    remoteRoot = undefined;
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

  function contentUrl(
    path: string,
    runtimeId?: string,
    context?: { workspace_id?: string; session_id?: string },
  ): string {
    const query = new URLSearchParams({ path });
    if (runtimeId !== undefined) query.set('runtime_id', runtimeId);
    if (context?.workspace_id !== undefined) query.set('workspace_id', context.workspace_id);
    if (context?.session_id !== undefined) query.set('session_id', context.session_id);
    return `${base}/api/v1/fs:content?${query.toString()}`;
  }

  async function postMkdir(body: unknown): Promise<Envelope<{ path: string } | null>> {
    const res = await fetch(`${base}/api/v1/fs:mkdir`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    } as never);
    return (await res.json()) as Envelope<{ path: string } | null>;
  }

  it('serves file content from the selected runtime fs', async () => {
    await writeFile(join(remoteRoot as string, 'remote-only.txt'), 'remote-bytes');

    const res = await fetch(contentUrl('/remote-only.txt', 'remote-test', { session_id: sessionId }), {
      headers: { connection: 'close', ...authHeaders(server as RunningServer) },
    } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('12');
    expect(await res.text()).toBe('remote-bytes');
  });

  it('reads stat, sample, and body from the runtime fs when the path exists on both filesystems', async () => {
    const requestPath = join(localRoot as string, 'shared.txt');
    const remoteFile = join(remoteRoot as string, requestPath);
    await mkdir(dirname(remoteFile), { recursive: true });
    await writeFile(remoteFile, 'remote-bytes');
    await writeFile(requestPath, 'local-decoy');

    const res = await fetch(contentUrl(requestPath, 'remote-test', { workspace_id: workspaceId }), {
      headers: { connection: 'close', ...authHeaders(server as RunningServer) },
    } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('12');
    expect(await res.text()).toBe('remote-bytes');
  });

  it('honors range requests against the runtime fs', async () => {
    await writeFile(join(remoteRoot as string, 'long.txt'), '0123456789');

    const res = await fetch(contentUrl('/long.txt', 'remote-test', { session_id: sessionId }), {
      headers: { connection: 'close', range: 'bytes=2-5', ...authHeaders(server as RunningServer) },
    } as never);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(res.headers.get('content-length')).toBe('4');
    expect(await res.text()).toBe('2345');
  });

  it('answers If-None-Match with 304 against the runtime fs etag', async () => {
    await writeFile(join(remoteRoot as string, 'cached.txt'), 'cache me');

    const first = await fetch(contentUrl('/cached.txt', 'remote-test', { workspace_id: workspaceId }), {
      headers: { connection: 'close', ...authHeaders(server as RunningServer) },
    } as never);
    const etag = first.headers.get('etag') as string;
    expect(typeof etag).toBe('string');

    const res = await fetch(contentUrl('/cached.txt', 'remote-test', { workspace_id: workspaceId }), {
      headers: { connection: 'close', 'if-none-match': etag, ...authHeaders(server as RunningServer) },
    } as never);
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe(etag);
    expect(await res.text()).toBe('');
  });

  it('keeps serving the server-local filesystem when runtime_id is local', async () => {
    const file = join(localRoot as string, 'local.txt');
    await writeFile(file, 'local-bytes');

    const res = await fetch(contentUrl(file, 'local'), {
      headers: { connection: 'close', ...authHeaders(server as RunningServer) },
    } as never);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('local-bytes');
  });

  it('rejects a non-local content runtime_id without a workspace context (40001)', async () => {
    const res = await fetch(contentUrl('/remote-only.txt', 'remote-test'), {
      headers: { connection: 'close', ...authHeaders(server as RunningServer) },
    } as never);
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40001);
  });

  it('rejects a non-local content runtime_id with an unknown session_id (40401)', async () => {
    const res = await fetch(contentUrl('/remote-only.txt', 'remote-test', { session_id: 'no-such-session' }), {
      headers: { connection: 'close', ...authHeaders(server as RunningServer) },
    } as never);
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40401);
  });

  it('rejects a non-local content runtime_id with an unknown workspace_id (40410)', async () => {
    const res = await fetch(contentUrl('/remote-only.txt', 'remote-test', { workspace_id: 'no-such-workspace' }), {
      headers: { connection: 'close', ...authHeaders(server as RunningServer) },
    } as never);
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40410);
  });

  it('maps an unknown content runtime_id to RUNTIME_NOT_FOUND', async () => {
    const res = await fetch(contentUrl('/remote-only.txt', 'no-such-runtime', { workspace_id: workspaceId }), {
      headers: { connection: 'close', ...authHeaders(server as RunningServer) },
    } as never);
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(40420);
  });

  it('creates directories on the runtime fs, never on the server-local disk', async () => {
    const requestPath = join(localRoot as string, 'made-remote');
    await mkdir(join(remoteRoot as string, localRoot as string), { recursive: true });

    const body = await postMkdir({ path: requestPath, runtime_id: 'remote-test', session_id: sessionId });
    expect(body.code).toBe(0);
    expect(body.data?.path).toBe(requestPath);

    const remoteStat = await stat(join(remoteRoot as string, requestPath));
    expect(remoteStat.isDirectory()).toBe(true);
    await expect(stat(requestPath)).rejects.toThrow();
  });

  it('rejects mkdir on an existing runtime path (40919)', async () => {
    const requestPath = join(localRoot as string, 'already-here');
    await mkdir(join(remoteRoot as string, requestPath), { recursive: true });

    const body = await postMkdir({ path: requestPath, runtime_id: 'remote-test', workspace_id: workspaceId });
    expect(body.code).toBe(40919);
  });

  it('rejects mkdir with a missing runtime parent (40409)', async () => {
    const requestPath = join(localRoot as string, 'no-such-parent', 'child');

    const body = await postMkdir({ path: requestPath, runtime_id: 'remote-test', session_id: sessionId });
    expect(body.code).toBe(40409);
  });

  it('rejects a non-local mkdir runtime_id without a workspace context (40001)', async () => {
    const body = await postMkdir({ path: join(localRoot as string, 'x'), runtime_id: 'remote-test' });
    expect(body.code).toBe(40001);
  });

  it('rejects a non-local mkdir runtime_id with an unknown session_id (40401)', async () => {
    const body = await postMkdir({
      path: join(localRoot as string, 'x'),
      runtime_id: 'remote-test',
      session_id: 'no-such-session',
    });
    expect(body.code).toBe(40401);
  });

  it('rejects a non-local mkdir runtime_id with an unknown workspace_id (40410)', async () => {
    const body = await postMkdir({
      path: join(localRoot as string, 'x'),
      runtime_id: 'remote-test',
      workspace_id: 'no-such-workspace',
    });
    expect(body.code).toBe(40410);
  });

  it('maps an unknown mkdir runtime_id to RUNTIME_NOT_FOUND', async () => {
    const body = await postMkdir({
      path: join(localRoot as string, 'x'),
      runtime_id: 'no-such-runtime',
      workspace_id: workspaceId,
    });
    expect(body.code).toBe(40420);
  });

  it('resolves the same runtime id per workspace', async () => {
    const localRootB = await realpath(await mkdtemp(join(tmpdir(), 'kimi-server-v2-fsrt-local-b-')));
    const remoteRootB = await realpath(await mkdtemp(join(tmpdir(), 'kimi-server-v2-fsrt-remote-b-')));
    remoteRoots.set(localRootB, remoteRootB);
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: localRootB } }),
    } as never);
    const createdB = (await res.json()) as Envelope<{ id: string; workspace_id: string }>;
    if (createdB.code !== 0) throw new Error(`session create failed: ${createdB.msg}`);

    await writeFile(join(remoteRoot as string, 'shared.txt'), 'workspace-a-bytes');
    await writeFile(join(remoteRootB, 'shared.txt'), 'workspace-b-bytes');

    const fromA = await fetch(
      contentUrl('/shared.txt', 'remote-test', { workspace_id: workspaceId }),
      { headers: { connection: 'close', ...authHeaders(server as RunningServer) } } as never,
    );
    expect(fromA.status).toBe(200);
    expect(await fromA.text()).toBe('workspace-a-bytes');

    const fromB = await fetch(
      contentUrl('/shared.txt', 'remote-test', { workspace_id: createdB.data.workspace_id }),
      { headers: { connection: 'close', ...authHeaders(server as RunningServer) } } as never,
    );
    expect(fromB.status).toBe(200);
    expect(await fromB.text()).toBe('workspace-b-bytes');

    const viaSessionB = await fetch(
      contentUrl('/shared.txt', 'remote-test', { session_id: createdB.data.id }),
      { headers: { connection: 'close', ...authHeaders(server as RunningServer) } } as never,
    );
    expect(viaSessionB.status).toBe(200);
    expect(await viaSessionB.text()).toBe('workspace-b-bytes');

    const mkdirBody = await postMkdir({
      path: '/made-on-b',
      runtime_id: 'remote-test',
      session_id: createdB.data.id,
    });
    expect(mkdirBody.code).toBe(0);
    const statB = await stat(join(remoteRootB, 'made-on-b'));
    expect(statB.isDirectory()).toBe(true);
    await expect(stat(join(remoteRoot as string, 'made-on-b'))).rejects.toThrow();
  });
});
