import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
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

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-'));
    // Keep the instance registry OUTSIDE the browsed homeDir so the folder
    // picker only sees the test fixtures.
    instancesDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-instances-'));
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      instancesDir,
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
    // v1 registers the source path `/fs::browse`, but find-my-way serves it on
    // the wire as single-colon `/fs:browse`; the double-colon form 404s. This
    // guards against reintroducing a `/fs:action` parametric dispatcher that
    // would accept the non-v1 double-colon URL.
    const res = await fetch(`${base}/api/v1/fs::browse`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    expect(res.status).toBe(404);
  });

  it('lists only directories and filters files', async () => {
    const root = home as string;
    await mkdir(join(root, 'alpha'));
    await mkdir(join(root, 'beta'));
    await writeFile(join(root, 'README.md'), 'hi');

    const { body } = await getJson<BrowseWire>(
      `/api/v1/fs:browse?path=${encodeURIComponent(root)}`,
    );
    expect(body.code).toBe(0);
    expect(body.data.path).toBe(await realpath(root));
    const names = body.data.entries.map((e) => e.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
    for (const entry of body.data.entries) {
      expect(entry.is_dir).toBe(true);
      expect(entry.path).toBe(join(await realpath(root), entry.name));
    }
  });

  it('sorts dot-directories after regular ones', async () => {
    const root = home as string;
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

describe('server-v2 /api/v1 fs:content', () => {
  let server: RunningServer | undefined;
  let dir: string | undefined;
  let instancesDir: string | undefined;
  let base: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fscontent-'));
    instancesDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fscontent-instances-'));
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: dir,
      instancesDir,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
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
    // `connection: close` keeps every fetch on its own short-lived socket so
    // undici never pools an idle keep-alive connection that would hold
    // `server.close()` open in afterEach.
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

  // /dev/null is a character device, not a regular file.
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
