import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ArtexExchangeInput } from './artexTrafficStore';
import { FileArtexTrafficStore } from './fileArtexTrafficStore';

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
});
