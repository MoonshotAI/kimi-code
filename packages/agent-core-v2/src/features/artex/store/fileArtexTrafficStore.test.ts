import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ArtexExchangeInput } from './artexTrafficStore';
import { FileArtexTrafficStore } from './fileArtexTrafficStore';
import { reapStaleFileLock } from './fileLock';
import { artexTrafficStoreFile, artexTrafficStoreLockPath } from './paths';

function exchange(overrides: Partial<ArtexExchangeInput> = {}): ArtexExchangeInput {
  return {
    host: 'example.test',
    method: 'GET',
    url: 'https://example.test/api/login',
    status: 200,
    contentType: 'application/json',
    reqHead: 'GET /api/login HTTP/1.1\nHost: example.test\n',
    respHead: 'HTTP 200\nContent-Type: application/json\n',
    reqBody: Buffer.from(''),
    respBody: Buffer.from('{"token":"P@ssw0rd-123","role":"admin"}'),
    ...overrides,
  };
}

describe('FileArtexTrafficStore', () => {
  let dir: string;
  let store: FileArtexTrafficStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'artex-traffic-'));
    store = new FileArtexTrafficStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('records then finds an exchange by host, url substring and body keyword', async () => {
    const id = await store.record(exchange());
    expect(id).toMatch(/^\d+-\d{4}$/);

    const byHost = await store.search({ host: 'example.test' });
    expect(byHost).toHaveLength(1);
    expect(byHost[0]!.id).toBe(id);
    expect(byHost[0]!.respLen).toBeGreaterThan(0);

    const byContains = await store.search({ host: 'example.test', contains: 'login' });
    expect(byContains).toHaveLength(1);

    const byBody = await store.search({ host: 'example.test', bodyContains: 'ssw0rd' });
    expect(byBody).toHaveLength(1);

    const miss = await store.search({ host: 'example.test', bodyContains: 'nothinghere' });
    expect(miss).toHaveLength(0);
  });

  it('searches across all hosts when host is omitted, empty, or absent', async () => {
    const alpha = await store.record(
      exchange({ host: 'alpha.example.test', url: 'https://alpha.example.test/one' }),
    );
    const beta = await store.record(
      exchange({ host: 'beta.example.test', url: 'https://beta.example.test/two' }),
    );

    const acrossAll = await store.search({});
    expect(acrossAll.map((row) => row.id).toSorted()).toEqual([alpha, beta].toSorted());

    const emptyHost = await store.search({ host: '' });
    expect(emptyHost).toHaveLength(2);

    const whitespaceHost = await store.search({ host: '   ' });
    expect(whitespaceHost).toHaveLength(2);

    const noFilters = await store.search({ host: '', contains: '', bodyContains: '' });
    expect(noFilters).toHaveLength(2);

    const stillScoped = await store.search({ host: 'alpha.example.test' });
    expect(stillScoped).toHaveLength(1);
    expect(stillScoped[0]!.id).toBe(alpha);
  });

  it('rejects a too-short body keyword rather than guessing', async () => {
    await store.record(exchange());
    await expect(store.search({ host: 'example.test', bodyContains: 'ab' })).rejects.toThrow(
      /at least 3 characters/,
    );
  });

  it('serves the raw request/response and spills a large body to a blob readable via range', async () => {
    const big = Buffer.from('X'.repeat(300 * 1024) + 'NEEDLE-at-end');
    const id = await store.record(exchange({ respBody: big, contentType: 'text/plain' }));

    const raw = await store.get(id);
    expect(raw?.response).toContain('@blob sha256:');

    const search = await store.search({ host: 'example.test', bodyContains: 'needle-at-end' });
    expect(search).toHaveLength(1);

    const blobHash = /@blob sha256:([0-9a-f]{64})/.exec(raw!.response)![1]!;
    const range = await store.blobRange(blobHash, big.length - 13, 13);
    expect(range?.data.toString()).toBe('NEEDLE-at-end');
  });

  it('binds a recorded exchange to a finding with a role, position and snapshot', async () => {
    const id = await store.record(exchange());
    const created = await store.bindToFinding(42, [{ trafficId: id, role: 'proof', note: 'login' }]);
    expect(created).toBe(1);

    const again = await store.bindToFinding(42, [{ trafficId: id, role: 'proof' }]);
    expect(again).toBe(0);

    const bindings = await store.findingBindings(42);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.role).toBe('proof');
    expect(bindings[0]!.position).toBe(0);
    expect(bindings[0]!.snapshot.respHash).toMatch(/^[0-9a-f]{64}$/);
    expect(bindings[0]!.snapshot.respLen).toBeGreaterThan(0);
  });

  it('rejects an unknown role and an unknown traffic id', async () => {
    const id = await store.record(exchange());
    await expect(store.bindToFinding(1, [{ trafficId: id, role: 'bogus' }])).rejects.toThrow(
      /invalid traffic role/,
    );
    await expect(store.bindToFinding(1, [{ trafficId: 'missing' }])).rejects.toThrow(/does not exist/);
  });

  it('confirms a verbatim quote only when it appears byte-for-byte, rejecting otherwise', async () => {
    const id = await store.record(exchange());

    const hit = await store.verbatimInRecord(id, '"token":"P@ssw0rd-123"');
    expect(hit.found).toBe(true);
    expect(hit.side).toBe('response');

    const miss = await store.verbatimInRecord(id, '"token":"not-the-real-value"');
    expect(miss.found).toBe(false);
  });

  it('keeps traffic-index.json lean without inline base64 bodies or unbounded index strings', async () => {
    const reqBody = Buffer.from('A'.repeat(128 * 1024));
    const respBody = Buffer.from('B'.repeat(200 * 1024));
    const id = await store.record(exchange({ reqBody, respBody, contentType: 'text/plain' }));

    const rawIndex = await readFile(artexTrafficStoreFile(dir), 'utf8');
    expect(rawIndex.length).toBeLessThan(16 * 1024);
    expect(rawIndex).not.toContain('reqInline');
    expect(rawIndex).not.toContain('respInline');
    const parsed = JSON.parse(rawIndex) as { exchanges: Array<Record<string, unknown>> };
    expect(parsed.exchanges[0]?.['index']).toBeUndefined();
    expect(typeof parsed.exchanges[0]?.['reqBlob']).toBe('string');
    expect(typeof parsed.exchanges[0]?.['respBlob']).toBe('string');
    expect((await store.get(id))?.response).toContain('B'.repeat(100));
  });

  it('ingests external traffic, lists hosts, and handles 120 concurrent writers safely', async () => {
    const ids = await store.ingestExternalTraffic([
      {
        method: 'POST',
        url: 'https://api.example.test/v1/auth',
        status: 200,
        respHead: 'HTTP/1.1 200 OK\nContent-Type: application/json\n',
        respBody: '{"ok":true}',
      },
      {
        method: 'GET',
        url: 'https://cdn.example.test/app.js',
        status: 200,
        respBody: 'console.log(1)',
      },
    ]);
    expect(ids).toHaveLength(2);
    const hosts = await store.listHosts();
    expect(hosts.map((h) => h.host).toSorted()).toEqual(['api.example.test', 'cdn.example.test']);

    const concurrentIds = await Promise.all(
      Array.from({ length: 120 }, (_, index) =>
        store.record(
          exchange({
            url: `https://load.example.test/item/${String(index)}`,
            host: 'load.example.test',
            respBody: Buffer.from(`payload-${String(index)}`),
          }),
        ),
      ),
    );
    expect(new Set(concurrentIds).size).toBe(120);
    expect(await store.count()).toBe(122);
  });

  it('reaps stale locks atomically with token verification without stealing replacement locks', async () => {
    const lockPath = artexTrafficStoreLockPath(dir);
    await store.record(exchange());
    await writeFile(
      lockPath,
      'pid=999999 since=2020-01-01T00:00:00.000Z token=stale-token',
      'utf8',
    );
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () => reapStaleFileLock(lockPath, 30_000)),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);

    await writeFile(
      lockPath,
      `pid=${String(process.pid)} since=${new Date().toISOString()} token=live-token`,
      'utf8',
    );
    expect(await reapStaleFileLock(lockPath, 30_000)).toBe(false);
    expect(await readFile(lockPath, 'utf8')).toContain('token=live-token');
    await rm(lockPath, { force: true });
  });
});
