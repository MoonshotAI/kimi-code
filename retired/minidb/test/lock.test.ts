// test/lock.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';
import { LockError } from '../src/lockfile.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-lock-'));
}

test('a second writer on the same dir is rejected with LockError', async () => {
  const dir = await tmpDir();
  const db1 = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    await assert.rejects(() => MiniDb.open({ dir, valueCodec: 'string' }), LockError);
  } finally {
    await db1.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('lock is released on close, allowing another writer', async () => {
  const dir = await tmpDir();
  const db1 = await MiniDb.open({ dir, valueCodec: 'string' });
  await db1.set('a', '1');
  await db1.close();

  const db2 = await MiniDb.open({ dir, valueCodec: 'string' });
  assert.equal(db2.get('a'), '1');
  await db2.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('readOnly open succeeds alongside a writer and rejects writes', async () => {
  const dir = await tmpDir();
  const db1 = await MiniDb.open({ dir, valueCodec: 'string' });
  await db1.set('a', '1');
  try {
    const ro = await MiniDb.open({ dir, valueCodec: 'string', readOnly: true });
    assert.equal(ro.readOnly, true);
    assert.equal(ro.get('a'), '1');
    await assert.rejects(() => ro.set('b', '2'), /read-only/);
    await ro.close();
  } finally {
    await db1.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("onLockFail: 'readonly' degrades instead of throwing", async () => {
  const dir = await tmpDir();
  const db1 = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    const db2 = await MiniDb.open({ dir, valueCodec: 'string', onLockFail: 'readonly' });
    assert.equal(db2.readOnly, true);
    await db2.close();
  } finally {
    await db1.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a stale lock (dead PID) is taken over', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'db.lock'), JSON.stringify({ pid: 999999, ts: Date.now() }));
  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  assert.equal(db.readOnly, false);
  await db.set('a', '1');
  assert.equal(db.get('a'), '1');
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});
