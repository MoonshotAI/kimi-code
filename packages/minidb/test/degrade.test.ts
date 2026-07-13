// test/degrade.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';
import { LockError } from '../src/lockfile.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-degrade-'));
}

test('openOrRebuild opens a healthy db normally', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.openOrRebuild({ dir, valueCodec: 'string' });
  await db.set('a', '1');
  assert.equal(db.get('a'), '1');
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('openOrRebuild discards a corrupt db and starts fresh', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createIndex('byX', { field: 'x' });
  await db.set('important', { x: 1 });
  await db.close();

  // Corrupt the index-definitions file so open() throws during load.
  await fs.writeFile(path.join(dir, 'db.indexes.json'), '{ not valid json');

  let rebuilt = null;
  db = await MiniDb.openOrRebuild(
    { dir, valueCodec: 'json' },
    { onRebuild: (e) => (rebuilt = e) },
  );
  assert.ok(rebuilt instanceof Error, 'onRebuild called with the original error');
  assert.equal(db.size, 0, 'fresh empty db after rebuild');
  // data is gone (rebuild semantics) and the db is usable again
  await db.set('fresh', { v: 1 });
  assert.deepEqual(db.get('fresh'), { v: 1 });
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('openOrRebuild does NOT delete a live-locked db', async () => {
  const dir = await tmpDir();
  const db1 = await MiniDb.open({ dir, valueCodec: 'string' });
  await db1.set('a', '1');
  try {
    await assert.rejects(() => MiniDb.openOrRebuild({ dir, valueCodec: 'string' }), LockError);
    // data still there
    assert.ok(await fs.stat(path.join(dir, 'db.wal')));
  } finally {
    await db1.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
