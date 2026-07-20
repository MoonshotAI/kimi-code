// Drives the query engine through the real db.query() path to cover the
// operators and path handling that the higher-level tests do not exercise.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-qe-'));
}

async function seed() {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.set('a', { name: 'Ann', age: 30, city: 'Paris', tags: ['x', 'y'], score: 9.5, active: true });
  await db.set('b', { name: 'Bob', age: 17, city: 'London', tags: ['y'], score: 4.2, active: false });
  await db.set('c', { name: 'Eve', age: 25, city: 'Paris', tags: ['z'], score: 7.0 });
  await db.set('d', { name: 'Max', age: 40, city: 'Berlin', tags: [], score: 8.1, active: true });
  return { dir, db };
}

test('comparison operators $eq $ne $gt $gte $lt $lte', async () => {
  const { dir, db } = await seed();
  try {
    assert.deepEqual(db.query({ filter: { age: { $eq: 25 } } }).map((r) => r.key), ['c']);
    assert.deepEqual(db.query({ filter: { age: { $ne: 25 } } }).map((r) => r.key).sort(), ['a', 'b', 'd']);
    assert.deepEqual(db.query({ filter: { age: { $gte: 30 } } }).map((r) => r.key).sort(), ['a', 'd']);
    assert.deepEqual(db.query({ filter: { age: { $lte: 25 } } }).map((r) => r.key).sort(), ['b', 'c']);
    // Combine two operators in one cond object (both must hold).
    assert.deepEqual(
      db.query({ filter: { age: { $gt: 17, $lt: 30 } } }).map((r) => r.key),
      ['c'],
    );
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('$in / $nin membership', async () => {
  const { dir, db } = await seed();
  try {
    assert.deepEqual(db.query({ filter: { city: { $in: ['Paris', 'Berlin'] } } }).map((r) => r.key).sort(), [
      'a',
      'c',
      'd',
    ]);
    assert.deepEqual(db.query({ filter: { city: { $nin: ['Paris'] } } }).map((r) => r.key).sort(), ['b', 'd']);
    // Non-array argument never matches.
    assert.deepEqual(db.query({ filter: { city: { $in: 'Paris' as unknown as string[] } } }).map((r) => r.key), []);
    assert.deepEqual(db.query({ filter: { city: { $nin: 'Paris' as unknown as string[] } } }).map((r) => r.key), []);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('$exists and $type', async () => {
  const { dir, db } = await seed();
  try {
    // 'active' is set on a, b, d but not c.
    assert.deepEqual(db.query({ filter: { active: { $exists: true } } }).map((r) => r.key).sort(), ['a', 'b', 'd']);
    assert.deepEqual(db.query({ filter: { active: { $exists: false } } }).map((r) => r.key), ['c']);
    assert.deepEqual(db.query({ filter: { name: { $type: 'string' } } }).map((r) => r.key).sort(), [
      'a',
      'b',
      'c',
      'd',
    ]);
    assert.deepEqual(db.query({ filter: { age: { $type: 'string' } } }).map((r) => r.key), []);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('$regex with string, [pattern, flags], RegExp and stateful global RegExp', async () => {
  const { dir, db } = await seed();
  try {
    assert.deepEqual(db.query({ filter: { name: { $regex: '^A' } } }).map((r) => r.key), ['a']);
    // Tuple form supplies flags.
    assert.deepEqual(
      db.query({ filter: { name: { $regex: ['^a', 'i'] as unknown as string } } }).map((r) => r.key),
      ['a'],
    );
    // RegExp instance form.
    assert.deepEqual(db.query({ filter: { name: { $regex: /^B/ } } }).map((r) => r.key), ['b']);
    // A global RegExp is stateful; the engine must reset lastIndex so every
    // document is tested from the start.
    const g = /^E/g;
    assert.deepEqual(db.query({ filter: { name: { $regex: g } } }).map((r) => r.key), ['c']);
    // Non-string field never matches a regex.
    assert.deepEqual(db.query({ filter: { age: { $regex: '3' } } }).map((r) => r.key), []);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('scalar RegExp value resets lastIndex between documents', async () => {
  const { dir, db } = await seed();
  try {
    const g = /^A/g;
    assert.deepEqual(db.query({ filter: { name: g } }).map((r) => r.key), ['a']);
    // Non-string value against a scalar RegExp never matches.
    assert.deepEqual(db.query({ filter: { age: /^3/ } }).map((r) => r.key), []);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('logical operators $and $or $nor $not', async () => {
  const { dir, db } = await seed();
  try {
    assert.deepEqual(
      db.query({ filter: { $and: [{ city: 'Paris' }, { age: { $gt: 20 } }] } }).map((r) => r.key).sort(),
      ['a', 'c'],
    );
    assert.deepEqual(
      db.query({ filter: { $or: [{ name: 'Ann' }, { name: 'Bob' }] } }).map((r) => r.key).sort(),
      ['a', 'b'],
    );
    // $nor: matches documents that satisfy NONE of the branches.
    assert.deepEqual(
      db.query({ filter: { $nor: [{ city: 'Paris' }, { city: 'London' }] } }).map((r) => r.key),
      ['d'],
    );
    assert.deepEqual(db.query({ filter: { $not: { city: 'Paris' } } }).map((r) => r.key).sort(), ['b', 'd']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('unknown operator and non-array logical args never match', async () => {
  const { dir, db } = await seed();
  try {
    // Unknown operator falls through to the default case (no match).
    assert.deepEqual(db.query({ filter: { age: { $bogus: 1 } as never } }).map((r) => r.key), []);
    // $and/$or/$nor with a non-array argument are treated as non-matching.
    assert.deepEqual(db.query({ filter: { $and: { city: 'Paris' } as never } }).map((r) => r.key), []);
    assert.deepEqual(db.query({ filter: { $or: { city: 'Paris' } as never } }).map((r) => r.key), []);
    assert.deepEqual(db.query({ filter: { $nor: { city: 'Paris' } as never } }).map((r) => r.key), []);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('nested dot + bracket paths in filter and projection', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.set('p1', { user: { name: 'Ann', addr: { zip: '75001' } }, items: [{ sku: 'A' }, { sku: 'B' }] });
    await db.set('p2', { user: { name: 'Bob', addr: { zip: '12345' } }, items: [{ sku: 'A' }] });
    await db.set('p3', { user: { name: 'Eve' }, items: [] });

    assert.deepEqual(db.query({ filter: { 'user.name': 'Bob' } }).map((r) => r.key), ['p2']);
    assert.deepEqual(db.query({ filter: { 'user.addr.zip': '75001' } }).map((r) => r.key), ['p1']);
    // Bracket index into an array element.
    assert.deepEqual(db.query({ filter: { 'items[1].sku': 'B' } }).map((r) => r.key), ['p1']);
    // Missing intermediate path does not match.
    assert.deepEqual(db.query({ filter: { 'user.addr.zip': 'x' } }).map((r) => r.key).length, 0);

    // Nested projection rebuilds the nested shape in the output.
    const projected = db.query({ filter: { 'user.name': 'Ann' }, project: ['user.addr.zip', 'items[0].sku'] });
    assert.deepEqual(projected[0]!.value, { user: { addr: { zip: '75001' } }, items: [{ sku: 'A' }] });

    // Projecting a missing path drops it; empty project list returns the doc.
    assert.deepEqual(db.query({ project: [] })[0]!.value, (await db.get('p1')));
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('sort ascending/descending, skip and limit', async () => {
  const { dir, db } = await seed();
  try {
    assert.deepEqual(db.query({ sort: { age: 1 } }).map((r) => r.key), ['b', 'c', 'a', 'd']);
    assert.deepEqual(db.query({ sort: { age: -1 } }).map((r) => r.key), ['d', 'a', 'c', 'b']);
    assert.deepEqual(db.query({ sort: { age: 1 }, skip: 1, limit: 2 }).map((r) => r.key), ['c', 'a']);
    // No filter / sort returns every document.
    assert.equal(db.query().length, 4);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
