// test/e2e/recovery-matrix.test.js
//
// Matrix of recovery scenarios: WAL corruption at head/mid/tail under
// 'resync' vs 'strict', and snapshot + WAL combinations.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MiniDb } from '../../src/index.js';
import { HEADER_SIZE, CRC_SIZE } from '../../src/codec.js';
import { tmpDir, rmrf } from './helpers/tmp.js';

// key 'kN'(2B) + value 'vN'(2B), no meta -> 22+2+2+0+4 = 30 bytes / frame
const FRAME = HEADER_SIZE + 2 + 2 + 0 + CRC_SIZE;

async function writeTen(dir) {
  const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'always', autoCompact: false });
  for (let i = 0; i < 10; i++) await db.set('k' + i, 'v' + i);
  await db.close();
}

async function corruptWalFrame(dir, frameIndex) {
  const walPath = path.join(dir, 'db.wal');
  const buf = await fs.readFile(walPath);
  buf[frameIndex * FRAME + HEADER_SIZE + 2] ^= 0xff; // flip a value byte -> bad crc
  await fs.writeFile(walPath, buf);
}

const POS = { head: 0, mid: 5, tail: 9 };

for (const mode of ['resync', 'strict']) {
  for (const [where, idx] of Object.entries(POS)) {
    test(`recovery-matrix: WAL corrupt at ${where}, mode=${mode}`, async () => {
      const dir = await tmpDir();
      try {
        await writeTen(dir);
        await corruptWalFrame(dir, idx);
        const db = await MiniDb.open({ dir, valueCodec: 'string', recovery: mode });
        const present = new Set(Array.from({ length: 10 }, (_, i) => 'k' + i).filter((k) => db.get(k) !== undefined));

        if (where === 'tail') {
          // last frame bad -> truncated, everything else recovered
          assert.equal(db.recoveryInfo.truncatedWal, true);
          assert.equal(present.size, 9);
          assert.ok(!present.has('k9'));
        } else if (mode === 'resync') {
          // only the bad frame lost
          assert.equal(present.size, 9);
          assert.ok(!present.has('k' + idx));
        } else {
          // strict: everything from the bad frame onward lost
          for (let i = 0; i < 10; i++) {
            if (i < idx) assert.ok(present.has('k' + i), `k${i} should survive`);
            else assert.ok(!present.has('k' + i), `k${i} should be lost (strict)`);
          }
        }
        await db.close();
      } finally {
        await rmrf(dir);
      }
    });
  }
}

test('recovery-matrix: clean WAL recovers everything (both modes)', async () => {
  for (const mode of ['resync', 'strict']) {
    const dir = await tmpDir();
    try {
      await writeTen(dir);
      const db = await MiniDb.open({ dir, valueCodec: 'string', recovery: mode });
      assert.equal(db.size, 10);
      assert.equal(db.recoveryInfo.lostBytes, 0);
      await db.close();
    } finally {
      await rmrf(dir);
    }
  }
});

test('recovery-matrix: snapshot present, empty WAL', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'always', autoCompact: false });
    for (let i = 0; i < 10; i++) await db.set('k' + i, 'v' + i);
    await db.compact();
    await db.close();
    const db2 = await MiniDb.open({ dir, valueCodec: 'string' });
    assert.equal(db2.recoveryInfo.snapshotFrames, 10);
    assert.equal(db2.recoveryInfo.walFrames, 0);
    assert.equal(db2.size, 10);
    await db2.close();
  } finally {
    await rmrf(dir);
  }
});

test('recovery-matrix: snapshot + clean WAL', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'always', autoCompact: false });
    for (let i = 0; i < 10; i++) await db.set('k' + i, 'v' + i);
    await db.compact();
    for (let i = 0; i < 5; i++) await db.set('a' + i, 'b' + i); // new WAL writes
    await db.close();
    const db2 = await MiniDb.open({ dir, valueCodec: 'string' });
    assert.equal(db2.size, 15);
    await db2.close();
  } finally {
    await rmrf(dir);
  }
});

test('recovery-matrix: snapshot + corrupt WAL mid (resync keeps snapshot + surviving WAL)', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'always', autoCompact: false });
    for (let i = 0; i < 10; i++) await db.set('k' + i, 'v' + i);
    await db.compact();
    for (let i = 0; i < 5; i++) await db.set('a' + i, 'b' + i); // 5 new WAL frames
    await db.close();
    await corruptWalFrame(dir, 2); // corrupt 'a2' in the new WAL
    const db2 = await MiniDb.open({ dir, valueCodec: 'string', recovery: 'resync' });
    assert.equal(db2.get('a2'), undefined, 'corrupt WAL frame lost');
    assert.equal(db2.get('a0'), 'b0');
    assert.equal(db2.get('a4'), 'b4');
    assert.equal(db2.size, 14); // 10 snapshot + 4 surviving WAL
    await db2.close();
  } finally {
    await rmrf(dir);
  }
});
