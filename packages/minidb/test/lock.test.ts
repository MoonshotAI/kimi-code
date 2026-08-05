// test/lock.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';
import { LockError, LockFile } from '../src/lockfile.js';

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

// ---- owner token: per-instance ownership (review #10/#11 regression) ------

test('two same-process contenders over a stale corpse: exactly one wins, zero double-wins', { timeout: 120_000 }, async () => {
  const dir = await tmpDir();
  try {
    const lockPath = path.join(dir, 'db.lock');
    for (let i = 0; i < 100; i++) {
      await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, ts: Date.now() }));
      const a = new LockFile(lockPath);
      const b = new LockFile(lockPath);
      const wins = await Promise.all([a.acquire(), b.acquire()]);
      assert.equal(wins.filter(Boolean).length, 1, `iteration ${i}: exactly one winner`);
      await a.release();
      await b.release();
      // The winner's release unlinked its own lock; nothing may be left.
      assert.equal(
        await fs.stat(lockPath).then(() => true, () => false),
        false,
        `iteration ${i}: lock released`,
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a racing renew() never re-publishes a released lock (100 iterations)', { timeout: 60_000 }, async () => {
  const dir = await tmpDir();
  try {
    for (let i = 0; i < 100; i++) {
      const lockPath = path.join(dir, `db-${i}.lock`);
      const lock = new LockFile(lockPath);
      assert.equal(await lock.acquire(), true);
      await Promise.all([lock.renew(), lock.release()]);
      assert.equal(lock.held, false);
      assert.equal(
        await fs.stat(lockPath).then(() => true, () => false),
        false,
        `iteration ${i}: no ghost lock`,
      );
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('renew() keeps the owner token, so release() still recognizes the lock', async () => {
  const dir = await tmpDir();
  try {
    const lockPath = path.join(dir, 'db.lock');
    const lock = new LockFile(lockPath);
    assert.equal(await lock.acquire(), true);
    const before = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { token?: string };
    await lock.renew();
    const after = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { token?: string };
    assert.equal(after.token, before.token, 'renew preserves the owner token');
    await lock.release();
    assert.equal(await fs.stat(lockPath).then(() => true, () => false), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('acquire() on an already-held lock is an idempotent true and does not re-mint the token', async () => {
  const dir = await tmpDir();
  try {
    const lockPath = path.join(dir, 'db.lock');
    const lock = new LockFile(lockPath);
    assert.equal(await lock.acquire(), true);
    const before = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { token?: string };
    assert.equal(await lock.acquire(), true, 're-entrant acquire reports the held lock');
    const after = JSON.parse(await fs.readFile(lockPath, 'utf8')) as { token?: string };
    assert.equal(after.token, before.token, 'token is not re-minted');
    await lock.release();
    assert.equal(
      await fs.stat(lockPath).then(() => true, () => false),
      false,
      'release still recognizes and unlinks its own lock',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a legacy tokenless lock file is respected while alive and taken over when dead', async () => {
  const dir = await tmpDir();
  try {
    // Live same-pid owner without a token: respected exactly as before — the
    // protocol does not open a "I know the old instance is gone" backdoor.
    const livePath = path.join(dir, 'live.lock');
    const legacyLive = JSON.stringify({ pid: process.pid, ts: Date.now() });
    await fs.writeFile(livePath, legacyLive);
    const contender = new LockFile(livePath);
    assert.equal(await contender.acquire(), false);
    assert.equal(await fs.readFile(livePath, 'utf8'), legacyLive, 'live legacy lock untouched');

    // Dead-pid owner without a token: taken over via the stale rules, and the
    // new lock line carries the instance token.
    const deadPath = path.join(dir, 'dead.lock');
    await fs.writeFile(deadPath, JSON.stringify({ pid: 999999, ts: Date.now() }));
    const taker = new LockFile(deadPath);
    assert.equal(await taker.acquire(), true);
    const taken = JSON.parse(await fs.readFile(deadPath, 'utf8')) as { pid: number; token?: string };
    assert.equal(taken.pid, process.pid);
    assert.ok(
      typeof taken.token === 'string' && taken.token.startsWith(`${process.pid}:`),
      'taken-over lock line carries the owner token',
    );
    await taker.release();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- close() state machine: exception-safe cleanup (review #12 regression) -

test('close() still releases the lock when the WAL close fails; a retry finishes the cleanup', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    await db.set('a', '1');
    const internals = db as unknown as { wal: { close(): Promise<void> } };
    const originalClose = internals.wal.close.bind(internals.wal);
    let failClose = true;
    internals.wal.close = async () => {
      await originalClose();
      if (failClose) {
        failClose = false;
        throw new Error('injected close failure');
      }
    };
    const err = await db.close().catch((e: unknown) => e);
    assert.ok(err instanceof AggregateError, 'close failure is aggregated');
    assert.equal(err.errors.length, 1);
    assert.match(String(err.errors[0]), /injected close failure/);
    // The lock release was NOT skipped by the WAL failure.
    assert.equal(
      await fs.stat(path.join(dir, 'db.lock')).then(() => true, () => false),
      false,
      'lock released despite the WAL close failure',
    );
    // Idempotent continuation: the second pass completes the cleanup.
    await db.close();
    await db.close(); // fully closed now: a no-op
    // The directory is free: a fresh writer opens with no LockError.
    const reopened = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    assert.equal(reopened.get('a'), '1');
    await reopened.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('close() aggregates every cleanup error instead of stopping at the first', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    const internals = db as unknown as {
      wal: { close(): Promise<void> };
      lock: { release(): Promise<void> } | null;
    };
    const originalWalClose = internals.wal.close.bind(internals.wal);
    let failWal = true;
    internals.wal.close = async () => {
      await originalWalClose();
      if (failWal) {
        failWal = false;
        throw new Error('injected wal close failure');
      }
    };
    const lock = internals.lock!;
    const originalRelease = lock.release.bind(lock);
    let failRelease = true;
    lock.release = async () => {
      if (failRelease) {
        failRelease = false;
        throw new Error('injected lock release failure');
      }
      return originalRelease();
    };
    const err = await db.close().catch((e: unknown) => e);
    assert.ok(err instanceof AggregateError, 'close failure is aggregated');
    assert.deepEqual(
      err.errors.map((e) => (e instanceof Error ? e.message : String(e))),
      ['injected wal close failure', 'injected lock release failure'],
      'AggregateError carries every cleanup error',
    );
    // Retry: the WAL close is now a no-op, the lock release runs for real.
    await db.close();
    assert.equal(
      await fs.stat(path.join(dir, 'db.lock')).then(() => true, () => false),
      false,
      'lock released on the retry',
    );
    // The instance refused use from the first 'closing' transition on.
    await assert.rejects(() => db.set('b', '2'), /MiniDb is closed/);
    await assert.rejects(() => db.compact(), /MiniDb is closed/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('close() waits out a failing in-flight compaction and still cleans up every resource', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    await db.set('a', '1');
    // Keep the compaction deterministically in flight when close() starts, and
    // fail it (via the onCompacted hook, a real compactError path) while
    // close() is parked on _compactDone.
    let failHook: ((e: Error) => void) | undefined;
    db.onCompacted = () =>
      new Promise<void>((_, reject) => {
        failHook = reject;
      });
    const compacted = db.compact().catch(() => {});
    // Wait until the compaction actually reaches the injected hook (the
    // compacting flag flips long before the hook is invoked).
    while (!failHook) await new Promise((r) => setTimeout(r, 1));
    const closing = db.close();
    failHook(new Error('injected compaction failure'));
    await compacted;
    // The compaction failure is accounted on the instance, but close() must
    // not reject with it and must not skip the cleanup.
    await closing;
    assert.match(String(db.lastCompactError), /injected compaction failure/);
    assert.equal(
      await fs.stat(path.join(dir, 'db.lock')).then(() => true, () => false),
      false,
      'lock released despite the failed compaction',
    );
    await db.close(); // fully closed now: a no-op
    const reopened = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    await reopened.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
