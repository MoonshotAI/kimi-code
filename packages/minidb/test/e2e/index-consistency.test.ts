// test/e2e/index-consistency.test.js
//
// Verify that all derived indexes (key order, dt, value secondary, full-text)
// stay consistent with the primary store under random operations, including
// after an index rebuild on reopen.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { MiniDb } from '../../src/index.js';
import { UniqueViolationError } from '../../src/index-manager.js';
import { mulberry32, randInt, pick } from './helpers/prng.js';
import { tmpDir, rmrf } from './helpers/tmp.js';

const CITIES = ['Paris', 'London', 'Tokyo', 'Beijing'];
const BIOS = ['hello world', 'foo bar baz', '我住在北京 喜欢编程', 'database engine rocks', 'lark approval skill'];

function randomDoc(rng) {
  return {
    city: pick(rng, CITIES),
    age: randInt(rng, 60),
    email: 'u' + randInt(rng, 100000) + '@x.com',
    bio: pick(rng, BIOS),
  };
}

test('index-consistency: indexes stay consistent with the store under random ops', async () => {
  const rng = mulberry32(0x5eed1234);
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  await db.createIndex('byCity', { field: 'city' });
  await db.createIndex('byAge', { field: 'age', type: 'range' });
  await db.createIndex('byEmail', { field: 'email', unique: true });
  await db.createTextIndex('body', { fields: ['bio'] });

  const live = new Map(); // key -> doc (reference of live docs)
  try {
    for (let i = 0; i < 800; i++) {
      const key = 'u' + randInt(rng, 80);
      if (rng() < 0.75) {
        const doc = randomDoc(rng);
        try {
          await db.set(key, doc, { dt: { created: randInt(rng, 1_000_000) } });
          live.set(key, doc);
        } catch (e) {
          if (!(e instanceof UniqueViolationError)) throw e;
          // unique-email collision: write rejected, live unchanged
        }
      } else {
        await db.del(key);
        live.delete(key);
      }
    }

    const expectedKeys = [...live.keys()].sort();

    // 1) key order index
    assert.deepEqual(db.scan().map((r) => r.key), expectedKeys, 'key order scan');

    // 2) equality index
    for (const city of CITIES) {
      const fromIdx = db.findEq('byCity', city).map((r) => r.key).sort();
      const expected = [...live.entries()].filter(([, d]) => d.city === city).map(([k]) => k).sort();
      assert.deepEqual(fromIdx, expected, `byCity ${city}`);
    }

    // 3) range index
    const [min, max] = [20, 40];
    const fromRange = db.findRange('byAge', { min, max }).map((r) => r.key).sort();
    const expectedRange = [...live.entries()].filter(([, d]) => d.age >= min && d.age <= max).map(([k]) => k).sort();
    assert.deepEqual(fromRange, expectedRange, 'byAge range');

    // 4) dt index
    assert.deepEqual(db.dtRange('created', { gte: 0 }).map((r) => r.key).sort(), expectedKeys, 'dt created all');

    // 5) text index: search results == docs whose bio contains the term
    const term = '北京';
    const hits = db.search('body', term, { limit: 1000 }).map((r) => r.key).sort();
    const expectedHits = [...live.entries()].filter(([, d]) => d.bio.includes(term)).map(([k]) => k).sort();
    assert.deepEqual(hits, expectedHits, 'text search 北京');

    // 6) after rebuild on reopen, indexes still match
    await db.close();
    db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    const fromIdx2 = db.findEq('byCity', 'Paris').map((r) => r.key).sort();
    const expected2 = [...live.entries()].filter(([, d]) => d.city === 'Paris').map(([k]) => k).sort();
    assert.deepEqual(fromIdx2, expected2, 'byCity Paris after rebuild');
    assert.deepEqual(db.scan().map((r) => r.key), expectedKeys, 'key order after rebuild');
  } finally {
    await db.close().catch(() => {});
    await rmrf(dir);
  }
});
