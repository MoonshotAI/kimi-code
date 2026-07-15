// test/e2e/fuzz-model.test.js
//
// Model-based fuzz: feed identical random op sequences to MiniDb and a tiny
// reference model, and assert they always agree. Seeded so any failure is
// reproducible by re-running with the same seed.

import { expect, test } from 'vitest';
import assert from 'node:assert/strict';
import { MiniDb } from '../../src/index.js';
import { Model } from './helpers/model.js';
import { mulberry32, randInt, pick } from './helpers/prng.js';
import { tmpDir, rmrf } from './helpers/tmp.js';

const KEYS = Array.from({ length: 24 }, (_, i) => 'k' + i);
const VALUES = [{ a: 1 }, { b: [1, 2, 3] }, { s: 'hello' }, { n: 42 }, null, { nested: { x: 1, y: [2] } }];

async function runSeed(seed, steps) {
  const rng = mulberry32(seed >>> 0);
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  const model = new Model();
  const ctx = () => `seed=${seed} step`;
  try {
    for (let i = 0; i < steps; i++) {
      const op = randInt(rng, 5);
      const key = pick(rng, KEYS);

      if (op === 0) {
        // set (no expiry, or far-future expiry so nothing auto-expires mid-run)
        const value = pick(rng, VALUES);
        const ttl = rng() < 0.2 ? 60000 : 0;
        await db.set(key, value, ttl ? { ttl } : {});
        model.set(key, value, ttl);
      } else if (op === 1) {
        await db.del(key);
        model.del(key);
      } else if (op === 2) {
        assert.deepEqual(db.get(key), model.get(key), `${ctx()} ${i}: get(${key})`);
      } else if (op === 3) {
        const ttl = 60000;
        const a = await db.expire(key, ttl);
        const e = model.expire(key, ttl);
        assert.equal(a, e, `${ctx()} ${i}: expire(${key})`);
      } else {
        // reopen, then compare everything
        await db.close();
        db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
        for (const k of KEYS) {
          assert.deepEqual(db.get(k), model.get(k), `${ctx()} ${i}: after reopen get(${k})`);
        }
      }
    }
    // final full compare
    for (const k of KEYS) assert.deepEqual(db.get(k), model.get(k), `final get(${k}) seed=${seed}`);
  } finally {
    await db.close().catch(() => {});
    await rmrf(dir);
  }
}

test('fuzz-model: random op sequences match a reference model (many seeds)', async () => {
  // Mix of small and large seeds. 6 seeds × 250 steps ≈ 1.5k ops total, still
  // hitting every op branch (including reopen + full compare) many times per seed.
  const seeds = [1, 2, 3, 99999, 0xdeadbeef, 20240625];
  for (const seed of seeds) {
    await expect(runSeed(seed, 250)).resolves.toBeUndefined();
  }
}, 60_000);
