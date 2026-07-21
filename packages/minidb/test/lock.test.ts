import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { test } from 'vitest';

import { MiniDb } from '../src/index.js';
import { LockError, LockFile } from '../src/lockfile.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-lock-'));
}

async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

test('a second writer on the same dir is rejected with LockError', async () => {
  const dir = await tmpDir();
  const db1 = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    await assert.rejects(() => MiniDb.open({ dir, valueCodec: 'string' }), LockError);
  } finally {
    await db1.close();
    await cleanup(dir);
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
  await cleanup(dir);
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
    await cleanup(dir);
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
    await cleanup(dir);
  }
});

test('pre-existing sentinel contents do not imply ownership', async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, 'db.lock');
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, lock_id: 'legacy' }));

  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  await db.set('a', '1');
  assert.equal(db.get('a'), '1');
  await db.close();

  assert.equal(await fs.readFile(lockPath, 'utf8'), JSON.stringify({ pid: process.pid, lock_id: 'legacy' }));
  await cleanup(dir);
});

test('LockFile uses kernel ownership and leaves the sentinel in place', async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, 'db.lock');
  const first = new LockFile(lockPath);
  const second = new LockFile(lockPath);

  assert.equal(await first.acquire(), true);
  assert.equal(await second.acquire(), false);
  await first.release();
  assert.equal(await fs.stat(lockPath).then(() => true), true);
  assert.equal(await second.acquire(), true);
  await second.release();
  await cleanup(dir);
});

test('rewriting sentinel contents cannot transfer a live lock', async () => {
  const dir = await tmpDir();
  const lockPath = path.join(dir, 'db.lock');
  const first = new LockFile(lockPath);
  const second = new LockFile(lockPath);
  assert.equal(await first.acquire(), true);

  await fs.writeFile(lockPath, 'operator note');
  assert.doesNotThrow(() => first.assertHeld());
  assert.equal(await second.acquire(), false);

  await first.release();
  await cleanup(dir);
});

test('release and releaseSync are idempotent', async () => {
  const dir = await tmpDir();
  const lock = new LockFile(path.join(dir, 'db.lock'));
  await assert.doesNotReject(() => lock.release());
  assert.doesNotThrow(() => lock.releaseSync());
  assert.equal(await lock.acquire(), true);
  await lock.release();
  assert.doesNotThrow(() => lock.releaseSync());
  await cleanup(dir);
});
