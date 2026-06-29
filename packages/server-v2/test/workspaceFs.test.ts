import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';

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
  is_git_repo: boolean;
  branch?: string;
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
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-fs-'));
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

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function postJson<T>(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    const hasBody = body !== undefined;
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: hasBody ? { 'content-type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  it('defaults browse to $HOME when path is omitted', async () => {
    const { status, body } = await getJson<BrowseWire>('/api/v1/fs::browse');
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.path).toBe(await realpath(homedir()));
    expect(typeof body.data.parent === 'string' || body.data.parent === null).toBe(true);
    expect(Array.isArray(body.data.entries)).toBe(true);
  });

  it('lists only directories and filters files', async () => {
    const root = home as string;
    await mkdir(join(root, 'alpha'));
    await mkdir(join(root, 'beta'));
    await writeFile(join(root, 'README.md'), 'hi');

    const { body } = await getJson<BrowseWire>(
      `/api/v1/fs::browse?path=${encodeURIComponent(root)}`,
    );
    expect(body.code).toBe(0);
    expect(body.data.path).toBe(await realpath(root));
    const names = body.data.entries.map((e) => e.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
    for (const entry of body.data.entries) {
      expect(entry.is_dir).toBe(true);
      expect(entry.path).toBe(join(await realpath(root), entry.name));
      expect(typeof entry.is_git_repo).toBe('boolean');
    }
  });

  it('annotates git repositories with the current branch', async () => {
    const root = home as string;
    const repo = join(root, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await mkdir(join(root, 'plain'));

    const { body } = await getJson<BrowseWire>(
      `/api/v1/fs::browse?path=${encodeURIComponent(root)}`,
    );
    expect(body.code).toBe(0);
    const byName = new Map(body.data.entries.map((e) => [e.name, e]));
    expect(byName.get('repo')?.is_git_repo).toBe(true);
    expect(byName.get('repo')?.branch).toBe('main');
    expect(byName.get('plain')?.is_git_repo).toBe(false);
    expect(byName.get('plain')?.branch).toBeUndefined();
  });

  it('sorts dot-directories after regular ones', async () => {
    const root = home as string;
    await mkdir(join(root, '.zeta'));
    await mkdir(join(root, 'alpha'));

    const { body } = await getJson<BrowseWire>(
      `/api/v1/fs::browse?path=${encodeURIComponent(root)}`,
    );
    expect(body.code).toBe(0);
    expect(body.data.entries.map((e) => e.name)).toEqual(['alpha', '.zeta']);
  });

  it('returns parent=null for the filesystem root', async () => {
    const { body } = await getJson<BrowseWire>('/api/v1/fs::browse?path=%2F');
    expect(body.code).toBe(0);
    expect(body.data.path).toBe('/');
    expect(body.data.parent).toBeNull();
  });

  it('rejects a relative path (40001)', async () => {
    const { body } = await getJson<null>(
      `/api/v1/fs::browse?path=${encodeURIComponent('relative/path')}`,
    );
    expect(body.code).toBe(40001);
  });

  it('rejects a nonexistent path (40409)', async () => {
    const missing = join(home as string, 'does-not-exist');
    const { body } = await getJson<null>(
      `/api/v1/fs::browse?path=${encodeURIComponent(missing)}`,
    );
    expect(body.code).toBe(40409);
  });

  it('returns an empty recent_roots when no workspaces are registered', async () => {
    const { status, body } = await getJson<HomeWire>('/api/v1/fs::home');
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.home).toBe(homedir());
    expect(body.data.recent_roots).toEqual([]);
  });

  it('reflects registered workspace roots in recent_roots', async () => {
    const root = home as string;
    const created = await postJson<{ id: string }>('/api/v1/workspaces', { root });
    expect(created.body.code).toBe(0);

    const { body } = await getJson<HomeWire>('/api/v1/fs::home');
    expect(body.code).toBe(0);
    expect(body.data.recent_roots).toContain(root);
  });
});
