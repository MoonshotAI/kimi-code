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
