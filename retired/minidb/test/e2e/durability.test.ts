// test/e2e/durability.test.js
//
// Durability semantics for the three fsync policies and close().

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MiniDb } from '../../src/index.js';
import { tmpDir, rmrf } from './helpers/tmp.js';

for (const policy of ['always', 'everysec', 'no']) {
  test(`durability: close() persists all writes (fsyncPolicy=${policy})`, async () => {
    const dir = await tmpDir();
    const N = 200;
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: policy });
    try {
      for (let i = 0; i < N; i++) await db.set('k' + i, 'v' + i);
      await db.close();
      db = await MiniDb.open({ dir, valueCodec: 'string' });
      assert.equal(db.size, N);
      for (let i = 0; i < N; i++) assert.equal(db.get('k' + i), 'v' + i);
    } finally {
      await db.close().catch(() => {});
      await rmrf(dir);
    }
  });
}

test("durability: 'always' writes each frame to the file before set() resolves", async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'always' });
  const walPath = path.join(dir, 'db.wal');
  try {
    for (let i = 0; i < 20; i++) {
      await db.set('k' + i, 'v' + i);
      const buf = await fs.readFile(walPath);
      assert.ok(buf.includes(Buffer.from('k' + i)), `frame for k${i} already in WAL`);
    }
  } finally {
    await db.close();
    await rmrf(dir);
  }
});

test('durability: data survives many open/close cycles', async () => {
  const dir = await tmpDir();
  try {
    for (let cycle = 0; cycle < 20; cycle++) {
      const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'everysec' });
      await db.set('cycle' + cycle, 'v' + cycle);
      await db.close();
    }
    const db = await MiniDb.open({ dir, valueCodec: 'string' });
    assert.equal(db.size, 20);
    for (let cycle = 0; cycle < 20; cycle++) assert.equal(db.get('cycle' + cycle), 'v' + cycle);
    await db.close();
  } finally {
    await rmrf(dir);
  }
});
