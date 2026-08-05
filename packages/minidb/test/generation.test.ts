// test/generation.test.ts
//
// Persistent index generations (stage 5): unit tests for the codecs and the
// skiplist bulk loader, integration tests for the build → publish → load
// cycle, and the crash/corruption fault matrix. The fault-injection tests
// patch the shared node:fs/promises default export (all source modules
// consume it through a default import, so the patch lands everywhere) with
// path-predicated wrappers, plus the barrier facility from helpers.ts for
// deterministic mid-build crash points.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MiniDb } from '../src/index.js';
import { SkipList, cmpNumber, cmpString } from '../src/skiplist.js';
import {
  GenerationCorruptError,
  parseGenerationBuffer,
  readStoreImage,
  readDtIndexImage,
  readSecondaryIndexImage,
  readCompoundIndexImage,
  readTextDocsImage,
  writeStoreImage,
  writeDtIndexImage,
  writeSecondaryIndexImage,
  writeCompoundIndexImage,
  writeTextDocsImage,
} from '../src/gen-codec.js';
import type { StoreImageRecord } from '../src/gen-codec.js';
import { readManifest, listGenerations } from '../src/generation-files.js';
import { tmpDir, rmrf, waitFor, deferred } from './helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function openTmp(name: string): Promise<string> {
  const dir = await tmpDir(`minidb-gen-${name}-`);
  cleanups.push(() => rmrf(dir));
  return dir;
}

type AnyDb = MiniDb<unknown>;

async function closeAll(...dbs: (AnyDb | undefined)[]): Promise<void> {
  for (const db of dbs) await db?.close().catch(() => {});
}

/** Patch fs.open so handles for paths matching `pred` get their writev/sync
 *  replaced by `fail` (once). Returns a restore function. */
function failFileWrites(pred: (p: string) => boolean, fail: 'writev' | 'sync', error: unknown): () => void {
  const original = fs.open;
  let fired = false;
  (fs as unknown as Record<string, unknown>).open = async (p: fsSync.PathLike, flags?: string) => {
    const handle = await original(p as string, flags as string);
    const s = String(p);
    if (!fired && pred(s)) {
      fired = true;
      (handle as unknown as Record<string, unknown>)[fail] = () => Promise.reject(error);
    }
    return handle;
  };
  return () => {
    (fs as unknown as Record<string, unknown>).open = original;
  };
}

/** Patch fs.rename, failing calls whose (src,dst) pair matches. */
function failRenames(pred: (src: string, dst: string) => boolean, error: unknown): () => void {
  const original = fs.rename;
  (fs as unknown as Record<string, unknown>).rename = (src: string, dst: string) =>
    pred(String(src), String(dst)) ? Promise.reject(error) : original(src, dst);
  return () => {
    (fs as unknown as Record<string, unknown>).rename = original;
  };
}

/** Populate a db with one of every index family and a body of docs. */
async function seedIndexedDb(db: MiniDb<Record<string, unknown>>, n = 2000): Promise<void> {
  await db.createIndex('byKind', { field: 'kind' });
  await db.createIndex('byScore', { field: 'score', type: 'range' });
  await db.createCompoundIndex('byKindTime', { groupBy: 'kind', orderBy: 'ts' });
  await db.createTextIndex('ft', { fields: ['text'] });
  await db.createTextIndex('tri', { fields: ['text'], tokenizer: 'ngram' });
  for (let i = 0; i < n; i++) {
    await db.set(
      `k${i}`,
      { kind: `t${i % 7}`, score: i % 100, ts: 1700000000000 + i, text: `hello world doc ${i} 持久化 索引 ${i % 13}` },
      { dt: { ts: 1700000000000 + i } },
    );
  }
}

/** The exact assertions a correctly-loaded seeded db must satisfy. `size`
 *  defaults to n but callers that added/removed keys after seeding pass the
 *  expected live count explicitly; `dtTail` likewise covers the dt-window
 *  assertion when extra keys carry newer dt values. */
function assertSeededDb(db: MiniDb<Record<string, unknown>>, n = 2000, size = n, dtTail = 10, k0Present = true): void {
  const eqT3 = [...Array(n)].filter((_, i) => i % 7 === 3).length;
  expect(db.size).toBe(size);
  if (k0Present) expect(db.get('k0')).toMatchObject({ kind: 't0', score: 0 });
  expect(db.get(`k${n - 1}`)).toMatchObject({ kind: `t${(n - 1) % 7}` });
  expect(db.findEq('byKind', 't3').length).toBe(eqT3);
  expect(db.findRange('byScore', { min: 42, max: 42 }).length).toBe(Math.floor(n / 100) + (n % 100 > 42 ? 1 : 0));
  expect(db.compoundRange('byKindTime', 't2', { limit: 5 }).length).toBe(5);
  expect(db.dtRange('ts', { gte: 1700000000000 + n - 10 }).length).toBe(dtTail);
  expect(db.search('ft', '持久化').length).toBeGreaterThan(0);
  expect(db.search('tri', 'hello world').length).toBeGreaterThan(0);
}

// ---- unit: skiplist bulk load ----------------------------------------------

describe('skiplist bulkLoad', () => {
  test('matches one-by-one inserts on content, rank, and range behavior', () => {
    const entries: { key: number; val: string }[] = [];
    for (let i = 0; i < 5000; i++) entries.push({ key: i * 2, val: `v${i}` });
    const bulk = SkipList.bulkLoad(entries, { compareKey: cmpNumber, compareVal: cmpString });
    const inc = new SkipList<number, string>({ compareKey: cmpNumber, compareVal: cmpString });
    for (const e of entries) inc.insert(e.key, e.val);
    expect(bulk.length).toBe(inc.length);
    expect(bulk.toArray()).toEqual(inc.toArray());
    for (const probe of [0, 1, 42, 2499, 4999]) {
      const e = entries[probe]!;
      expect(bulk.getRank(e.key, e.val)).toBe(inc.getRank(e.key, e.val));
    }
    expect(bulk.getByRank(0)).toEqual(inc.getByRank(0));
    expect(bulk.getByRank(4999)).toEqual(inc.getByRank(4999));
    expect(bulk.range({ gte: 100, lte: 200, count: 7 })).toEqual(inc.range({ gte: 100, lte: 200, count: 7 }));
    expect([...bulk.iterate({ reverse: true, count: 5 })]).toEqual([...inc.iterate({ reverse: true, count: 5 })]);
    // Mutations after the bulk load keep every invariant.
    bulk.insert(3, 'v-new');
    bulk.delete(100, 'v50');
    inc.insert(3, 'v-new');
    inc.delete(100, 'v50');
    expect(bulk.toArray()).toEqual(inc.toArray());
    expect(bulk.getRank(3, 'v-new')).toBe(inc.getRank(3, 'v-new'));
    expect(bulk.getByRank(1234)).toEqual(inc.getByRank(1234));
  });

  test('dedupes exact (key, val) duplicates like insert would', () => {
    const bulk = SkipList.bulkLoad(
      [
        { key: 1, val: 'a' },
        { key: 1, val: 'a' },
        { key: 1, val: 'b' },
      ],
      { compareKey: cmpNumber, compareVal: cmpString },
    );
    expect(bulk.length).toBe(2);
    expect(bulk.toArray()).toEqual([
      { key: 1, val: 'a' },
      { key: 1, val: 'b' },
    ]);
  });
});

// ---- unit: gen-codec round-trips --------------------------------------------

describe('gen-codec', () => {
  test('store image round-trips memory + disk refs, expiry and dt metadata', async () => {
    const dir = await openTmp('codec-store');
    // Keys are canonical (binary) strings: each char code is one byte of the
    // key's utf8 encoding — the form the store and every index uses.
    const kstr = (s: string): string => Buffer.from(s, 'utf8').toString('binary');
    const records: StoreImageRecord[] = [
      { kstr: 'a', ref: { kind: 'memory', value: Buffer.from('v1') }, expireAt: 0, dt: null },
      { kstr: 'b', ref: { kind: 'disk', loc: { file: 'snapshot', off: 123, len: 45 } }, expireAt: 9999999999999, dt: { ts: 7 } },
      { kstr: 'c', ref: { kind: 'disk', loc: { file: 'wal', off: 9999999999, len: 1 } }, expireAt: 0, dt: null },
      { kstr: kstr('é-key-键'), ref: { kind: 'memory', value: Buffer.from('utf8 value ✓') }, expireAt: 0, dt: null },
    ];
    const info = await writeStoreImage(path.join(dir, 'store'), records);
    const buf = await fs.readFile(path.join(dir, 'store'));
    expect(info.bytes).toBe(buf.length);
    const parsed = parseGenerationBuffer(buf, 'MDGS', 4);
    expect(parsed.bytes).toBe(info.bytes);
    expect(parsed.crc32).toBe(info.crc32);
    const out = [...readStoreImage(parsed.payload)];
    expect(out.map((r) => r.kstr)).toEqual(records.map((r) => r.kstr));
    expect(out[0]!.ref).toEqual(records[0]!.ref);
    expect(out[1]!.ref).toEqual(records[1]!.ref);
    expect(out[1]!.expireAt).toBe(records[1]!.expireAt);
    expect(out[1]!.dt).toEqual({ ts: 7 });
    expect(out[2]!.ref).toEqual(records[2]!.ref);
    expect((out[3]!.ref as { value: Buffer }).value.toString('utf8')).toBe('utf8 value ✓');
    expect(Buffer.from(out[3]!.kstr, 'binary').toString('utf8')).toBe('é-key-键');
  });

  test('a single-byte flip anywhere makes the crc check fail', async () => {
    const dir = await openTmp('codec-corrupt');
    await writeStoreImage(path.join(dir, 'store'), [
      { kstr: 'a', ref: { kind: 'memory', value: Buffer.from('v1') }, expireAt: 0, dt: null },
    ]);
    const buf = await fs.readFile(path.join(dir, 'store'));
    for (const pos of [0, 5, buf.length - 5]) {
      const bad = Buffer.from(buf);
      bad[pos] = bad[pos]! ^ 0xff;
      expect(() => parseGenerationBuffer(bad, 'MDGS', 4)).toThrow(GenerationCorruptError);
    }
    // Wrong magic / unsupported version are structured errors too.
    expect(() => parseGenerationBuffer(buf, 'XXXX', 1)).toThrow(GenerationCorruptError);
    expect(() => parseGenerationBuffer(buf, 'MDGS', 99)).toThrow(GenerationCorruptError);
  });

  test('dt / secondary / compound / text-docs images round-trip', async () => {
    const dir = await openTmp('codec-indexes');
    await writeDtIndexImage(path.join(dir, 'dt'), [
      { name: 'ts', entries: [{ ms: 1, key: 'a' }, { ms: 2, key: 'b' }, { ms: 2, key: 'c' }] },
      { name: 'created', entries: [{ ms: 9, key: 'z' }] },
    ]);
    const dt = readDtIndexImage(parseGenerationBuffer(await fs.readFile(path.join(dir, 'dt')), 'MDGD', 1).payload);
    expect(dt).toEqual([
      { name: 'ts', entries: [{ ms: 1, key: 'a' }, { ms: 2, key: 'b' }, { ms: 2, key: 'c' }] },
      { name: 'created', entries: [{ ms: 9, key: 'z' }] },
    ]);

    await writeSecondaryIndexImage(path.join(dir, 'sec'), [
      {
        name: 'byKind',
        field: 'kind',
        type: 'equality',
        unique: true,
        sparse: false,
        equality: [{ scalarKey: 'string:t1', pks: ['a', 'b'] }],
        range: null,
      },
      {
        name: 'byScore',
        field: 'score',
        type: 'range',
        unique: false,
        sparse: true,
        equality: null,
        range: [{ value: 1.5, pk: 'a' }, { value: 2, pk: 'b' }],
      },
    ]);
    const sec = readSecondaryIndexImage(parseGenerationBuffer(await fs.readFile(path.join(dir, 'sec')), 'MDSI', 1).payload);
    expect(sec[0]).toMatchObject({ name: 'byKind', unique: true, sparse: false, equality: [{ scalarKey: 'string:t1', pks: ['a', 'b'] }] });
    expect(sec[1]).toMatchObject({ name: 'byScore', type: 'range', range: [{ value: 1.5, pk: 'a' }, { value: 2, pk: 'b' }] });

    await writeCompoundIndexImage(path.join(dir, 'cmp'), [
      {
        name: 'g',
        groupBy: 'kind',
        orderBy: 'ts',
        orderType: 'number',
        groups: [
          { group: 't1', entries: [{ order: 5, pk: 'a' }, { order: 6, pk: 'b' }] },
          { group: 42, entries: [{ order: 1, pk: 'z' }] },
          { group: null, entries: [] },
          { group: true, entries: [{ order: 2, pk: 'y' }] },
        ],
      },
      {
        name: 's',
        groupBy: 'kind',
        orderBy: 'name',
        orderType: 'string',
        groups: [{ group: 't1', entries: [{ order: 'abc', pk: 'a' }] }],
      },
    ]);
    const cmp = readCompoundIndexImage(parseGenerationBuffer(await fs.readFile(path.join(dir, 'cmp')), 'MDCI', 1).payload);
    expect(cmp[0]!.groups[0]).toEqual({ group: 't1', entries: [{ order: 5, pk: 'a' }, { order: 6, pk: 'b' }] });
    expect(cmp[0]!.groups[1]).toEqual({ group: 42, entries: [{ order: 1, pk: 'z' }] });
    expect(cmp[0]!.groups[2]).toEqual({ group: null, entries: [] });
    expect(cmp[0]!.groups[3]).toEqual({ group: true, entries: [{ order: 2, pk: 'y' }] });
    expect(cmp[1]!.orderType).toBe('string');

    await writeTextDocsImage(path.join(dir, 'docs'), {
      keys: ['a', undefined, 'c'],
      docLens: [10, undefined, 3],
      liveCount: 2,
      removed: [1],
      delta: [{ term: 'hello', docs: [{ docID: 2, freq: 4 }] }],
    });
    const docs = readTextDocsImage(parseGenerationBuffer(await fs.readFile(path.join(dir, 'docs')), 'MDTC', 1).payload);
    expect(docs.keys).toEqual(['a', undefined, 'c']);
    expect(docs.docLens).toEqual([10, undefined, 3]);
    expect(docs.liveCount).toBe(2);
    expect(docs.removed).toEqual([1]);
    expect(docs.delta).toEqual([{ term: 'hello', docs: [{ docID: 2, freq: 4 }] }]);
  });
});

// ---- integration: build / publish / load ------------------------------------

describe('generation build + load', () => {
  test('explicit build publishes; reopen loads the generation with zero rebuilds', async () => {
    const dir = await openTmp('basic');
    let db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedIndexedDb(db, 2000);
    await db.rebuildGeneration();
    const gen = db.getIndexGeneration();
    expect(gen).not.toBeNull();
    expect(db.stats.generationBuilds).toBeGreaterThanOrEqual(1);
    expect(db.stats.generationBuildErrors).toBe(0);
    expect(fsSync.existsSync(path.join(dir, 'CURRENT'))).toBe(true);
    expect(fsSync.existsSync(path.join(dir, 'generations', gen!.id, 'manifest.json'))).toBe(true);
    // WAL delta after the checkpoint.
    for (let i = 2000; i < 2100; i++) {
      await db.set(`k${i}`, { kind: 't1', score: 1, ts: 1700000000000 + i, text: `delta ${i} 增量` }, { dt: { ts: 1700000000000 + i } });
    }
    await db.del('k0');
    await db.close();

    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    expect(db.stats.generationLoads).toBe(1);
    expect(db.stats.generationIndexRebuilds).toBe(0);
    expect(db.stats.indexRebuildDecoded).toBe(0); // proves: no corpus re-decode
    expect(db.stats.textRebuildDurationMs).toBe(0); // proves: no tokenization
    expect(db.getIndexGeneration()?.id).toBe(gen!.id);
    expect(db.recoveryInfo?.indexGeneration?.id).toBe(gen!.id);
    assertSeededDb(db, 2000, 2099, 110, false);
    // The WAL delta landed too.
    expect(db.get('k0')).toBeUndefined();
    expect(db.get('k2099')).toMatchObject({ kind: 't1' });
    expect(db.search('ft', '增量').length).toBe(50);
    await db.close();
  });

  test('disk valueMode round-trips through a generation', async () => {
    const dir = await openTmp('disk-mode');
    let db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', valueMode: 'disk' });
    await seedIndexedDb(db, 500);
    await db.rebuildGeneration();
    for (let i = 500; i < 550; i++) {
      await db.set(`k${i}`, { kind: 't1', score: 2, ts: 1700000000000 + i, text: `delta disk ${i}` }, { dt: { ts: 1700000000000 + i } });
    }
    await db.close();
    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', valueMode: 'disk' });
    expect(db.stats.generationLoads).toBe(1);
    assertSeededDb(db, 500, 550, 60);
    expect(db.size).toBe(550);
    expect(db.get('k42')).toMatchObject({ score: 42 });
    expect(db.get('k549')).toMatchObject({ kind: 't1' });
    expect(db.search('ft', 'hello').length).toBe(50);
    await db.close();
  });

  test('legacy database (generations disabled) gets a background first generation on open', async () => {
    const dir = await openTmp('legacy-first');
    let db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', indexGenerations: false });
    await seedIndexedDb(db, 800);
    await db.close();
    expect(fsSync.existsSync(path.join(dir, 'CURRENT'))).toBe(false);

    // First open with generations enabled: legacy recovery serves it, then a
    // background build publishes the first generation.
    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    expect(db.stats.generationLoads).toBe(0);
    assertSeededDb(db, 800);
    await waitFor(() => fsSync.existsSync(path.join(dir, 'CURRENT')), 'background first generation');
    await waitFor(() => db.stats.generationBuilds >= 1, 'generationBuilds stat');
    await db.close();

    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    expect(db.stats.generationLoads).toBe(1);
    expect(db.stats.indexRebuildDecoded).toBe(0);
    assertSeededDb(db, 800);
    await db.close();
  });

  test('compaction publishes the generation transactionally (no sync postings tail)', async () => {
    const dir = await openTmp('compact-publish');
    let db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', compactThresholdBytes: 1 << 30 });
    await seedIndexedDb(db, 1000);
    await db.close();
    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    const before = db.getIndexGeneration();
    await db.compact();
    const after = db.getIndexGeneration();
    expect(after).not.toBeNull();
    expect(after!.id).not.toBe(before?.id);
    // The live text base moved into the generation: legacy root postings files
    // are reclaimed.
    expect(fsSync.readdirSync(dir).filter((f) => /^db\.text-.*\.postings$/.test(f))).toEqual([]);
    assertSeededDb(db, 1000);
    await db.close();
    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    expect(db.stats.generationLoads).toBe(1);
    expect(db.getIndexGeneration()?.id).toBe(after!.id);
    assertSeededDb(db, 1000);
    await db.close();
  });

  test('retention keeps the current and previous generation only', async () => {
    const dir = await openTmp('retention');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedIndexedDb(db, 100);
    await db.rebuildGeneration();
    await db.rebuildGeneration();
    await db.rebuildGeneration();
    const current = db.getIndexGeneration()!.id;
    await waitFor(() => {
      try {
        return fsSync.readdirSync(path.join(dir, 'generations')).filter((g) => !g.includes('.tmp-')).length <= 2;
      } catch {
        return false;
      }
    }, 'retention sweep');
    const left = (await listGenerations(dir)).filter((g) => !g.tmp).map((g) => g.id);
    expect(left).toContain(current);
    expect(left.length).toBeLessThanOrEqual(2);
    await db.close();
  });

  test('TTL records sealed into a generation expire correctly at load (indexes reconciled)', async () => {
    const dir = await openTmp('ttl');
    let db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await db.createIndex('byKind', { field: 'kind' });
    await db.createTextIndex('ft', { fields: ['text'] });
    await db.set('stay', { kind: 'a', text: 'permanent hello' });
    await db.set('gone', { kind: 'a', text: 'ephemeral hello' }, { ttl: 50 });
    await db.rebuildGeneration();
    await new Promise((r) => setTimeout(r, 120));
    await db.close();
    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    expect(db.stats.generationLoads).toBe(1);
    expect(db.get('gone')).toBeUndefined();
    expect(db.get('stay')).toBeDefined();
    expect(db.findEq('byKind', 'a').map((r) => r.key)).toEqual(['stay']);
    expect(db.search('ft', 'hello').map((h) => h.key)).toEqual(['stay']);
    await db.close();
  });

  test('a definition change rebuilds only the affected index', async () => {
    const dir = await openTmp('def-change');
    let db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedIndexedDb(db, 1000);
    await db.rebuildGeneration();
    await db.dropIndex('byScore');
    await db.createIndex('byScore', { field: 'score', type: 'range' }); // same shape, but drop+create rewrote the sidecar
    await db.createIndex('byNew', { field: 'kind' });
    await db.close();

    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    expect(db.stats.generationLoads).toBe(1);
    // byNew has no image (created after the build) — exactly one index rebuilt.
    expect(db.stats.generationIndexRebuilds).toBe(1);
    expect(db.findEq('byNew', 't3').length).toBe([...Array(1000)].filter((_, i) => i % 7 === 3).length);
    expect(db.findRange('byScore', { min: 42, max: 42 }).length).toBe(10);
    // Text + dt + compound came from the generation (no corpus re-decode for them).
    expect(db.search('ft', '持久化').length).toBeGreaterThan(0);
    await db.close();
  });

  test('clean text index: background build then a second build re-links (no ENOENT)', async () => {
    // Regression: the clean fast path hard-links the live base into the new
    // generation, and the reclaim step deletes the root file — the publish
    // must repoint the live handle into the CURRENT generation or the next
    // build's link source is gone.
    const dir = await openTmp('clean-relink');
    let db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', indexGenerations: false });
    await db.createTextIndex('ft', { fields: ['text'] });
    for (let i = 0; i < 200; i++) await db.set(`k${i}`, { text: `hello world doc ${i}` });
    await db.close();

    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await waitFor(() => db.stats.generationBuilds >= 1, 'background first generation');
    expect(db.search('ft', 'hello', { limit: 1000 }).length).toBe(200);
    await db.rebuildGeneration(); // must not throw ENOENT
    expect(db.stats.generationBuildErrors).toBe(0);
    expect(db.search('ft', 'hello', { limit: 1000 }).length).toBe(200);
    const gen = db.getIndexGeneration()!.id;
    await db.close();

    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    expect(db.getIndexGeneration()?.id).toBe(gen);
    expect(db.search('ft', 'hello', { limit: 1000 }).length).toBe(200);
    await db.close();
  });

  test('clean text index loaded from a generation survives consecutive builds', async () => {
    const dir = await openTmp('clean-relink-2');
    let db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await db.createTextIndex('ft', { fields: ['text'] });
    for (let i = 0; i < 100; i++) await db.set(`k${i}`, { text: `hello doc ${i}` });
    await db.rebuildGeneration(); // g1 (dirty -> staged)
    await db.close();

    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    expect(db.stats.generationLoads).toBe(1);
    for (let round = 0; round < 3; round++) {
      await db.rebuildGeneration(); // clean re-publish each time
      // Let the async retention cleanup settle between rounds.
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(db.stats.generationBuildErrors).toBe(0);
    expect(db.search('ft', 'hello').length).toBe(50);
    await db.close();
  });

  test('read-only reader keeps serving through a writer generation switch', async () => {
    const dir = await openTmp('reader-switch');
    let writer = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedIndexedDb(writer, 500);
    await writer.rebuildGeneration();

    const reader = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', readOnly: true });
    expect(reader.stats.generationLoads).toBe(1);
    assertSeededDb(reader, 500);

    // The writer publishes a new generation while the reader holds the old one.
    for (let i = 500; i < 600; i++) {
      await writer.set(`k${i}`, { kind: 't2', score: 3, ts: 1700000000000 + i, text: `second wave ${i}` }, { dt: { ts: 1700000000000 + i } });
    }
    await writer.rebuildGeneration();
    // The reader's open handles keep its generation servable: queries keep
    // answering the (consistent) old view without any full-rebuild stall.
    assertSeededDb(reader, 500);
    expect(reader.get('k250')).toMatchObject({ score: 50 });
    await reader.close();

    const reader2 = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', readOnly: true });
    expect(reader2.stats.generationLoads).toBe(1);
    expect(reader2.size).toBe(600);
    expect(reader2.get('k550')).toMatchObject({ kind: 't2' });
    await closeAll(reader2, writer);
  });
});

// ---- fault matrix ------------------------------------------------------------

describe('generation fault matrix', () => {
  test('unknown manifest format version falls back without deleting anything', async () => {
    const dir = await openTmp('unknown-version');
    let db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedIndexedDb(db, 300);
    await db.rebuildGeneration();
    await db.close();
    // Simulate a newer binary's generations: bump the format version of EVERY
    // published manifest, so no candidate can load.
    const manifestPaths: string[] = [];
    for (const g of await listGenerations(dir)) {
      if (g.tmp) continue;
      const p = path.join(dir, 'generations', g.id, 'manifest.json');
      const manifest = JSON.parse(await fs.readFile(p, 'utf8')) as { format: number };
      manifest.format = 99;
      await fs.writeFile(p, JSON.stringify(manifest), 'utf8');
      manifestPaths.push(p);
    }
    expect(manifestPaths.length).toBeGreaterThanOrEqual(1);

    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    expect(db.stats.generationLoads).toBe(0);
    expect(db.stats.generationLoadFallbacks).toBeGreaterThanOrEqual(1);
    expect(db.stats.lastGenerationFallback).toContain('unknown format version');
    assertSeededDb(db, 300); // legacy full recovery served it
    // The foreign generations are still on disk, untouched.
    for (const p of manifestPaths) {
      expect(fsSync.existsSync(p)).toBe(true);
      expect(JSON.parse(await fs.readFile(p, 'utf8')).format).toBe(99);
    }
    await db.close();
  });

  test('corrupt store image discards the generation, never the snapshot/WAL', async () => {
    const dir = await openTmp('corrupt-store');
    let db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedIndexedDb(db, 300);
    await db.rebuildGeneration();
    await db.close();
    // Corrupt the store image of EVERY candidate generation, so the load path
    // has nowhere to go but the legacy full recovery.
    for (const g of await listGenerations(dir)) {
      if (g.tmp) continue;
      const p = path.join(dir, 'generations', g.id, 'store');
      const buf = await fs.readFile(p);
      buf[buf.length - 5] = buf[buf.length - 5]! ^ 0xff; // last payload byte before the crc
      await fs.writeFile(p, buf);
    }

    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    expect(db.stats.generationLoads).toBe(0);
    expect(db.stats.generationLoadFallbacks).toBeGreaterThanOrEqual(1);
    assertSeededDb(db, 300);
    // Authoritative data untouched — and even the corrupt generation is only
    // abandoned, never deleted by the load path.
    expect(fsSync.existsSync(path.join(dir, 'db.wal'))).toBe(true);
    for (const g of await listGenerations(dir)) {
      if (!g.tmp) expect(fsSync.existsSync(path.join(dir, 'generations', g.id, 'store'))).toBe(true);
    }
    await db.close();
  });

  test.each(['dt.index', 'secondary.index', 'compound.index', 'text-ft.dictionary', 'text-ft.docs', 'text-ft.postings'])(
    'corrupt %s rebuilds only that index at load',
    async (file) => {
      const dir = await openTmp('corrupt-one');
      let db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
      await seedIndexedDb(db, 400);
      await db.rebuildGeneration();
      const genId = db.getIndexGeneration()!.id;
      await db.close();
      const p = path.join(dir, 'generations', genId, file);
      const buf = await fs.readFile(p);
      buf[Math.floor(buf.length / 2)] = buf[Math.floor(buf.length / 2)]! ^ 0xff;
      await fs.writeFile(p, buf);

      db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
      expect(db.stats.generationLoads).toBe(1);
      expect(db.stats.generationIndexRebuilds).toBeGreaterThanOrEqual(1);
      assertSeededDb(db, 400);
      await db.close();
    },
  );

  test('interrupted store-image write: no publish, CURRENT keeps the previous generation, next build succeeds', async () => {
    const dir = await openTmp('interrupt-write');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedIndexedDb(db, 300);
    await db.rebuildGeneration();
    const first = db.getIndexGeneration()!.id;
    const restore = failFileWrites((p) => p.includes('.tmp-') && p.endsWith('store'), 'writev', new Error('injected write failure'));
    await expect(db.rebuildGeneration()).rejects.toThrow('injected write failure');
    restore();
    expect(db.stats.generationBuildErrors).toBeGreaterThanOrEqual(1);
    // CURRENT never moved off the last complete generation.
    expect((await fs.readFile(path.join(dir, 'CURRENT'), 'utf8')).trim()).toBe(first);
    // The db itself is fully healthy.
    await db.set('after', { kind: 't1', score: 1, ts: 1, text: 'post failure' });
    expect(db.get('after')).toBeDefined();
    await db.rebuildGeneration();
    expect(db.getIndexGeneration()!.id).not.toBe(first);
    await db.close();
    const db2 = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    expect(db2.stats.generationLoads).toBe(1);
    expect((await listGenerations(dir)).filter((g) => g.tmp)).toEqual([]);
    assertSeededDb(db2, 300, 301);
    expect(db2.get('after')).toBeDefined();
    await db2.close();
  });

  test.each(['store', 'dt.index', 'secondary.index', 'compound.index', 'text-ft.dictionary', 'text-ft.docs'])(
    'interrupted %s write keeps the previous generation and all data',
    async (file) => {
      const dir = await openTmp('interrupt-each');
      const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
      await seedIndexedDb(db, 200);
      await db.rebuildGeneration(); // g-1 published
      const first = db.getIndexGeneration()!.id;
      for (let i = 200; i < 260; i++) {
        await db.set(`k${i}`, { kind: 't2', score: 5, ts: 1700000000000 + i, text: `more ${i}` }, { dt: { ts: 1700000000000 + i } });
      }
      const restore = failFileWrites((p) => p.includes('.tmp-') && p.endsWith(file), 'writev', new Error(`injected ${file} failure`));
      await expect(db.rebuildGeneration()).rejects.toThrow(`injected ${file} failure`);
      restore();
      // CURRENT still points at g-1; data is complete either way.
      expect(db.getIndexGeneration()!.id).toBe(first);
      await db.close();
      const db2 = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
      expect(db2.getIndexGeneration()?.id).toBe(first);
      expect(db2.size).toBe(260);
      expect(db2.get('k255')).toMatchObject({ kind: 't2' });
      await db2.close();
    },
  );

  test('file fsync failure aborts the build without touching CURRENT', async () => {
    const dir = await openTmp('fsync-fail');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedIndexedDb(db, 200);
    await db.rebuildGeneration();
    const first = db.getIndexGeneration()!.id;
    const restore = failFileWrites((p) => p.includes('.tmp-') && p.endsWith('store'), 'sync', new Error('injected fsync failure'));
    await expect(db.rebuildGeneration()).rejects.toThrow('injected fsync failure');
    restore();
    expect(db.stats.generationBuildErrors).toBeGreaterThanOrEqual(1);
    expect((await fs.readFile(path.join(dir, 'CURRENT'), 'utf8')).trim()).toBe(first);
    await db.rebuildGeneration();
    expect(db.getIndexGeneration()!.id).not.toBe(first);
    await db.close();
  });

  test('crash before the generation dir rename: CURRENT unchanged, tmp swept at next open', async () => {
    const dir = await openTmp('crash-pre-rename');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedIndexedDb(db, 200);
    await db.rebuildGeneration();
    const first = db.getIndexGeneration()!.id;
    const restore = failRenames((src) => src.includes('.tmp-'), new Error('injected crash before rename'));
    await expect(db.rebuildGeneration()).rejects.toThrow('injected crash before rename');
    restore();
    expect((await fs.readFile(path.join(dir, 'CURRENT'), 'utf8')).trim()).toBe(first);
    await db.close();
    // Next open sweeps the stranded tmp dir and the background build recovers.
    const db2 = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    expect(db2.getIndexGeneration()?.id).toBe(first);
    assertSeededDb(db2, 200);
    await db2.close();
    expect((await listGenerations(dir)).filter((g) => g.tmp)).toEqual([]);
  });

  test('crash after the dir rename but before CURRENT: old CURRENT wins, stray dir cleaned by the next publish', async () => {
    const dir = await openTmp('crash-pre-current');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedIndexedDb(db, 200);
    await db.rebuildGeneration();
    const first = db.getIndexGeneration()!.id;
    const before = (await listGenerations(dir)).filter((g) => !g.tmp).map((g) => g.id);
    const restore = failRenames((src, dst) => src.includes('CURRENT.tmp-') || dst.endsWith('CURRENT'), new Error('injected crash before CURRENT'));
    await expect(db.rebuildGeneration()).rejects.toThrow('injected crash before CURRENT');
    restore();
    // CURRENT still names the previous generation; a complete-but-unreferenced
    // generation dir lingers next to it.
    expect((await fs.readFile(path.join(dir, 'CURRENT'), 'utf8')).trim()).toBe(first);
    const gens = (await listGenerations(dir)).filter((g) => !g.tmp).map((g) => g.id);
    expect(gens.length).toBe(before.length + 1);
    const stray = gens.find((g) => !before.includes(g))!;
    expect(stray).toBeDefined();
    expect((await readManifest(dir, stray)).id).toBe(stray);
    await db.close();
    const db2 = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    expect(db2.getIndexGeneration()?.id).toBe(first);
    assertSeededDb(db2, 200);
    await db2.rebuildGeneration();
    await waitFor(() => {
      try {
        return fsSync.readdirSync(path.join(dir, 'generations')).filter((g) => !g.includes('.tmp-')).length <= 2;
      } catch {
        return false;
      }
    }, 'stray dir cleanup');
    await db2.close();
  });

  test('crash after CURRENT replacement: the new generation loads', async () => {
    const dir = await openTmp('crash-post-current');
    const writer = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedIndexedDb(writer, 200);
    await writer.rebuildGeneration();
    const id = writer.getIndexGeneration()!.id;
    // The writer stays OPEN (its lock held) — as after a crash, the files on
    // disk must already tell the whole story: a read-only peer loads the
    // freshly published generation.
    const peer = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', onLockFail: 'readonly' });
    expect(peer.readOnly).toBe(true);
    expect(peer.getIndexGeneration()?.id).toBe(id);
    expect(peer.stats.generationLoads).toBe(1);
    assertSeededDb(peer, 200);
    await closeAll(peer, writer);
  });

  test('old-generation cleanup failure after publish is harmless', async () => {
    const dir = await openTmp('cleanup-fail');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedIndexedDb(db, 200);
    await db.rebuildGeneration();
    const first = db.getIndexGeneration()!.id;
    const original = fs.rm;
    (fs as unknown as Record<string, unknown>).rm = (p: string, opts?: unknown) =>
      String(p).includes('generations') && String(p).endsWith(first)
        ? Promise.reject(new Error('injected cleanup failure'))
        : original(p, opts as Parameters<typeof fs.rm>[1]);
    cleanups.push(() => {
      (fs as unknown as Record<string, unknown>).rm = original;
    });
    await db.rebuildGeneration();
    const second = db.getIndexGeneration()!.id;
    expect(second).not.toBe(first);
    await db.close();
    const db2 = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    expect(db2.getIndexGeneration()?.id).toBe(second);
    assertSeededDb(db2, 200);
    await db2.close();
  });

  test('WAL rollback during a build aborts it (expected churn, not an error)', async () => {
    const dir = await openTmp('rollback-abort');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedIndexedDb(db, 6000); // big enough that the walk spans several ticks
    const build = db.rebuildGeneration();
    // Wait until the build has actually registered its mutation queue (the
    // walk is underway), then drive a WAL write failure: the group rollback
    // calls restoreGroupKey, which must abort the in-flight build.
    await waitFor(() => (db as unknown as { genBuild: unknown }).genBuild !== null, 'generation build registered');
    const origAppend = db.wal.appendLoc.bind(db.wal);
    (db.wal as unknown as { appendLoc: unknown }).appendLoc = () => ({
      offset: -1,
      batchId: -1,
      done: Promise.reject(Object.assign(new Error('injected WAL failure'), { code: 'WAL_POISONED' })),
    });
    await expect(db.set('boom', { kind: 't1' })).rejects.toThrow();
    (db.wal as unknown as { appendLoc: unknown }).appendLoc = origAppend;
    await build; // aborted builds resolve cleanly
    expect(db.stats.generationBuildAborts).toBeGreaterThanOrEqual(1);
    expect(db.stats.generationBuildErrors).toBe(0);
    // The db is consistent and a fresh build succeeds.
    await db.rebuildGeneration();
    expect(db.getIndexGeneration()).not.toBeNull();
    assertSeededDb(db, 6000);
    await db.close();
  });

  test('backup/restore carries the generation tree and safely falls back on inode change', async () => {
    const dir = await openTmp('backup-src');
    const destDir = path.join(await openTmp('backup-dst'), 'b');
    const backupDir = path.join(await openTmp('backup-dir'), 'bak');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedIndexedDb(db, 300);
    await db.rebuildGeneration();
    await db.backup(backupDir, { compact: false });
    // The backup includes CURRENT and the generations tree.
    expect(fsSync.existsSync(path.join(backupDir, 'CURRENT'))).toBe(true);
    expect(fsSync.existsSync(path.join(backupDir, 'generations'))).toBe(true);
    await db.close();

    // Restore: the copied files sit on NEW inodes, so the generation's WAL
    // anchor cannot validate — the open must fall back (legacy full recovery
    // or a safe re-checkpoint), never serve a mismatched image, never lose
    // data.
    const restored = await MiniDb.restore<Record<string, unknown>>(backupDir, destDir, { valueCodec: 'json' });
    assertSeededDb(restored, 300);
    await restored.close();
    // A reopened writer re-checkpoints in the background.
    const db2 = await MiniDb.open<Record<string, unknown>>({ dir: destDir, valueCodec: 'json' });
    assertSeededDb(db2, 300);
    await waitFor(() => db2.getIndexGeneration() !== null || db2.stats.generationBuilds >= 1, 'post-restore re-checkpoint');
    await db2.close();
  });

  test('writer builds while a read-only reader queries (no interference)', async () => {
    const dir = await openTmp('reader-during-build');
    const writer = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedIndexedDb(writer, 1000);
    const reader = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', readOnly: true });
    assertSeededDb(reader, 1000);
    const build = writer.rebuildGeneration();
    // The reader keeps answering (its view predates the build) while the build
    // walks + publishes.
    expect(reader.get('k500')).toMatchObject({ score: 0 });
    expect(reader.search('ft', 'hello').length).toBe(50);
    await build;
    expect(writer.getIndexGeneration()).not.toBeNull();
    assertSeededDb(reader, 1000);
    await closeAll(reader, writer);
  });

  test('seal flush: a WAL write failing after being imaged aborts the build instead of publishing a resurrectable write', async () => {
    const dir = await openTmp('seal-flush');
    const { WAL } = await import('../src/wal.js');
    // No text indexes: nothing needs a worker build — the case that used to
    // skip the seal's WAL flush entirely. fsyncPolicy 'no' means no
    // background sync timer, so the write's batch is exactly the next writev.
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', fsyncPolicy: 'no' });
    await db.set('stable', { kind: 't0', score: 0, ts: 1, text: 'stable doc' });
    await db.rebuildGeneration();
    const first = db.getIndexGeneration()!.id;

    // Park the write's WAL batch in flight: the op is already applied (so the
    // build images it) while its frame has not landed yet.
    type Fh = { writev: (bufs: readonly Uint8Array[]) => Promise<{ bytesWritten: number }> };
    const wal = (db as unknown as { wal: InstanceType<typeof WAL> }).wal;
    const fh = (wal as unknown as { fh: Fh | null }).fh!;
    const origWritev = fh.writev.bind(fh);
    let fired = false;
    const entered = deferred<void>();
    const proceed = deferred<void>();
    (fh as { writev: unknown }).writev = async (bufs: readonly Uint8Array[]) => {
      if (fired) return origWritev(bufs);
      fired = true;
      entered.resolve();
      await proceed.promise;
      throw new Error('injected wal writev failure');
    };
    cleanups.push(() => {
      (fh as { writev: unknown }).writev = origWritev;
    });
    const flushCalls = vi.spyOn(WAL.prototype, 'flush');
    cleanups.push(() => flushCalls.mockRestore());

    const ghostSet = db.set('ghost', { kind: 't1', score: 1, ts: 2, text: 'ghost doc' });
    await entered.promise; // the batch is in flight; the commit is still pending
    const build = db.rebuildGeneration();
    // The seal's flush chains onto the in-flight batch — the build is now
    // stuck at the seal (pre-fix it flushed only for worker text builds and
    // would publish without settling the frame below the checkpoint).
    await waitFor(() => flushCalls.mock.calls.length > 0, 'seal WAL flush');
    proceed.resolve();

    // The batch's failure poisons the WAL; the seal flush observes the poison
    // and the build aborts instead of publishing the imaged write.
    await expect(build).rejects.toThrow('WAL is poisoned');
    await expect(ghostSet).rejects.toThrow('injected wal writev failure');
    expect(db.get('ghost')).toBeUndefined(); // rolled back from the live store
    expect(db.getIndexGeneration()!.id).toBe(first); // CURRENT never moved
    await db.close().catch(() => {});

    // A reopen cannot resurrect the rejected write from the generation.
    const db2 = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    expect(db2.get('ghost')).toBeUndefined();
    expect(db2.get('stable')).toMatchObject({ kind: 't0' });
    await db2.close();
  });
});

// ---- stage 6: shutdown drain / cancel ------------------------------------------

describe('stage 6: maintenance shutdown semantics', () => {
  test('close() waits for the publish critical section instead of cancelling it', async () => {
    const dir = await openTmp('shutdown-publish');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedIndexedDb(db, 5000); // big enough to take the worker path
    // Park the FIRST rename of the publish sequence (tmp dir -> g-N): at
    // that point the build is inside its publishing critical section.
    const { barrier } = await import('./helpers.js');
    const gate = barrier(fs, 'rename', 1);
    const buildP = db.rebuildGeneration().catch((e) => e);
    await gate.entered; // provably inside publishGeneration's first rename

    let closed = false;
    const closeP = db.close().then(() => {
      closed = true;
    });
    // The shutdown must NOT cancel the publishing task: close stays pending
    // while the rename is parked.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(closed).toBe(false);
    gate.restore();
    gate.release();
    await buildP;
    await closeP;
    expect(closed).toBe(true);
    // The publish completed fully: CURRENT names the new generation.
    expect(fsSync.existsSync(path.join(dir, 'CURRENT'))).toBe(true);

    const db2 = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    expect(db2.stats.generationLoads).toBe(1);
    assertSeededDb(db2, 5000);
    await db2.close();
  }, 60000);

  test('close() safely cancels a queued maintenance task (backpressure + drain)', async () => {
    const dir = await openTmp('shutdown-queued');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedIndexedDb(db, 5000);
    // Occupy the scheduler with a running build, queue another behind it,
    // then close: the queued one is cancelled, the close completes, the data
    // is intact.
    const first = db.rebuildGeneration().catch(() => {});
    const second = db.rebuildGeneration().then(
      () => 'completed',
      (e) => e,
    );
    await db.close();
    await first;
    const outcome = await second;
    // The second build was either cancelled (queue drain) or completed
    // before the close — never left hanging, and never corrupts anything.
    expect(['completed'].includes(outcome as string) || outcome instanceof Error).toBe(true);
    const db2 = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    // The cancelled builds left no generation behind: this reopen took the
    // no-generation fallback path and may have DEFERRED the text base build —
    // wait out the building window (BOTH indexes, the task builds them
    // sequentially) before asserting search results.
    if (db2.textIndexBuilding('ft') || db2.textIndexBuilding('tri')) {
      await waitFor(() => !db2.textIndexBuilding('ft') && !db2.textIndexBuilding('tri'), 'deferred text build');
    }
    assertSeededDb(db2, 5000);
    await db2.close();
  }, 60000);
});

describe('generation availability triggers (wal-growth + close publish)', () => {
  /** Write ~5 MiB of frames (1 KiB values) without any text index — enough
   *  to cross the wal-growth staleness threshold while staying far under the
   *  64 MiB compaction threshold. */
  async function growWalPast(db: MiniDb<Record<string, unknown>>, n = 5200): Promise<void> {
    const pad = 'x'.repeat(1024);
    const BATCH = 200;
    for (let base = 0; base < n; base += BATCH) {
      await db.batch(
        Array.from({ length: Math.min(BATCH, n - base) }, (_, i) => ({
          op: 'set' as const,
          key: `k${base + i}`,
          value: { text: `${pad}${base + i}` },
        })),
      );
    }
  }

  test('wal-growth trigger publishes a generation without any compaction', async () => {
    const dir = await openTmp('gen-wal-growth');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    db.genBuildKickMinIntervalMs = 0; // test knob: no throttle
    // The db started EMPTY, so the open-time generation kick did not fire;
    // nothing re-triggers until the WAL crosses the staleness threshold.
    expect(db.getIndexGeneration()).toBeNull();
    await growWalPast(db);
    await waitFor(() => db.getIndexGeneration() !== null, 'wal-growth generation build');
    expect(db.stats.compactions).toBe(0); // 5 MiB ≪ 64 MiB threshold
    expect(db.stats.generationBuilds).toBeGreaterThanOrEqual(1);
    await db.close();
  }, 60000);

  test('close() publishes a missing/stale generation best-effort', async () => {
    const dir = await openTmp('gen-close-publish');
    let db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    db.genBuildKickMinIntervalMs = 3_600_000; // suppress the runtime trigger
    await growWalPast(db);
    expect(db.getIndexGeneration()).toBeNull();
    await db.close();
    // The close-time publish left a valid generation behind: the next open
    // takes the attach path instead of the full-recovery fallback.
    expect(fsSync.existsSync(path.join(dir, 'CURRENT'))).toBe(true);
    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    expect(db.stats.generationLoads).toBe(1);
    expect(db.size).toBe(5200);
    await db.close();
  }, 60000);

  test('a failed build backs the wal-growth trigger off instead of re-kicking every write', async () => {
    const dir = await openTmp('gen-kick-backoff');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    db.genBuildKickMinIntervalMs = 0;
    db.genBuildKickFailureBackoffMs = 60_000;
    // Make every publish rename fail: the kicked build dies at the publish
    // boundary and is accounted as a build failure.
    const original = fs.rename;
    (fs as unknown as Record<string, unknown>).rename = (src: string, dst: string) =>
      String(src).includes('.tmp-') ? Promise.reject(new Error('injected publish failure')) : original(src, dst);
    cleanups.push(() => {
      (fs as unknown as Record<string, unknown>).rename = original;
    });
    await growWalPast(db);
    await waitFor(() => db.stats.generationBuildErrors >= 1, 'first kicked build to fail');
    (fs as unknown as Record<string, unknown>).rename = original;
    expect(db.getIndexGeneration()).toBeNull();

    // Inside the backoff window further writes must NOT re-kick a build.
    await db.set('after-failure', { text: 'y'.repeat(1024) });
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    const active = db.maintenanceStatus().filter((t) => t.kind === 'generation-build' && (t.state === 'running' || t.state === 'queued'));
    expect(active).toEqual([]);

    // With the backoff lifted the very next write kicks a successful build.
    db.genBuildKickFailureBackoffMs = 0;
    await db.set('after-backoff', { text: 'z'.repeat(1024) });
    await waitFor(() => db.getIndexGeneration() !== null, 'post-backoff generation build');
    await db.close();
  }, 60000);
});
