// test/indexes.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';
import { UniqueViolationError } from '../src/index-manager.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-idx-'));
}

test('equality index findEq', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byCity', { field: 'city' });
    await db.set('u1', { name: 'Ann', city: 'Paris' });
    await db.set('u2', { name: 'Bob', city: 'Paris' });
    await db.set('u3', { name: 'Eve', city: 'London' });
    const res = db.findEq('byCity', 'Paris').map((r) => r.key).sort();
    assert.deepEqual(res, ['u1', 'u2']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('range index findRange with bounds + limit', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byAge', { field: 'age', type: 'range' });
    for (let i = 1; i <= 10; i++) await db.set(`p${i}`, { age: i * 10 });
    const ages = db.findRange('byAge', { min: 30, max: 70, count: 3 }).map((r) => r.field);
    assert.deepEqual(ages, [30, 40, 50]);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('unique index rejects duplicates', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byEmail', { field: 'email', unique: true });
    await db.set('a', { email: 'x@y.com' });
    await assert.rejects(() => db.set('b', { email: 'x@y.com' }), UniqueViolationError);
    // Re-setting the same key with the same value is allowed.
    await db.set('a', { email: 'x@y.com' });
    assert.equal(db.size, 1);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('index is updated on delete', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byCity', { field: 'city' });
    await db.set('u1', { city: 'Paris' });
    await db.del('u1');
    assert.deepEqual(db.findEq('byCity', 'Paris'), []);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('array field is indexed per element', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byTag', { field: 'tags' });
    await db.set('a', { tags: ['red', 'blue'] });
    await db.set('b', { tags: ['blue', 'green'] });
    assert.deepEqual(db.findEq('byTag', 'red').map((r) => r.key), ['a']);
    assert.deepEqual(db.findEq('byTag', 'blue').map((r) => r.key).sort(), ['a', 'b']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('index definitions + data rebuild across reopen', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byAge', { field: 'age', type: 'range' });
    for (let i = 1; i <= 5; i++) await db.set(`p${i}`, { age: i });
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'json' });
    assert.deepEqual(db.listIndexes().map((i) => i.name), ['byAge']);
    assert.deepEqual(db.findRange('byAge', { min: 2, max: 4 }).map((r) => r.key), [
      'p2',
      'p3',
      'p4',
    ]);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
