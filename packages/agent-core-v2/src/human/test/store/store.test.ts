import { describe, expect, it } from 'vitest';

import { MemoryBackend } from '#/store/backend/memory';
import { TreeStore } from '#/store/store';
import type { CorruptionReport, EntryLine } from '#/store/types';

function openStore(backend: MemoryBackend = new MemoryBackend(), opts?: { offloadThreshold?: number }) {
  return TreeStore.open(backend, opts);
}

function entryData(text: string) {
  return { type: 'chat.message', kind: 'text', data: { text } };
}

function refOf(entry: EntryLine): string {
  if (!('ref' in entry.payload)) throw new Error('expected an offloaded payload');
  return entry.payload.ref;
}

const HEADER = '{"kind":"header","version":1,"tree":"chat","branch":"main","createdAt":1}';

function entryJson(seq: number, text: string): string {
  return `{"kind":"entry","seq":${seq},"ts":${seq + 1},"type":"chat.message","payload":{"kind":"text","size":1,"data":"${text}"}}`;
}

function fileOf(backend: MemoryBackend, tree: string, branch: string): string {
  const content = backend.trees.files.get(tree)?.get(branch);
  expect(content).toBeDefined();
  return content as string;
}

describe('append', () => {
  it('appends linearly within a branch file', async () => {
    const backend = new MemoryBackend();
    const store = await openStore(backend);
    const tree = await store.tree('chat');
    const main = tree.createBranch('main');
    const first = await main.append(entryData('a'));
    const second = await main.append(entryData('b'));
    expect(first.seq).toBe(0);
    expect(second.seq).toBe(1);
    expect(main.head).toBe(1);
    expect(main.nextSeq).toBe(2);
    expect(fileOf(backend, 'chat', 'main').trim().split('\n')).toHaveLength(3);
  });

  it('rejects appends on a degraded branch', async () => {
    const backend = new MemoryBackend();
    backend.trees.files.set('chat', new Map([['main', `${HEADER}\n${entryJson(0, 'a')}\n${entryJson(5, 'b')}\n`]]));
    const store = await openStore(backend);
    const main = (await store.tree('chat')).openBranch('main');
    expect(main.degraded).toBe(true);
    await expect(main.append(entryData('x'))).rejects.toThrow('degraded');
  });
});

describe('branch management', () => {
  it('rejects duplicate, invalid, and unknown branches', async () => {
    const store = await openStore();
    const tree = await store.tree('chat');
    tree.createBranch('main');
    expect(() => tree.createBranch('main')).toThrow('already exists');
    expect(() => tree.createBranch('bad name')).toThrow('invalid branch name');
    expect(() => tree.openBranch('nope')).toThrow('unknown branch');
    expect(() => tree.createBranch('x', { from: { branch: 'nope', seq: 0 } })).toThrow('unknown branch');
  });

  it('rejects a fork point outside the parent branch', async () => {
    const store = await openStore();
    const tree = await store.tree('chat');
    const main = tree.createBranch('main');
    await main.append(entryData('a'));
    expect(() => tree.createBranch('x', { from: { branch: 'main', seq: 1 } })).toThrow('cannot fork');
    expect(() => tree.createBranch('x', { from: { branch: 'main', seq: -1 } })).toThrow('cannot fork');
    expect(() => tree.createBranch('x', { from: { branch: 'main', seq: 0 } })).not.toThrow();
  });

  it('rejects invalid tree names', async () => {
    const store = await openStore();
    await expect(store.tree('bad name')).rejects.toThrow('invalid tree name');
  });
});

describe('fork', () => {
  it('forks zero-copy with a header link and a chained walk', async () => {
    const backend = new MemoryBackend();
    const store = await openStore(backend);
    const tree = await store.tree('chat');
    const main = tree.createBranch('main');
    await main.append(entryData('a'));
    await main.append(entryData('b'));
    await main.append(entryData('c'));
    const forked = tree.createBranch('fork', { from: { branch: 'main', seq: 1 } });
    expect(forked.header.parentBranch).toBe('main');
    expect(forked.header.parentSeq).toBe(1);
    await forked.settled();
    expect(fileOf(backend, 'chat', 'fork').trim().split('\n')).toHaveLength(1);
    await forked.append(entryData('d'));
    const walked = [...forked.walk()];
    expect(walked.map((entry) => entry.payload.data)).toEqual([
      { text: 'd' },
      { text: 'b' },
      { text: 'a' },
    ]);
    await main.append(entryData('e'));
    expect([...forked.walk()].map((entry) => entry.payload.data)).toEqual([
      { text: 'd' },
      { text: 'b' },
      { text: 'a' },
    ]);
    expect(await store.verify()).toEqual([]);
  });

  it('reports a missing parent branch on verify', async () => {
    const backend = new MemoryBackend();
    const store = await openStore(backend);
    const tree = await store.tree('chat');
    const main = tree.createBranch('main');
    await main.append(entryData('a'));
    const forked = tree.createBranch('fork', { from: { branch: 'main', seq: 0 } });
    await forked.settled();
    backend.trees.files.get('chat')?.delete('main');
    const reports = await store.verify();
    expect(reports.some((report) => report.kind === 'parent-ref' && report.detail.includes('main'))).toBe(true);
  });

  it('reports a parent seq beyond the parent branch on verify', async () => {
    const backend = new MemoryBackend();
    backend.trees.files.set(
      'chat',
      new Map([
        ['main', `${HEADER}\n${entryJson(0, 'a')}\n`],
        [
          'fork',
          '{"kind":"header","version":1,"tree":"chat","branch":"fork","createdAt":2,"parentBranch":"main","parentSeq":9}\n',
        ],
      ]),
    );
    const store = await openStore(backend);
    const reports = await store.verify();
    expect(reports.some((report) => report.kind === 'parent-ref' && report.detail.includes('beyond'))).toBe(true);
  });
});

describe('concurrent branches', () => {
  it('appends to multiple active branches independently', async () => {
    const backend = new MemoryBackend();
    const store = await openStore(backend);
    const tree = await store.tree('chat');
    const first = tree.createBranch('a');
    const second = tree.createBranch('b');
    const [a0, b0, a1, b1] = await Promise.all([
      first.append(entryData('a0')),
      second.append(entryData('b0')),
      first.append(entryData('a1')),
      second.append(entryData('b1')),
    ]);
    expect([a0?.seq, a1?.seq]).toEqual([0, 1]);
    expect([b0?.seq, b1?.seq]).toEqual([0, 1]);
    expect([...first.walk()].map((entry) => entry.payload.data)).toEqual([{ text: 'a1' }, { text: 'a0' }]);
    expect([...second.walk()].map((entry) => entry.payload.data)).toEqual([{ text: 'b1' }, { text: 'b0' }]);
    expect(fileOf(backend, 'chat', 'a')).not.toContain('b0');
    expect(fileOf(backend, 'chat', 'b')).not.toContain('a0');
  });
});

describe('offload', () => {
  it('offloads oversized payloads and resolves them lazily', async () => {
    const store = await openStore(new MemoryBackend(), { offloadThreshold: 16 });
    const tree = await store.tree('chat');
    const main = tree.createBranch('main');
    const big = { text: 'x'.repeat(100) };
    const entry = await main.append({ type: 'chat.message', kind: 'json', data: big });
    expect(await tree.resolve(entry)).toEqual(big);
    const small = await main.append({ type: 'chat.message', kind: 'json', data: { a: 1 } });
    expect('data' in small.payload).toBe(true);
  });

  it('deduplicates identical blob content', async () => {
    const backend = new MemoryBackend();
    const store = await openStore(backend, { offloadThreshold: 16 });
    const main = (await store.tree('chat')).createBranch('main');
    const big = { text: 'y'.repeat(100) };
    const first = await main.append({ type: 'chat.message', kind: 'json', data: big });
    const second = await main.append({ type: 'chat.message', kind: 'json', data: big });
    expect(refOf(second)).toBe(refOf(first));
    expect([...backend.blobs.files.keys()]).toHaveLength(1);
  });

  it('detects blob tampering on resolve and on verify', async () => {
    const backend = new MemoryBackend();
    const store = await openStore(backend, { offloadThreshold: 16 });
    const tree = await store.tree('chat');
    const main = tree.createBranch('main');
    const entry = await main.append({ type: 'chat.message', kind: 'json', data: { text: 'z'.repeat(100) } });
    backend.blobs.files.set(refOf(entry), 'tampered');
    await expect(tree.resolve(entry)).rejects.toThrow('hash check');
    const reports = await store.verify({ blobs: true });
    expect(reports.some((report) => report.kind === 'blob-crc')).toBe(true);
  });

  it('reports a missing blob on verify', async () => {
    const backend = new MemoryBackend();
    const store = await openStore(backend, { offloadThreshold: 16 });
    const main = (await store.tree('chat')).createBranch('main');
    const entry = await main.append({ type: 'chat.message', kind: 'json', data: { text: 'q'.repeat(100) } });
    backend.blobs.files.delete(refOf(entry));
    const reports = await store.verify({ blobs: true });
    expect(reports.some((report) => report.kind === 'blob-missing')).toBe(true);
  });
});

describe('persistence', () => {
  it('restores trees, branches, and entries across reopen', async () => {
    const backend = new MemoryBackend();
    const store = await openStore(backend);
    const a = (await store.tree('a')).createBranch('main');
    await a.append(entryData('1'));
    const b = (await store.tree('b')).createBranch('main');
    await b.append(entryData('2'));
    await a.append(entryData('3'));
    const reopened = await openStore(backend);
    expect(reopened.names().sort()).toEqual(['a', 'b']);
    const loaded = (await reopened.tree('a')).openBranch('main');
    expect([...loaded.walk()].map((entry) => entry.payload.data)).toEqual([{ text: '3' }, { text: '1' }]);
    const appended = await loaded.append(entryData('4'));
    expect(appended.seq).toBe(2);
  });

  it('restores fork links across reopen', async () => {
    const backend = new MemoryBackend();
    const store = await openStore(backend);
    const tree = await store.tree('chat');
    const main = tree.createBranch('main');
    await main.append(entryData('a'));
    await main.append(entryData('b'));
    const forked = tree.createBranch('fork', { from: { branch: 'main', seq: 0 } });
    await forked.append(entryData('c'));
    const reopened = await openStore(backend);
    const loaded = (await reopened.tree('chat')).openBranch('fork');
    expect(loaded.header.parentBranch).toBe('main');
    expect(loaded.header.parentSeq).toBe(0);
    expect([...loaded.walk()].map((entry) => entry.payload.data)).toEqual([{ text: 'c' }, { text: 'a' }]);
  });

  it('terminates an unterminated tail on load', async () => {
    const backend = new MemoryBackend();
    backend.trees.files.set('chat', new Map([['main', `${HEADER}\n${entryJson(0, 'a')}`]]));
    const store = await openStore(backend);
    await store.tree('chat');
    expect(fileOf(backend, 'chat', 'main').endsWith('\n')).toBe(true);
  });
});

describe('corruption', () => {
  it('truncates a torn tail on load', async () => {
    const backend = new MemoryBackend();
    const store = await openStore(backend);
    const main = (await store.tree('chat')).createBranch('main');
    await main.append(entryData('a'));
    await main.append(entryData('b'));
    await backend.trees.append('chat', 'main', '{"kind":"entry","seq":2,"ts":1');
    const reopened = await openStore(backend);
    const loaded = (await reopened.tree('chat')).openBranch('main');
    expect(loaded.nextSeq).toBe(2);
    expect(fileOf(backend, 'chat', 'main').trim().split('\n')).toHaveLength(3);
    const appended = await loaded.append(entryData('c'));
    expect(appended.seq).toBe(2);
  });

  it('quarantines a corrupt middle line and keeps the rest usable', async () => {
    const backend = new MemoryBackend();
    const reports: CorruptionReport[] = [];
    backend.trees.files.set(
      'chat',
      new Map([['main', `${HEADER}\n${entryJson(0, 'a')}\nnot-json\n${entryJson(2, 'c')}\n`]]),
    );
    const store = await TreeStore.open(backend, {
      subscribers: [{ prefix: '', subscriber: { onCorruption: (report) => reports.push(report) } }],
    });
    const main = (await store.tree('chat')).openBranch('main');
    expect(main.degraded).toBe(false);
    expect(main.nextSeq).toBe(3);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.kind).toBe('syntax');
    expect(reports[0]?.seq).toBe(1);
    expect([...main.walk()].map((entry) => entry.seq)).toEqual([2, 0]);
    const appended = await main.append(entryData('d'));
    expect(appended.seq).toBe(3);
  });

  it('degrades on a seq gap and recovers via repair', async () => {
    const backend = new MemoryBackend();
    backend.trees.files.set(
      'chat',
      new Map([['main', `${HEADER}\n${entryJson(0, 'a')}\n${entryJson(5, 'b')}\n`]]),
    );
    const store = await openStore(backend);
    const main = (await store.tree('chat')).openBranch('main');
    expect(main.degraded).toBe(true);
    await expect(main.append(entryData('x'))).rejects.toThrow('degraded');
    await main.repair();
    expect(main.degraded).toBe(false);
    const appended = await main.append(entryData('y'));
    expect(appended.seq).toBe(1);
    expect(fileOf(backend, 'chat', 'main').trim().split('\n')).toHaveLength(3);
  });

  it('degrades on an invalid header', async () => {
    const backend = new MemoryBackend();
    backend.trees.files.set('chat', new Map([['main', `not-a-header\n${entryJson(0, 'a')}\n`]]));
    const store = await openStore(backend);
    const main = (await store.tree('chat')).openBranch('main');
    expect(main.degraded).toBe(true);
    const reports = await store.verify();
    expect(reports.some((report) => report.kind === 'header')).toBe(true);
  });
});

describe('subscribers', () => {
  it('routes onAppend by type prefix', async () => {
    const store = await openStore();
    const appended: string[] = [];
    const unsubscribe = store.subscribe('chat', {
      onAppend: (_tree, _branch, entry) => appended.push(entry.type),
    });
    const main = (await store.tree('chat')).createBranch('main');
    await main.append({ type: 'chat.message', kind: 'text', data: 'a' });
    await main.append({ type: 'tool.result', kind: 'json', data: 1 });
    expect(appended).toEqual(['chat.message']);
    unsubscribe();
    await main.append({ type: 'chat.message', kind: 'text', data: 'b' });
    expect(appended).toHaveLength(1);
  });
});

describe('walk and tip', () => {
  it('walks a branch from its tip', async () => {
    const store = await openStore();
    const main = (await store.tree('chat')).createBranch('main');
    await main.append(entryData('a'));
    await main.append(entryData('b'));
    await main.append(entryData('c'));
    expect(main.head).toBe(2);
    expect(main.tip()?.payload.data).toEqual({ text: 'c' });
    expect([...main.walk()].map((entry) => entry.seq)).toEqual([2, 1, 0]);
  });

  it('walks nothing on an empty branch', async () => {
    const store = await openStore();
    const main = (await store.tree('chat')).createBranch('main');
    expect(main.head).toBeNull();
    expect(main.tip()).toBeNull();
    expect([...main.walk()]).toEqual([]);
  });
});
