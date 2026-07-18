// Regression tests for the fourth deep-review round:
//   A) Text AND search must be empty when any query term is absent.
//   B) Query $regex must not be fooled by stateful (global/sticky) RegExp.
//   C) Range index must not duplicate a key for repeated array elements.
//   D) Equality index must match objects regardless of property order.
//   E) Index query methods must exclude expired keys (no ghost entries).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-r4-'));
}

// --- A) Text AND search: every term must be present -------------------------

test('text AND search is empty when a query term is absent', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createTextIndex('bio', { fields: ['bio'] });
  try {
    await db.set('a', { bio: 'hello world' });
    await db.set('b', { bio: 'hello there' });
    // 'zzznope' is in no document, so a true AND must yield nothing.
    assert.deepEqual(db.search('bio', 'hello zzznope', { op: 'AND' }).map((r) => r.key), []);
    assert.deepEqual(db.search('bio', 'zzznope hello', { op: 'AND' }).map((r) => r.key), []);
    // Default operator is AND.
    assert.deepEqual(db.search('bio', 'hello zzznope').map((r) => r.key), []);
    // Sanity: when every term is present the intersection is correct.
    assert.deepEqual(db.search('bio', 'hello world', { op: 'AND' }).map((r) => r.key), ['a']);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- B) Query $regex: stateful RegExp must match every document --------------

test('query $regex with a global RegExp matches every document', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  try {
    for (const k of ['a', 'b', 'c', 'd']) await db.set(k, { name: 'ab' });
    // /a/g advances lastIndex on every .test(); without resetting it would
    // alternate match/miss across documents and return only ~2 of 4.
    assert.equal(db.query({ filter: { name: { $regex: /a/g } } }).length, 4);
    // Same bug via the top-level RegExp shorthand.
    assert.equal(db.query({ filter: { name: /a/g } }).length, 4);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- C) Range index: repeated array elements index once ----------------------

test('range index dedupes repeated array elements', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createIndex('byScore', { field: 'scores', type: 'range' });
  try {
    await db.set('a', { scores: [10, 10, 10] });
    assert.deepEqual(db.findRange('byScore', { min: 10, max: 10 }).map((r) => r.key), ['a']);
    assert.equal(db.findRange('byScore', { min: 0, max: 100 }).length, 1);
    // Updating the array must not leave stale duplicate nodes behind.
    await db.set('a', { scores: [20, 20] });
    assert.deepEqual(db.findRange('byScore', { min: 10, max: 10 }).map((r) => r.key), []);
    assert.deepEqual(db.findRange('byScore', { min: 20, max: 20 }).map((r) => r.key), ['a']);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- D) Equality index: object keys ignore property order --------------------

test('equality index matches objects regardless of key order', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createIndex('byMeta', { field: 'meta' });
  try {
    await db.set('k1', { meta: { a: 1, b: 2 } });
    assert.deepEqual(db.findEq('byMeta', { b: 2, a: 1 }).map((r) => r.key), ['k1']);
    // Nested objects must also be canonicalized.
    await db.set('k2', { meta: { nested: { x: 1, y: 2 } } });
    assert.deepEqual(db.findEq('byMeta', { nested: { y: 2, x: 1 } }).map((r) => r.key), ['k2']);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- E) Index query methods must not return expired (ghost) entries ----------

test('findEq excludes expired keys', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', activeExpireIntervalMs: 0 });
  await db.createIndex('byCity', { field: 'city' });
  try {
    await db.set('g', { city: 'Paris' }, { ttl: 1 });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(db.findEq('byCity', 'Paris'), []);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('findRange excludes expired keys', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', activeExpireIntervalMs: 0 });
  await db.createIndex('byAge', { field: 'age', type: 'range' });
  try {
    await db.set('g', { age: 30 }, { ttl: 1 });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(db.findRange('byAge', { min: 0, max: 100 }), []);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('search excludes expired keys', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', activeExpireIntervalMs: 0 });
  await db.createTextIndex('body', { fields: ['bio'] });
  try {
    await db.set('g', { bio: 'hello world' }, { ttl: 1 });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(db.search('body', 'hello'), []);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('compoundRange excludes expired keys', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', activeExpireIntervalMs: 0 });
  await db.createCompoundIndex('byWs', { groupBy: 'ws', orderBy: 'ts' });
  try {
    await db.set('g', { ws: 'W1' }, { ttl: 1, dt: { ts: 100 } });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(db.compoundRange('byWs', 'W1'), []);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
