// Exercises defensive input/state-validation branches that are reachable
// through the public/direct API but were not covered by the functional tests.
// Fault-injection-only branches (writev short-write, fsync failure, >64MB
// RESP payload, cross-user EPERM, process-exit hook) are intentionally not
// covered here — see the coverage summary in the commit message.
import { expect, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { WAL } from '../src/wal.js';
import { encodeFrame, decodeBatchOps, TYPE_SET } from '../src/codec.js';
import { MiniDb } from '../src/index.js';
import { LockFile } from '../src/lockfile.js';
import { startServer } from '../src/server.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-defense-'));
}

const B = (s: string) => Buffer.from(s);

// --- codec.encodeFrame input validation ------------------------------------

test('encodeFrame rejects a non-buffer key', () => {
  assert.throws(() => encodeFrame({ type: TYPE_SET, key: 'x' as unknown as Buffer, value: B('v') }), /key must be a Buffer/);
});

test('encodeFrame rejects an oversized key', () => {
  const big = Buffer.alloc(0xffff + 1);
  assert.throws(() => encodeFrame({ type: TYPE_SET, key: big, value: B('v') }), /key too large/);
});

test('encodeFrame rejects a SET with a non-buffer value', () => {
  assert.throws(
    () => encodeFrame({ type: TYPE_SET, key: B('k'), value: 'not-a-buffer' as unknown as Buffer }),
    /value must be a Buffer for SET/,
  );
});

test('encodeFrame rejects a non-buffer meta', () => {
  assert.throws(
    () => encodeFrame({ type: TYPE_SET, key: B('k'), value: B('v'), meta: 'x' as unknown as Buffer }),
    /meta must be a Buffer/,
  );
});

// --- codec.decodeBatchOps bounds checks ------------------------------------

test('decodeBatchOps returns [] for a body shorter than the count field', () => {
  assert.deepEqual(decodeBatchOps(Buffer.alloc(0)), []);
  assert.deepEqual(decodeBatchOps(Buffer.alloc(1)), []);
});

test('decodeBatchOps throws on a truncated op header', () => {
  // count = 1 but no op bytes follow.
  const body = Buffer.alloc(2);
  body.writeUInt16LE(1, 0);
  assert.throws(() => decodeBatchOps(body), /batch op header truncated/);
});

test('decodeBatchOps throws on a truncated op payload', () => {
  // Build one op header claiming a 100-byte key, then cut the body short.
  const header = Buffer.alloc(1 + 2 + 4 + 4 + 8);
  let o = 0;
  header.writeUInt8(TYPE_SET, o); o += 1;
  header.writeUInt16LE(100, o); o += 2;
  header.writeUInt32LE(0, o); o += 4;
  header.writeUInt32LE(0, o); o += 4;
  header.writeBigInt64LE(0n, o);
  const body = Buffer.concat([Buffer.from([1, 0]), header]); // count=1 + header, no payload
  assert.throws(() => decodeBatchOps(body), /batch op payload truncated/);
});

// --- WAL input/state validation --------------------------------------------

test('WAL constructor rejects an unknown fsyncPolicy', () => {
  assert.throws(() => new WAL('/tmp/x', { fsyncPolicy: 'bogus' as never }), /unknown fsyncPolicy/);
});

test('WAL append rejects a non-buffer frame', async () => {
  const dir = await tmpDir();
  const wal = new WAL(path.join(dir, 'db.wal'), { fsyncPolicy: 'no' });
  await wal.open();
  try {
    await assert.rejects(() => wal.append('x' as unknown as Buffer), /frame must be a Buffer/);
  } finally {
    await wal.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('WAL append after close rejects', async () => {
  const dir = await tmpDir();
  const wal = new WAL(path.join(dir, 'db.wal'), { fsyncPolicy: 'no' });
  await wal.open();
  await wal.close();
  await assert.rejects(
    () => wal.append(encodeFrame({ type: TYPE_SET, key: B('a'), value: B('1') })),
    /WAL is closed/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test('WAL open and close are idempotent', async () => {
  const dir = await tmpDir();
  const wal = new WAL(path.join(dir, 'db.wal'), { fsyncPolicy: 'everysec' });
  await expect(wal.open()).resolves.toBeUndefined();
  await expect(wal.open()).resolves.toBeUndefined(); // second open is a no-op
  await expect(wal.close()).resolves.toBeUndefined();
  await expect(wal.close()).resolves.toBeUndefined(); // second close is a no-op
  await fs.rm(dir, { recursive: true, force: true });
});

// --- LockFile stale / corrupt handling -------------------------------------

test('LockFile.acquire returns false when a live process holds the lock', async () => {
  const dir = await tmpDir();
  const p = path.join(dir, 'db.lock');
  const a = new LockFile(p);
  assert.equal(await a.acquire(), true);
  const b = new LockFile(p);
  assert.equal(await b.acquire(), false); // same PID is alive -> not stale
  await a.release();
  await fs.rm(dir, { recursive: true, force: true });
});

test('a corrupt lock file is treated as stale and taken over', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'db.lock'), 'not-json');
  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  await db.set('a', '1');
  assert.equal(db.get('a'), '1');
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('a lock file with a non-numeric pid is treated as stale', async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, 'db.lock'), JSON.stringify({ pid: 'abc' }));
  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  assert.equal(db.readOnly, false);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('LockFile release/releaseSync are no-ops when not held', async () => {
  const dir = await tmpDir();
  const lock = new LockFile(path.join(dir, 'db.lock'));
  await assert.doesNotReject(() => lock.release());
  assert.doesNotThrow(() => lock.releaseSync());
  await fs.rm(dir, { recursive: true, force: true });
});

// --- snapshot / compaction edge cases --------------------------------------

test('compacting an empty database produces an empty snapshot and keeps data intact', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
  await db.compact(); // empty store -> flushBatch early-return
  assert.equal(db.stats.compactions, 1);
  const snap = await fs.stat(path.join(dir, 'db.snapshot'));
  assert.equal(snap.size, 0);
  await db.close();

  db = await MiniDb.open({ dir, valueCodec: 'string' });
  assert.equal(db.size, 0);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('a second concurrent compact() reuses the in-flight compaction', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
  for (let i = 0; i < 100; i++) await db.set(`k${i}`, `v${i}`);
  const p1 = db.compact();
  const p2 = db.compact(); // compacting === true -> early-returns, reusing the in-flight work
  // (compact is `async`, so each call wraps the shared _compactDone in a fresh
  //  promise; the guard is what prevents a second compaction from running.)
  await Promise.all([p1, p2]);
  assert.equal(db.stats.compactions, 1);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// --- key validation --------------------------------------------------------

test('set rejects an empty key', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  await assert.rejects(() => db.set('', 'v'), /key must be non-empty/);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('batch rejects an empty key', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  await assert.rejects(() => db.batch([{ op: 'set', key: '', value: 'v' }]), /key must be non-empty/);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// --- index lookup errors ---------------------------------------------------

test('findEq / findRange on a missing index throw', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  assert.throws(() => db.findEq('nope', 'x'), /no such index/);
  assert.throws(() => db.findRange('nope', {}), /no such index/);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('compoundRange on a missing index throws', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  assert.throws(() => db.compoundRange('nope', 'g'), /no such compound index/);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// --- RESP error reply ------------------------------------------------------

test('RESP server replies with -ERR when a command throws', async () => {
  const dir = await tmpDir();
  const srv = await startServer({ dir, port: 0, fsyncPolicy: 'no' });
  try {
    const sock = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(srv.port, '127.0.0.1');
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    const r = await new Promise<string>((resolve) => {
      sock.once('data', (d) => resolve(d.toString()));
      // 129-byte key exceeds MAX_KEY_LEN -> db.set throws -> server replies -ERR.
      const key = 'x'.repeat(129);
      sock.write(`*3\r\n$3\r\nSET\r\n$${key.length}\r\n${key}\r\n$1\r\nv\r\n`);
    });
    assert.ok(r.startsWith('-ERR'), r);
    sock.end();
  } finally {
    await srv.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
