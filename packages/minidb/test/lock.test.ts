// test/lock.test.js
import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';
import { LockError, LockFile, LOCK_CREATION_WINDOW_MS } from '../src/lockfile.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-lock-'));
}

async function cleanup(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
}

const legacyPayload = (pid: number) => JSON.stringify({ pid, ts: Date.now() });

async function ageFile(p: string) {
  const past = new Date(Date.now() - LOCK_CREATION_WINDOW_MS - 1000);
  await fs.utimes(p, past, past);
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

// --- stale takeover ----------------------------------------------------------

test('a stale lock (dead PID) is taken over via rename isolation', async () => {
  const dir = await tmpDir();
  // Legacy payload shape ({pid, ts} only): old minidb versions left these.
  await fs.writeFile(path.join(dir, 'db.lock'), legacyPayload(999999));
  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  assert.equal(db.readOnly, false);
  await db.set('a', '1');
  assert.equal(db.get('a'), '1');
  // The old lock is renamed aside (no lock_id in legacy payload → "unknown"),
  // never deleted, so the takeover stays auditable.
  assert((await fs.readdir(dir)).includes('db.lock.stale.unknown'));
  await db.close();
  await cleanup(dir);
});

test('a stale lock with a protocol payload keeps its lock_id in the stale file name', async () => {
  const dir = await tmpDir();
  await fs.writeFile(
    path.join(dir, 'db.lock'),
    JSON.stringify({ pid: 999999, ts: Date.now(), lock_id: 'old-token', process_started_at: 'x' }),
  );
  const lock = new LockFile(path.join(dir, 'db.lock'), { newLockId: () => 'new-token' });
  assert.equal(await lock.acquire(), true);
  assert.equal(lock.held, true);
  assert((await fs.readdir(dir)).includes('db.lock.stale.old-token'));
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'db.lock'), 'utf8'));
  assert.equal(onDisk.lock_id, 'new-token');
  await lock.release();
  // Release removed only our own lock; the quarantined stale file stays.
  const after = await fs.readdir(dir);
  assert(!after.includes('db.lock'));
  assert(after.includes('db.lock.stale.old-token'));
  await cleanup(dir);
});

// --- creation window: fresh empty/garbage files are "creating", not stale ----

test('a fresh empty lock file counts as still being created (acquire refused)', async () => {
  const dir = await tmpDir();
  const p = path.join(dir, 'db.lock');
  await fs.writeFile(p, '');
  const lock = new LockFile(p);
  assert.equal(await lock.acquire(), false);
  assert.equal(lock.held, false);

  // Once the file is older than the creation window it is stale and can be
  // taken over — via rename isolation, not unlink+create.
  await ageFile(p);
  assert.equal(await lock.acquire(), true);
  assert((await fs.readdir(dir)).includes('db.lock.stale.unknown'));
  await lock.release();
  await cleanup(dir);
});

test('a fresh unparseable lock file counts as being created; an old one is stale', async () => {
  const dir = await tmpDir();
  const p = path.join(dir, 'db.lock');
  await fs.writeFile(p, 'not-json');
  const lock = new LockFile(p);
  assert.equal(await lock.acquire(), false);

  await ageFile(p);
  assert.equal(await lock.acquire(), true);
  await lock.release();
  await cleanup(dir);
});

// --- token guard -------------------------------------------------------------

test('release never unlinks a lock that was taken over meanwhile', async () => {
  const dir = await tmpDir();
  const p = path.join(dir, 'db.lock');
  const a = new LockFile(p, { newLockId: () => 'a-token' });
  assert.equal(await a.acquire(), true);

  // A judges A's (simulated dead) entry stale and B's payload replaces it on
  // disk — e.g. after a real takeover of a frozen A.
  await fs.writeFile(p, JSON.stringify({ pid: process.pid, ts: Date.now(), lock_id: 'b-token' }));

  await a.release(); // must not touch B's lock
  const onDisk = JSON.parse(await fs.readFile(p, 'utf8'));
  assert.equal(onDisk.lock_id, 'b-token');

  // Same for the sync variant (rebuild the "held but superseded" state).
  Object.assign(a, { held: true, lockId: 'a-token' });
  a.releaseSync();
  const stillB = JSON.parse(await fs.readFile(p, 'utf8'));
  assert.equal(stillB.lock_id, 'b-token');
  await cleanup(dir);
});

test('a read-back token mismatch rejects the acquire', async () => {
  const dir = await tmpDir();
  const p = path.join(dir, 'db.lock');
  const lock = new LockFile(p, { newLockId: () => 'victim-token' });
  // A peer stomps the file between our O_EXCL create and our read-back.
  const foreign = JSON.stringify({ pid: process.pid, ts: Date.now(), lock_id: 'other-token' });
  const spy = vi
    .spyOn(LockFile.prototype as never, 'readDiskText')
    .mockImplementation(async function (this: { path: string }) {
      await fs.writeFile(this.path, foreign);
      return fs.readFile(this.path, 'utf8');
    });
  try {
    assert.equal(await lock.acquire(), false);
    assert.equal(lock.held, false);
    const onDisk = JSON.parse(await fs.readFile(p, 'utf8'));
    assert.equal(onDisk.lock_id, 'other-token');
  } finally {
    spy.mockRestore();
    await cleanup(dir);
  }
});

// --- pid reuse (processStartedAt identity) -----------------------------------

test('a live pid whose processStartedAt differs is treated as dead (pid reused)', async () => {
  const dir = await tmpDir();
  const p = path.join(dir, 'db.lock');
  await fs.writeFile(
    p,
    JSON.stringify({ pid: 12345, ts: Date.now(), lock_id: 'old-token', process_started_at: 'A' }),
  );
  const lock = new LockFile(p, {
    probeProcess: () => ({ alive: true, processStartedAt: 'B' }),
  });
  assert.equal(await lock.acquire(), true);
  assert((await fs.readdir(dir)).includes('db.lock.stale.old-token'));
  await lock.release();
  await cleanup(dir);
});

test('identity unavailable for a live pid is conservative: no takeover', async () => {
  const dir = await tmpDir();
  const p = path.join(dir, 'db.lock');
  await fs.writeFile(
    p,
    JSON.stringify({ pid: 12345, ts: Date.now(), lock_id: 'old-token', process_started_at: 'A' }),
  );
  const lock = new LockFile(p, {
    probeProcess: () => ({ alive: true, processStartedAt: undefined }),
  });
  assert.equal(await lock.acquire(), false);
  // Nothing was renamed aside either.
  assert.deepEqual(await fs.readdir(dir), ['db.lock']);
  await cleanup(dir);
});

test('matching identity for a live pid also refuses takeover', async () => {
  const dir = await tmpDir();
  const p = path.join(dir, 'db.lock');
  await fs.writeFile(
    p,
    JSON.stringify({ pid: 12345, ts: Date.now(), lock_id: 'old-token', process_started_at: 'A' }),
  );
  const lock = new LockFile(p, {
    probeProcess: () => ({ alive: true, processStartedAt: 'A' }),
  });
  assert.equal(await lock.acquire(), false);
  await cleanup(dir);
});

// --- legacy payload compatibility ---------------------------------------------

test('legacy payload ({pid, ts} only): dead pid is taken over, live pid is refused', async () => {
  const dir = await tmpDir();
  const p = path.join(dir, 'db.lock');

  await fs.writeFile(p, legacyPayload(999999));
  const dead = new LockFile(p);
  assert.equal(await dead.acquire(), true);
  await dead.release();

  await fs.writeFile(p, legacyPayload(process.pid));
  const live = new LockFile(p);
  assert.equal(await live.acquire(), false);
  await cleanup(dir);
});
