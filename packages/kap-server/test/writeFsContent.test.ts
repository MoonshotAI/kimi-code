import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const digest = (content: string) => createHash('sha256').update(content).digest('hex');

describe('PUT /api/v1/fs:content', () => {
  let root: string;
  let home: string;
  let file: string;
  let base: string;
  let server: RunningServer;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'kimi-fs-content-'));
    home = join(root, 'custom-home');
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
    const meta = await authedFetch(server, base, '/api/v1/meta');
    const { data } = await meta.json() as { data: { home_dir: string } };
    file = join(data.home_dir, 'AGENTS.md');
  });
  afterEach(async () => { await rm(file, { recursive: true, force: true }); });
  afterAll(async () => { await server?.close(); if (root) await rm(root, { recursive: true, force: true }); });

  function put(path: string, text: string, revision = 'missing', environment?: string) {
    const query = new URLSearchParams({ path, revision });
    if (environment) query.set('environment_id', environment);
    return authedFetch(server, base, `/api/v1/fs:content?${query.toString()}`, { method: 'PUT', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: text });
  }

  it('reads missing, creates, replaces and clears the allowlisted file via HTTP', async () => {
    expect(file).toBe(join(home, 'AGENTS.md'));
    const url = `/api/v1/fs:content?${new URLSearchParams({ path: file }).toString()}`;
    const missing = await authedFetch(server, base, url);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 40409 });
    const text = '\uFEFF  保留空白\r\n';
    const created = await put(file, text);
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ code: 0, data: { revision: digest(text) } });
    expect(await readFile(file, 'utf8')).toBe(text);
    const read = await authedFetch(server, base, url);
    expect(Buffer.from(await read.arrayBuffer()).equals(Buffer.from(text))).toBe(true);
    expect((await put(file, '', digest(text))).status).toBe(200);
    expect(await readFile(file, 'utf8')).toBe('');
  });

  it('denies other home files, project instruction files, relative paths and other environments', async () => {
    const project = join(root, 'AGENTS.md');
    await writeFile(project, 'keep');
    for (const path of [project, join(home, 'other.txt'), 'AGENTS.md']) {
      expect((await put(path, 'no')).status).toBe(403);
    }
    expect((await put(file, 'no', 'missing', 'remote')).status).toBe(403);
    expect(await readFile(project, 'utf8')).toBe('keep');
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not replace a directory at the allowlisted path', async () => {
    await mkdir(file);
    expect((await put(file, 'no')).status).toBe(403);
  });

  it.skipIf(process.platform === 'win32')('rejects both existing and dangling symlinks without following them', async () => {
    const other = join(root, 'link-target');
    await symlink(other, file);
    expect((await put(file, 'no')).status).toBe(403);
    await writeFile(other, 'keep');
    expect((await put(file, 'no', digest('keep'))).status).toBe(403);
    expect(await readFile(other, 'utf8')).toBe('keep');
  });

  it('does not overwrite an external edit or accept two saves of the same revision', async () => {
    await writeFile(file, 'edited');
    expect((await put(file, 'new')).status).toBe(412);
    expect((await put(file, 'new', digest('older'))).status).toBe(412);
    expect(await readFile(file, 'utf8')).toBe('edited');
    const results = await Promise.all(['one', 'two'].map(text => put(file, text, digest('edited'))));
    expect(results.map(r => r.status).toSorted()).toEqual([200, 412]);
  });

  it('requires a revision, authenticated request and text payload', async () => {
    const url = `/api/v1/fs:content?${new URLSearchParams({ path: file }).toString()}`;
    expect((await fetch(`${base}${url}&revision=missing`, { method: 'PUT', body: 'no' })).status).toBe(401);
    const noRevision = await authedFetch(server, base, url, { method: 'PUT', body: 'no' });
    expect(await noRevision.json()).toMatchObject({ code: 40001 });
    const invalid = await authedFetch(server, base, `${url}&revision=missing`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '"no"' });
    expect(await invalid.json()).toMatchObject({ code: 40001 });
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
