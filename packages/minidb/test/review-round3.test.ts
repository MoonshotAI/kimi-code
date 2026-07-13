// Regression tests for the third deep-review round:
//   A) Non-ASCII (multi-byte UTF-8) string keys must work on every surface.
//   B) readOnly open must never mutate the database files (no WAL truncation).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-r3-'));
}

// --- A) Non-ASCII string keys ----------------------------------------------

test('non-ASCII key: set/get/has works (live, no restart)', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    await db.set('é', 'accent');
    await db.set('北京', 'cjk');
    await db.set('key🎉', 'emoji');
    assert.equal(db.get('é'), 'accent');
    assert.equal(db.get('北京'), 'cjk');
    assert.equal(db.get('key🎉'), 'emoji');
    assert.equal(db.has('é'), true);
    assert.equal(db.has('missing-é'), false);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('non-ASCII key: del removes it and reports existence', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    await db.set('café', 'x');
    assert.equal(await db.del('café'), true, 'del must report the key existed');
    assert.equal(db.get('café'), undefined);
    assert.equal(db.has('café'), false);
    assert.equal(await db.del('café'), false, 'second del reports missing');
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('non-ASCII key survives close + reopen (WAL recovery)', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'string' });
  await db.set('北京', 'v1');
  await db.set('上海', 'v2');
  await db.close();

  db = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    assert.equal(db.get('北京'), 'v1');
    assert.equal(db.get('上海'), 'v2');
    assert.equal(db.has('北京'), true);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('non-ASCII key survives compaction (snapshot recovery)', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({
    dir,
    valueCodec: 'string',
    compactThresholdBytes: 1,
    autoCompact: false,
  });
  await db.set('城市', 'Beijing');
  await db.set('要删除', 'gone');
  await db.del('要删除');
  await db.compact();
  await db.close();

  db = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    assert.equal(db.get('城市'), 'Beijing');
    assert.equal(db.get('要删除'), undefined, 'tombstone must survive compaction');
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('non-ASCII key: scan returns the original key and value', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    await db.set('b-ascii', '1');
    await db.set('a-é', '2');
    await db.set('c-北京', '3');
    const keys = db.scan().map((r) => r.key);
    assert.ok(keys.includes('a-é'), 'scan must include the accented key');
    assert.ok(keys.includes('c-北京'), 'scan must include the CJK key');
    assert.equal(db.get('a-é'), '2');
    assert.equal(db.get('c-北京'), '3');
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('non-ASCII key: prefix scan matches', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    await db.set('用户:1', 'a');
    await db.set('用户:2', 'b');
    await db.set('other:1', 'c');
    const keys = db.prefix('用户:').map((r) => r.key).sort();
    assert.deepEqual(keys, ['用户:1', '用户:2']);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('non-ASCII key: secondary equality index returns key and value', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createIndex('byCity', { field: 'city' });
  try {
    await db.set('用户1', { city: 'Paris', n: 1 });
    await db.set('用户2', { city: 'Paris', n: 2 });
    const r = db.findEq('byCity', 'Paris').sort((a, b) => (a.key < b.key ? -1 : 1));
    assert.deepEqual(r.map((x) => x.key), ['用户1', '用户2']);
    assert.deepEqual(r.map((x) => (x.value as { n: number }).n), [1, 2]);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('non-ASCII key: secondary index is consistent after recovery', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createIndex('byCity', { field: 'city' });
  await db.set('用户1', { city: 'Paris' });
  await db.close();

  db = await MiniDb.open({ dir, valueCodec: 'json' });
  try {
    const r = db.findEq('byCity', 'Paris');
    assert.equal(r.length, 1);
    assert.equal(r[0]!.key, '用户1');
    assert.deepEqual(r[0]!.value, { city: 'Paris' });
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('non-ASCII key: range index, dt index, compound index, text index', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createIndex('byAge', { field: 'age', type: 'range' });
  await db.createCompoundIndex('byWs', { groupBy: 'ws', orderBy: 'created' });
  await db.createTextIndex('body', { fields: ['bio'] });
  try {
    await db.set('用户A', { age: 30, ws: 'W1', bio: 'hello world' }, { dt: { created: 100 } });
    await db.set('用户B', { age: 40, ws: 'W1', bio: 'hello there' }, { dt: { created: 200 } });

    assert.deepEqual(db.findRange('byAge', { min: 25, max: 35 }).map((r) => r.key), ['用户A']);
    assert.deepEqual(db.dtRange('created', { gte: 100, lte: 100 }).map((r) => r.key), ['用户A']);
    assert.deepEqual(db.compoundRange('byWs', 'W1').map((r) => r.key), ['用户A', '用户B']);
    assert.deepEqual(db.search('body', 'world').map((r) => r.key), ['用户A']);
    // values resolve too
    assert.equal(db.findRange('byAge', { min: 25, max: 35 })[0]!.value?.age, 30);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('non-ASCII key: unified query by exact key and by prefix', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  try {
    await db.set('post:北京', { tag: 'a' });
    await db.set('post:上海', { tag: 'b' });
    assert.deepEqual(db.query({ key: 'post:北京' }).map((r) => r.key), ['post:北京']);
    const pref = db.query({ key: { prefix: 'post:' } }).map((r) => r.key).sort();
    assert.deepEqual(pref, ['post:上海', 'post:北京']);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('non-ASCII key: batch set + del survives recovery', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'string' });
  await db.batch([
    { op: 'set', key: '批1', value: 'one' },
    { op: 'set', key: '批2', value: 'two' },
  ]);
  await db.batch([{ op: 'del', key: '批1' }]);
  await db.close();

  db = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    assert.equal(db.get('批1'), undefined);
    assert.equal(db.get('批2'), 'two');
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- B) readOnly must not mutate the database ------------------------------

test('readOnly open does not truncate a torn WAL tail', async () => {
  const dir = await tmpDir();
  const walPath = path.join(dir, 'db.wal');

  // Build a db with one valid record, then append a torn (partial) frame.
  let db = await MiniDb.open({ dir, valueCodec: 'string' });
  await db.set('a', '1');
  await db.close();

  const torn = Buffer.from([0x4d, 0x44, 0x01, 0x00, 0x01, 0x00]); // magic + partial header
  await fs.appendFile(walPath, torn);
  const sizeBefore = (await fs.stat(walPath)).size;

  // Opening read-only must NOT mutate the file, even though the tail is torn.
  db = await MiniDb.open({ dir, valueCodec: 'string', readOnly: true });
  try {
    assert.equal(db.get('a'), '1', 'valid record is still readable');
  } finally {
    await db.close();
  }
  const sizeAfter = (await fs.stat(walPath)).size;
  assert.equal(sizeAfter, sizeBefore, 'readOnly open must not truncate the WAL');
});
