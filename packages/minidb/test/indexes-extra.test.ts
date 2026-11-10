// Covers the secondary-index paths not exercised by indexes.test.ts: drop,
// error branches, unique range indexes, and findRange options.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb, UniqueViolationError } from '../src/index.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-idx2-'));
}

test('dropIndex removes the index and reports status', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byCity', { field: 'city' });
    assert.equal(db.listIndexes().length, 1);
    assert.equal(await db.dropIndex('byCity'), true);
    assert.equal(db.listIndexes().length, 0);
    // Dropping a missing index returns false.
    assert.equal(await db.dropIndex('byCity'), false);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createIndex validates field and duplicate names', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await assert.rejects(() => db.createIndex('bad', {} as never), /requires a field/);
    await db.createIndex('byCity', { field: 'city' });
    await assert.rejects(() => db.createIndex('byCity', { field: 'city' }), /already exists/);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('findEq / findRange reject the wrong index type', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('eq', { field: 'n' });
    await db.createIndex('rg', { field: 'n', type: 'range' });
    await db.set('a', { n: 1 });
    assert.throws(() => db.findEq('rg', 1), /not an equality index/);
    assert.throws(() => db.findRange('eq', {}), /not a range index/);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('findRange supports exclusive bounds, offset and reverse', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byAge', { field: 'age', type: 'range' });
    for (let i = 1; i <= 5; i++) await db.set(`p${i}`, { age: i * 10 });

    // Exclusive on both ends: (20, 50) => 30, 40.
    assert.deepEqual(
      db.findRange('byAge', { min: 20, max: 50, minExclusive: true, maxExclusive: true }).map((r) => r.field),
      [30, 40],
    );
    // Offset skips the first matches.
    assert.deepEqual(db.findRange('byAge', { offset: 1, count: 2 }).map((r) => r.field), [20, 30]);
    // Reverse ordering.
    assert.deepEqual(db.findRange('byAge', { reverse: true, count: 2 }).map((r) => r.field), [50, 40]);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('unique range index rejects duplicate numeric values', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byScore', { field: 'score', type: 'range', unique: true });
    await db.set('a', { score: 10 });
    await assert.rejects(() => db.set('b', { score: 10 }), UniqueViolationError);
    // Re-setting the same key with the same value is still allowed.
    await db.set('a', { score: 10 });
    assert.equal(db.size, 1);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('sparse index skips records missing the field', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byCity', { field: 'city' }); // sparse by default
    await db.set('a', { city: 'Paris' });
    await db.set('b', { name: 'no-city' });
    assert.deepEqual(db.findEq('byCity', 'Paris').map((r) => r.key), ['a']);
    assert.equal(db.size, 2);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('secondary indexes require the json codec', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'string' });
    await assert.rejects(() => db.createIndex('x', { field: 'n' }), /require valueCodec: "json"/);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('unique range index: batch swap, del+reuse, and conflict', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byScore', { field: 'score', type: 'range', unique: true });
    await db.set('a', { score: 1 });
    await db.set('b', { score: 2 });

    // Swapping two values inside one batch is a valid final state.
    await db.batch([
      { op: 'set', key: 'a', value: { score: 2 } },
      { op: 'set', key: 'b', value: { score: 1 } },
    ]);
    assert.equal(db.get('a')?.score, 2);
    assert.equal(db.get('b')?.score, 1);

    // Claiming an untouched owner's value is still rejected, batch-atomically.
    await assert.rejects(db.batch([{ op: 'set', key: 'c', value: { score: 2 } }]), UniqueViolationError);
    assert.equal(db.get('c'), undefined, 'nothing committed on failure');

    // Deleting the holder and reusing its value in the same batch is valid.
    await db.batch([
      { op: 'del', key: 'a' },
      { op: 'set', key: 'c', value: { score: 2 } },
    ]);
    assert.equal(db.get('a'), undefined);
    assert.equal(db.get('c')?.score, 2);

    // Two batch keys claiming the same fresh value is an intra-batch conflict.
    await assert.rejects(
      db.batch([
        { op: 'set', key: 'd', value: { score: 9 } },
        { op: 'set', key: 'e', value: { score: 9 } },
      ]),
      UniqueViolationError,
    );
    assert.equal(db.get('d'), undefined);
    assert.equal(db.get('e'), undefined);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- plan 10: sidecar mutation serialization + staged → persist → publish --

/** White-box handle on a private persist*Definitions method, so a test can
 *  inject a sidecar-write failure at the exact transaction point. Returns a
 *  restore function. */
function stubPersist(
  db: MiniDb,
  key: 'persistIndexDefinitions' | 'persistCompoundIndexDefinitions' | 'persistTextIndexDefinitions',
  impl: (defs: { name: string }[]) => Promise<void>,
): () => void {
  const priv = db as unknown as Record<typeof key, (defs: { name: string }[]) => Promise<void>>;
  const saved = priv[key];
  priv[key] = impl;
  return () => {
    priv[key] = saved;
  };
}

/** Sidecar definition names, or [] when the file does not exist yet. */
async function sidecarNames(dir: string, file: string): Promise<string[]> {
  try {
    return (JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')) as { name: string }[]).map((d) => d.name).toSorted();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

test('100 concurrent createIndex pairs: zero failures; memory == sidecar == reopen', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    // The review #7 repro (100/100 failures before the fix): two concurrent
    // creates shared one fixed .tmp and one renamed the other's tmp away,
    // leaving the rejected index in the memory registry only.
    for (let i = 0; i < 100; i++) {
      const results = await Promise.allSettled([db.createIndex(`a${i}`, { field: 'a' }), db.createIndex(`b${i}`, { field: 'b' })]);
      assert.deepEqual(
        results.map((r) => (r.status === 'rejected' ? String(r.reason) : r.status)),
        ['fulfilled', 'fulfilled'],
        `round ${i}`,
      );
    }
    const memory = db.listIndexes().map((x) => x.name).toSorted();
    assert.equal(memory.length, 200);
    assert.deepEqual(await sidecarNames(dir, 'db.indexes.json'), memory);
    await db.close();
    db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    assert.deepEqual(db.listIndexes().map((x) => x.name).toSorted(), memory);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createIndex persist failure: no phantom in memory or sidecar, original error rethrown, retry succeeds', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.createIndex('keep', { field: 'keep' });
    await db.set('k1', { keep: 1, a: 1 });
    const boom = new Error('injected sidecar write failure');
    const restore = stubPersist(db, 'persistIndexDefinitions', async () => {
      throw boom;
    });
    await assert.rejects(db.createIndex('byA', { field: 'a' }), (e) => e === boom);
    restore();
    // The live registry carries no phantom and the old index keeps serving.
    assert.deepEqual(db.listIndexes().map((x) => x.name), ['keep']);
    assert.throws(() => db.findEq('byA', 1), /no such index/);
    assert.deepEqual(db.findEq('keep', 1).map((r) => r.key), ['k1']);
    // The sidecar never gained the definition.
    assert.deepEqual(await sidecarNames(dir, 'db.indexes.json'), ['keep']);
    // Retrying the same create succeeds — no phantom "already exists".
    await db.createIndex('byA', { field: 'a' });
    assert.deepEqual(db.findEq('byA', 1).map((r) => r.key), ['k1']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('dropIndex persist failure: the live index stays usable and the sidecar is unchanged', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.createIndex('byA', { field: 'a' });
    await db.set('k1', { a: 1 });
    const before = await fs.readFile(path.join(dir, 'db.indexes.json'), 'utf8');
    const boom = new Error('injected sidecar write failure');
    const restore = stubPersist(db, 'persistIndexDefinitions', async () => {
      throw boom;
    });
    await assert.rejects(db.dropIndex('byA'), (e) => e === boom);
    restore();
    // The index is still live and answering queries.
    assert.deepEqual(db.findEq('byA', 1).map((r) => r.key), ['k1']);
    // The sidecar is byte-identical (no torn rewrite).
    assert.equal(await fs.readFile(path.join(dir, 'db.indexes.json'), 'utf8'), before);
    // A later successful drop persists fine.
    assert.equal(await db.dropIndex('byA'), true);
    assert.deepEqual(db.listIndexes(), []);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createIndex rebuild failure: no phantom, existing indexes keep serving, unique rollback unchanged', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.createIndex('keep', { field: 'keep' });
    await db.set('k1', { keep: 1, a: 1 });
    const boom = new Error('injected rebuild failure');
    const saved = db.indexes.rebuildStaged;
    db.indexes.rebuildStaged = () => {
      throw boom;
    };
    await assert.rejects(db.createIndex('byA', { field: 'a' }), (e) => e === boom);
    db.indexes.rebuildStaged = saved;
    // No phantom in the registry; the pre-existing index is untouched.
    assert.deepEqual(db.listIndexes().map((x) => x.name), ['keep']);
    assert.deepEqual(db.findEq('keep', 1).map((r) => r.key), ['k1']);
    // The sidecar was never rewritten.
    assert.deepEqual(await sidecarNames(dir, 'db.indexes.json'), ['keep']);
    // Unique-violation rollback keeps its semantics: the rejected create
    // leaves nothing behind either.
    await db.set('k2', { keep: 2, u: 'dup' });
    await db.set('k3', { keep: 3, u: 'dup' });
    await assert.rejects(db.createIndex('byU', { field: 'u', unique: true }), /unique/i);
    assert.deepEqual(db.listIndexes().map((x) => x.name), ['keep']);
    assert.deepEqual(await sidecarNames(dir, 'db.indexes.json'), ['keep']);
    // And the staged path still recovers: a valid create lands fine.
    await db.createIndex('byA', { field: 'a' });
    assert.deepEqual(db.findEq('byA', 1).map((r) => r.key), ['k1']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('mixed create/drop across the three sidecar types: every op lands serialized; memory == sidecars == reopen', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.createIndex('secOld', { field: 'old' });
    await db.createCompoundIndex('cmpOld', { groupBy: 'ws', orderBy: 'updatedAt' });
    await db.createTextIndex('txtOld', { fields: ['text'] });
    await db.set('d1', { old: 1, a: 1, b: 2, ws: 'W', text: 'hello world' }, { dt: { updatedAt: 100, createdAt: 50 } });

    const ops: (() => Promise<unknown>)[] = [
      () => db.createIndex('secA', { field: 'a' }),
      () => db.createIndex('secB', { field: 'b' }),
      () => db.dropIndex('secOld'),
      () => db.createCompoundIndex('cmpA', { groupBy: 'ws', orderBy: 'createdAt' }),
      () => db.dropCompoundIndex('cmpOld'),
      () => db.createTextIndex('txtA', { fields: ['text'] }),
      () => db.dropTextIndex('txtOld'),
    ];
    const results = await Promise.allSettled(ops.map((op) => op()));
    assert.deepEqual(
      results.map((r) => (r.status === 'rejected' ? String(r.reason) : r.status)),
      ops.map(() => 'fulfilled'),
    );

    const expectSec = ['secA', 'secB'];
    const expectCmp = ['cmpA'];
    const expectTxt = ['txtA'];
    assert.deepEqual(db.listIndexes().map((x) => x.name).toSorted(), expectSec);
    assert.deepEqual(db.listCompoundIndexes().map((x) => x.name).toSorted(), expectCmp);
    assert.deepEqual(db.search('txtA', 'hello').map((r) => r.key), ['d1']);
    assert.throws(() => db.search('txtOld', 'hello'), /no such text index/);
    // The staged rebuild also caught the pre-existing document.
    assert.deepEqual(db.findEq('secA', 1).map((r) => r.key), ['d1']);
    assert.deepEqual(db.compoundRange('cmpA', 'W').map((r) => r.key), ['d1']);

    assert.deepEqual(await sidecarNames(dir, 'db.indexes.json'), expectSec);
    assert.deepEqual(await sidecarNames(dir, 'db.compound-indexes.json'), expectCmp);
    assert.deepEqual(await sidecarNames(dir, 'db.textindexes.json'), expectTxt);

    await db.close();
    db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    assert.deepEqual(db.listIndexes().map((x) => x.name).toSorted(), expectSec);
    assert.deepEqual(db.listCompoundIndexes().map((x) => x.name).toSorted(), expectCmp);
    assert.deepEqual(db.search('txtA', 'hello').map((r) => r.key), ['d1']);
    assert.throws(() => db.search('txtOld', 'hello'), /no such text index/);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('set/batch/del do not share the sidecar mutation chain (writes flow while a create is parked)', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inPersist = new Promise<void>((r) => (entered = r));
    const restore = stubPersist(db, 'persistIndexDefinitions', async () => {
      entered();
      await gate;
    });
    const create = db.createIndex('byA', { field: 'a' });
    // The create now holds the secondary chain inside its persist.
    await inPersist;
    // Writes must flow regardless — the data path never touches that chain.
    for (let i = 0; i < 50; i++) await db.set(`k${i}`, { a: i });
    await db.batch([
      { op: 'set', key: 'b1', value: { a: 100 } },
      { op: 'del', key: 'k0' },
    ]);
    assert.equal(db.size, 50);
    release();
    await create;
    restore();
    // The create completed, published, and (thanks to the staged index being
    // fed by the write path during its persist window) reflects every write
    // that landed while it was parked.
    assert.deepEqual(db.listIndexes().map((x) => x.name), ['byA']);
    assert.deepEqual(db.findEq('byA', 100).map((r) => r.key), ['b1']);
    assert.equal(db.findEq('byA', 0).length, 0, 'k0 was deleted before publish');
    assert.deepEqual(db.findEq('byA', 49).map((r) => r.key), ['k49']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('open cleans up unique-suffixed sidecar tmp leftovers (but never a lock tmp)', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.close();
  // A crash between writeFileAtomic's tmp write and its rename orphans this.
  const orphan = path.join(dir, 'db.indexes.json.tmp-99999-1');
  await fs.writeFile(orphan, 'partial{');
  // A LockFile tmp is another component's in-flight file: never matched.
  const lockTmp = path.join(dir, 'db.lock.tmp-99999-1');
  await fs.writeFile(lockTmp, 'lock');
  const db2 = await MiniDb.open({ dir, valueCodec: 'json' });
  await assert.rejects(fs.stat(orphan), /ENOENT/);
  await fs.stat(lockTmp); // untouched
  await db2.close();
  await fs.rm(dir, { recursive: true, force: true });
});


test('a staged unique index constrains writes during its persist window', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.set('k1', { u: 'taken' });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inPersist = new Promise<void>((r) => (entered = r));
    const restore = stubPersist(db, 'persistIndexDefinitions', async () => {
      entered();
      await gate;
    });
    const create = db.createIndex('byU', { field: 'u', unique: true });
    // The create is parked inside its persist; the staged unique index is
    // fully built and must already be enforced, or a write in this window
    // could break the constraint the publish is about to enforce.
    await inPersist;
    await assert.rejects(db.set('k2', { u: 'taken' }), UniqueViolationError);
    await assert.rejects(db.batch([{ op: 'set', key: 'k4', value: { u: 'taken' } }]), UniqueViolationError);
    // A conforming write lands and is reflected by the index once published.
    await db.set('k3', { u: 'free' });
    release();
    await create;
    restore();
    assert.deepEqual(db.findEq('byU', 'free').map((r) => r.key), ['k3']);
    // The rejected writes can proceed with non-conflicting values.
    await db.set('k2', { u: 'taken2' });
    assert.deepEqual(db.findEq('byU', 'taken2').map((r) => r.key), ['k2']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- stage 11: canonical value — one representation for every view --------

test('toJSON/getter/Proxy docs: get, secondary/compound/text indexes and unique checks all see the persisted view (and reopen agrees)', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    await db.createIndex('byV', { field: 'v' });
    await db.createIndex('byW', { field: 'w' });
    await db.createIndex('byU', { field: 'u', unique: true });
    await db.createCompoundIndex('byG', { groupBy: 'g', orderBy: 'o' });
    await db.createTextIndex('ft', { fields: ['t'] });

    // A getter whose value CHANGES per read: encode sees 'v-1'; before stage
    // 11 the secondary index re-read the getter and indexed 'v-2' — the live
    // index and the store (and every reopen) disagreed.
    let reads = 0;
    const getterDoc: Record<string, unknown> = { u: 'u1', g: 'G', o: 5, t: 'alpha bravo' };
    Object.defineProperty(getterDoc, 'v', {
      enumerable: true,
      get: () => `v-${++reads}`,
    });
    await db.set('k1', getterDoc);
    assert.equal(reads, 1, 'the getter is consumed exactly once (at encode)');

    // toJSON replaces the persisted shape entirely.
    const toJsonDoc = { u: 'u2', w: 'raw-w', t: 'hidden', toJSON: () => ({ u: 'u2', w: 'json-w' }) };
    await db.set('k2', toJsonDoc as unknown as Record<string, unknown>);

    // A Proxy is transparently persisted as the plain object it wraps.
    const proxyDoc = new Proxy({ u: 'u3', w: 'pw', t: 'proxied term' }, {});
    await db.set('k3', proxyDoc);

    const assertViews = (label: string, db: MiniDb) => {
      // get(): the decoded stored bytes.
      assert.equal((db.get('k1') as { v: string }).v, 'v-1', `${label}: get returns the persisted getter value`);
      assert.deepEqual(db.get('k2'), { u: 'u2', w: 'json-w' }, `${label}: get returns the toJSON shape`);
      assert.deepEqual(db.get('k3'), { u: 'u3', w: 'pw', t: 'proxied term' }, `${label}: get returns the Proxy target shape`);
      // Secondary indexes: the persisted values, never a second getter read.
      assert.deepEqual(db.findEq('byV', 'v-1').map((r) => r.key), ['k1'], `${label}: index has the persisted value`);
      assert.deepEqual(db.findEq('byV', 'v-2'), [], `${label}: the never-persisted second getter read is NOT indexed`);
      assert.deepEqual(db.findEq('byW', 'json-w').map((r) => r.key), ['k2']);
      assert.deepEqual(db.findEq('byW', 'raw-w'), [], `${label}: the raw (unpersisted) toJSON field is NOT indexed`);
      assert.deepEqual(db.findEq('byW', 'pw').map((r) => r.key), ['k3']);
      // Compound index.
      assert.deepEqual(db.compoundRange('byG', 'G').map((r) => r.key), ['k1'], `${label}: compound index view`);
      // Text index: toJSON dropped 't' from k2, so only k1/k3 have text.
      assert.deepEqual(db.search('ft', 'alpha').map((r) => r.key), ['k1'], `${label}: text index view`);
      assert.deepEqual(db.search('ft', 'hidden'), [], `${label}: text the toJSON hid is NOT indexed`);
      assert.deepEqual(db.search('ft', 'proxied').map((r) => r.key), ['k3']);
    };
    assertViews('live', db);

    // Unique checks consume the canonical view too: a conflicting plain doc
    // is rejected against the value the getter/toJSON/Proxy actually stored.
    await assert.rejects(db.set('k4', { u: 'u1' }), UniqueViolationError);
    await assert.rejects(db.batch([{ op: 'set', key: 'k5', value: { u: 'u3' } }]), UniqueViolationError);
    // And re-setting k1 (holder = same key) stays legal despite the getter.
    await db.set('k1', getterDoc);
    assert.equal((db.get('k1') as { v: string }).v, 'v-2', 're-set re-encodes (one more getter read)');

    await db.close();
    db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    // The reopened index views are rebuilt from the persisted bytes — they
    // must be identical to the live views (v-2 now, after the re-set).
    assert.deepEqual(db.findEq('byV', 'v-2').map((r) => r.key), ['k1'], 'reopen: same persisted view');
    assert.equal((db.get('k1') as { v: string }).v, 'v-2');
    assert.deepEqual(db.get('k2'), { u: 'u2', w: 'json-w' });
    assert.deepEqual(db.findEq('byW', 'json-w').map((r) => r.key), ['k2']);
    assert.deepEqual(db.compoundRange('byG', 'G').map((r) => r.key), ['k1']);
    assert.deepEqual(db.search('ft', 'alpha').map((r) => r.key), ['k1']);
    assert.deepEqual(db.search('ft', 'proxied').map((r) => r.key), ['k3']);
    await assert.rejects(db.set('k6', { u: 'u1' }), UniqueViolationError);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
