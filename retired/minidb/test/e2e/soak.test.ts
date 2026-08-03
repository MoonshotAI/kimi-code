// test/e2e/soak.test.js
//
// Long-running soak: sustained random set/del/compact/reopen to catch memory
// leaks and slow degradation. Opt-in via SOAK=<seconds> because it is slow.
//
//   SOAK=30 node --test --expose-gc test/e2e/soak.test.js

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { MiniDb } from '../../src/index.js';
import { Model } from './helpers/model.js';
import { mulberry32, pick } from './helpers/prng.js';
import { tmpDir, rmrf } from './helpers/tmp.js';

const SOAK = Number(process.env.SOAK || 0);

test('soak: sustained random ops do not leak memory or corrupt', { skip: !SOAK }, async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({
    dir,
    valueCodec: 'json',
    fsyncPolicy: 'no',
    compactThresholdBytes: 256 * 1024,
  });
  const KEYS = Array.from({ length: 500 }, (_, i) => 'k' + i);
  const rng = mulberry32(0x50ac1234);
  const model = new Model();
  const deadline = Date.now() + SOAK * 1000;
  let ops = 0;
  let firstHeap = 0;
  try {
    while (Date.now() < deadline) {
      for (let j = 0; j < 200; j++) {
        const key = pick(rng, KEYS);
        if (rng() < 0.7) {
          const v = { i: ops, pad: 'x'.repeat(50) };
          await db.set(key, v);
          model.set(key, v);
        } else {
          await db.del(key);
          model.del(key);
        }
        ops++;
      }
      if (ops % 2000 === 0) {
        if (global.gc) global.gc();
        const h = process.memoryUsage().heapUsed;
        if (!firstHeap) firstHeap = h;
      }
      if (ops % 5000 === 0) await db.compact().catch(() => {});
    }

    if (global.gc) global.gc();
    const finalHeap = process.memoryUsage().heapUsed;
    const mib = (n) => (n / 1024 / 1024).toFixed(1);
    console.log(`  soak: ${ops} ops, heap ${mib(firstHeap)} -> ${mib(finalHeap)} MiB`);
    assert.ok(
      finalHeap < firstHeap * 3 + 50 * 1024 * 1024,
      `heap grew too much: ${firstHeap} -> ${finalHeap}`,
    );

    // integrity after reopen
    await db.close();
    db = await MiniDb.open({ dir, valueCodec: 'json' });
    for (const k of KEYS) assert.deepEqual(db.get(k), model.get(k), `soak reopen ${k}`);
  } finally {
    await db.close().catch(() => {});
    await rmrf(dir);
  }
});
