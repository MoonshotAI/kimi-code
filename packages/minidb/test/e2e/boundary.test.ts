// test/e2e/boundary.test.js
//
// Boundary / resource edge cases.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { MiniDb } from '../../src/index.js';
import { tmpDir, rmrf } from './helpers/tmp.js';

test('boundary: key length limits', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    await db.set('a'.repeat(128), 'ok'); // exactly at limit
    assert.equal(db.get('a'.repeat(128)), 'ok');
    await assert.rejects(() => db.set('a'.repeat(129), 'no'), /key too long/);
    await assert.rejects(() => db.set('', 'no'), /non-empty/);
  } finally {
    await db.close();
    await rmrf(dir);
  }
});

test('boundary: large value round-trips and recovers', async () => {
  const dir = await tmpDir();
  const big = Buffer.alloc(5 * 1024 * 1024, 0xab); // 5 MiB
  big[0] = 0x01;
  big[big.length - 1] = 0x02;
  let db = await MiniDb.open({ dir, valueCodec: 'buffer', fsyncPolicy: 'always' });
  try {
    await db.set('big', big);
    const got = db.get('big');
    assert.equal(got.length, big.length);
    assert.equal(got[0], 0x01);
    assert.equal(got[big.length - 1], 0x02);
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'buffer' });
    const got2 = db.get('big');
    assert.equal(got2.length, big.length);
    assert.equal(got2[0], 0x01);
  } finally {
    await db.close().catch(() => {});
    await rmrf(dir);
  }
});

test('boundary: many keys survive compaction + recovery', async () => {
  const dir = await tmpDir();
  const N = 20000;
  let db = await MiniDb.open({
    dir,
    valueCodec: 'string',
    fsyncPolicy: 'no',
    compactThresholdBytes: 64 * 1024,
  });
  try {
    const ops = [];
    for (let i = 0; i < N; i++) ops.push(db.set('k' + i, 'v' + i));
    await Promise.all(ops);
    if (db.compacting) await db._compactDone;
    assert.equal(db.size, N);
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string' });
    assert.equal(db.size, N);
    assert.equal(db.get('k0'), 'v0');
    assert.equal(db.get('k' + (N - 1)), 'v' + (N - 1));
  } finally {
    await db.close().catch(() => {});
    await rmrf(dir);
  }
});

test('boundary: empty db open/close/reopen', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'string' });
  await db.close();
  db = await MiniDb.open({ dir, valueCodec: 'string' });
  assert.equal(db.size, 0);
  assert.equal(db.get('nope'), undefined);
  await db.close();
  await rmrf(dir);
});

test('boundary: overwrite same key many times keeps size 1', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    for (let i = 0; i < 1000; i++) await db.set('same', 'v' + i);
    assert.equal(db.size, 1);
    assert.equal(db.get('same'), 'v999');
  } finally {
    await db.close();
    await rmrf(dir);
  }
});

test('boundary: empty / unicode / binary values', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    await db.set('empty', '');
    await db.set('unicode', '你好 🌍');
    assert.equal(db.get('empty'), '');
    assert.equal(db.get('unicode'), '你好 🌍');
    await db.close();
    db = await MiniDb.open({ dir, valueCodec: 'string' });
    assert.equal(db.get('empty'), '');
    assert.equal(db.get('unicode'), '你好 🌍');
  } finally {
    await db.close().catch(() => {});
    await rmrf(dir);
  }
});
