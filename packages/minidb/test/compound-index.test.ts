// test/compound-index.test.ts
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-compound-'));
}

test('compound index orders sessions within a workspace by updatedAt', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createCompoundIndex('byWsUpdated', { groupBy: 'workspaceId', orderBy: 'updatedAt' });
  try {
    await db.set('a', { workspaceId: 'W1', title: 'a' }, { dt: { updatedAt: 300 } });
    await db.set('b', { workspaceId: 'W1', title: 'b' }, { dt: { updatedAt: 100 } });
    await db.set('c', { workspaceId: 'W1', title: 'c' }, { dt: { updatedAt: 200 } });
    await db.set('d', { workspaceId: 'W2', title: 'd' }, { dt: { updatedAt: 500 } });

    const asc = db.compoundRange('byWsUpdated', 'W1', { count: 10 });
    assert.deepEqual(asc.map((r) => r.key), ['b', 'c', 'a']);

    const desc = db.compoundRange('byWsUpdated', 'W1', { reverse: true, count: 10 });
    assert.deepEqual(desc.map((r) => r.key), ['a', 'c', 'b']);

    // pagination
    const page = db.compoundRange('byWsUpdated', 'W1', { reverse: true, offset: 1, count: 1 });
    assert.deepEqual(page.map((r) => r.key), ['c']);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('multiple dt columns each get their own compound index', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createCompoundIndex('byWsUpdated', { groupBy: 'workspaceId', orderBy: 'updatedAt' });
  await db.createCompoundIndex('byWsCreated', { groupBy: 'workspaceId', orderBy: 'createdAt' });
  try {
    await db.set('a', { workspaceId: 'W1' }, { dt: { updatedAt: 300, createdAt: 10 } });
    await db.set('b', { workspaceId: 'W1' }, { dt: { updatedAt: 100, createdAt: 30 } });
    await db.set('c', { workspaceId: 'W1' }, { dt: { updatedAt: 200, createdAt: 20 } });

    assert.deepEqual(db.compoundRange('byWsUpdated', 'W1').map((r) => r.key), ['b', 'c', 'a']);
    assert.deepEqual(db.compoundRange('byWsCreated', 'W1').map((r) => r.key), ['a', 'c', 'b']);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('updating the order key moves the entry', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createCompoundIndex('byWsUpdated', { groupBy: 'workspaceId', orderBy: 'updatedAt' });
  try {
    await db.set('a', { workspaceId: 'W1' }, { dt: { updatedAt: 100 } });
    await db.set('b', { workspaceId: 'W1' }, { dt: { updatedAt: 200 } });
    assert.deepEqual(db.compoundRange('byWsUpdated', 'W1').map((r) => r.key), ['a', 'b']);
    // bump 'a' to the top
    await db.set('a', { workspaceId: 'W1' }, { dt: { updatedAt: 999 } });
    assert.deepEqual(db.compoundRange('byWsUpdated', 'W1').map((r) => r.key), ['b', 'a']);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('compound index persists and rebuilds across reopen', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createCompoundIndex('byWsUpdated', { groupBy: 'workspaceId', orderBy: 'updatedAt' });
  await db.set('a', { workspaceId: 'W1' }, { dt: { updatedAt: 200 } });
  await db.set('b', { workspaceId: 'W1' }, { dt: { updatedAt: 100 } });
  await db.close();

  db = await MiniDb.open({ dir, valueCodec: 'json' });
  assert.deepEqual(db.listCompoundIndexes().map((i) => i.name), ['byWsUpdated']);
  assert.deepEqual(db.compoundRange('byWsUpdated', 'W1').map((r) => r.key), ['b', 'a']);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('delete removes from the compound index', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createCompoundIndex('byWsUpdated', { groupBy: 'workspaceId', orderBy: 'updatedAt' });
  await db.set('a', { workspaceId: 'W1' }, { dt: { updatedAt: 100 } });
  await db.set('b', { workspaceId: 'W1' }, { dt: { updatedAt: 200 } });
  await db.del('a');
  assert.deepEqual(db.compoundRange('byWsUpdated', 'W1').map((r) => r.key), ['b']);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});


// ---- plan 10: sidecar mutation serialization + staged → persist → publish --

/** White-box handle on the private persistCompoundIndexDefinitions, to inject
 *  a sidecar-write failure at the exact transaction point. */
function stubCompoundPersist(db: MiniDb, impl: (defs: { name: string }[]) => Promise<void>): () => void {
  const priv = db as unknown as { persistCompoundIndexDefinitions: (defs: { name: string }[]) => Promise<void> };
  const saved = priv.persistCompoundIndexDefinitions;
  priv.persistCompoundIndexDefinitions = impl;
  return () => {
    priv.persistCompoundIndexDefinitions = saved;
  };
}

async function compoundSidecarNames(dir: string): Promise<string[]> {
  try {
    return (JSON.parse(await fs.readFile(path.join(dir, 'db.compound-indexes.json'), 'utf8')) as { name: string }[])
      .map((d) => d.name)
      .sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

test('concurrent createCompoundIndex calls are serialized: zero failures; memory == sidecar == reopen', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.set('a', { workspaceId: 'W1' }, { dt: { updatedAt: 100, createdAt: 10 } });
    const results = await Promise.allSettled([
      db.createCompoundIndex('byWsUpdated', { groupBy: 'workspaceId', orderBy: 'updatedAt' }),
      db.createCompoundIndex('byWsCreated', { groupBy: 'workspaceId', orderBy: 'createdAt' }),
      db.dropCompoundIndex('neverThere'),
    ]);
    assert.deepEqual(
      results.map((r) => (r.status === 'rejected' ? String(r.reason) : r.status)),
      ['fulfilled', 'fulfilled', 'fulfilled'],
    );
    const memory = db.listCompoundIndexes().map((x) => x.name).sort();
    assert.deepEqual(memory, ['byWsCreated', 'byWsUpdated']);
    assert.deepEqual(await compoundSidecarNames(dir), memory);
    // Both staged rebuilds saw the pre-existing document.
    assert.deepEqual(db.compoundRange('byWsUpdated', 'W1').map((r) => r.key), ['a']);
    assert.deepEqual(db.compoundRange('byWsCreated', 'W1').map((r) => r.key), ['a']);
    await db.close();
    db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    assert.deepEqual(db.listCompoundIndexes().map((x) => x.name).sort(), memory);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('createCompoundIndex persist failure: no phantom in memory or sidecar; retry succeeds', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.set('a', { workspaceId: 'W1' }, { dt: { updatedAt: 100 } });
    const boom = new Error('injected sidecar write failure');
    const restore = stubCompoundPersist(db, async () => {
      throw boom;
    });
    await assert.rejects(db.createCompoundIndex('byWsUpdated', { groupBy: 'workspaceId', orderBy: 'updatedAt' }), (e) => e === boom);
    restore();
    assert.deepEqual(db.listCompoundIndexes(), []);
    assert.throws(() => db.compoundRange('byWsUpdated', 'W1'), /no such compound index/);
    assert.deepEqual(await compoundSidecarNames(dir), []);
    await db.createCompoundIndex('byWsUpdated', { groupBy: 'workspaceId', orderBy: 'updatedAt' });
    assert.deepEqual(db.compoundRange('byWsUpdated', 'W1').map((r) => r.key), ['a']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('dropCompoundIndex persist failure: the live index stays usable and the sidecar is unchanged', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.createCompoundIndex('byWsUpdated', { groupBy: 'workspaceId', orderBy: 'updatedAt' });
    await db.set('a', { workspaceId: 'W1' }, { dt: { updatedAt: 100 } });
    const before = await fs.readFile(path.join(dir, 'db.compound-indexes.json'), 'utf8');
    const boom = new Error('injected sidecar write failure');
    const restore = stubCompoundPersist(db, async () => {
      throw boom;
    });
    await assert.rejects(db.dropCompoundIndex('byWsUpdated'), (e) => e === boom);
    restore();
    assert.deepEqual(db.compoundRange('byWsUpdated', 'W1').map((r) => r.key), ['a']);
    assert.equal(await fs.readFile(path.join(dir, 'db.compound-indexes.json'), 'utf8'), before);
    assert.equal(await db.dropCompoundIndex('byWsUpdated'), true);
    assert.deepEqual(db.listCompoundIndexes(), []);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
