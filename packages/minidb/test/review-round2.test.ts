// Regression tests for the second deep-review round (compound-index dup,
// snapshot/WAL short-write, rollback on WAL failure, RESP binary, buffer
// aliasing, batch unique swap/del+set, unique-on-existing-dups, batch key
// length, TTL heap growth, size vs expiry, range-array, dtColumns, MSET
// atomicity, openOrRebuild scope, open-failure cleanup).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { MiniDb, UniqueViolationError } from '../src/index.js';
import { startServer } from '../src/server.js';
import { encodeBatchOps, encodeFrame, TYPE_BATCH, TYPE_SET } from '../src/codec.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-r2-'));
}

// --- #1 compound index: re-setting same group+order must not duplicate ------

test('compound index: re-set with same group+order does not duplicate', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createCompoundIndex('byWs', { groupBy: 'workspaceId', orderBy: 'updatedAt' });
  try {
    await db.set('a', { workspaceId: 'W1' }, { dt: { updatedAt: 100 } });
    await db.set('a', { workspaceId: 'W1' }, { dt: { updatedAt: 100 } });
    await db.set('a', { workspaceId: 'W1' }, { dt: { updatedAt: 100 } });
    assert.deepEqual(db.compoundRange('byWs', 'W1').map((r) => r.key), ['a']);
    await db.del('a');
    assert.deepEqual(db.compoundRange('byWs', 'W1'), []);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('compound index: becoming invalid removes the entry cleanly', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createCompoundIndex('byWs', { groupBy: 'workspaceId', orderBy: 'updatedAt' });
  try {
    await db.set('a', { workspaceId: 'W1' }, { dt: { updatedAt: 100 } });
    await db.set('a', { other: 1 }); // no workspaceId -> removed from index
    assert.deepEqual(db.compoundRange('byWs', 'W1'), []);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- #2 / #3 WAL + snapshot tolerate fragmented (short) writes --------------

test('WAL and snapshot tolerate short writes (fragmented writev)', async () => {
  const dir = await tmpDir();
  // Force every writev to write at most 11 bytes, so each frame lands in many
  // short writes. The retry loops must still deliver every byte.
  const probe = await fs.open(path.join(dir, '_probe'), 'w');
  const proto = Object.getPrototypeOf(probe) as { writev: (...a: unknown[]) => Promise<unknown> };
  await probe.close();
  await fs.rm(path.join(dir, '_probe'), { force: true });
  const orig = proto.writev;
  const CAP = 11;
  proto.writev = async function (buffers: ReadonlyArray<{ length: number; subarray: (a: number, b: number) => unknown }>, position?: number | null) {
    const first = buffers[0];
    if (!first) return orig.call(this, buffers, position);
    const n = Math.min(first.length, CAP);
    return orig.call(this, [first.subarray(0, n)], position);
  };
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'string', compactThresholdBytes: 1, autoCompact: false });
    for (let i = 0; i < 30; i++) await db.set(`k${i}`, `value-${i}-${'x'.repeat(40)}`);
    await db.compact();
    await db.set('after', 'tail');
    await db.close();

    const db2 = await MiniDb.open({ dir, valueCodec: 'string' });
    for (let i = 0; i < 30; i++) assert.equal(db2.get(`k${i}`), `value-${i}-${'x'.repeat(40)}`);
    assert.equal(db2.get('after'), 'tail');
    await db2.close();
  } finally {
    proto.writev = orig;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- #3 rollback on WAL write failure ---------------------------------------

test('set rolls back store + indexes when the WAL write fails', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'always' });
  await db.createIndex('byCity', { field: 'city' });
  await db.set('old', { city: 'Paris' });

  const fh = (db as unknown as { wal: { fh: { writev: (...a: unknown[]) => Promise<unknown> } } }).wal.fh;
  const orig = fh.writev.bind(fh);
  let boom = true;
  fh.writev = async (...a: unknown[]) => {
    if (boom) {
      boom = false;
      throw new Error('injected WAL failure');
    }
    return orig(...a);
  };

  await assert.rejects(db.set('new', { city: 'London' }), /injected/);
  assert.equal(db.get('new'), undefined, 'failed set must not be visible');
  assert.deepEqual(db.findEq('byCity', 'London'), [], 'index must not contain rolled-back key');
  // Further writes still work after the injected failure clears.
  boom = false;
  await db.set('ok', { city: 'Berlin' });
  assert.equal(db.get('ok')?.city, 'Berlin');
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('batch rolls back atomically when the WAL write fails', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'always' });
  await db.set('a', { n: 1 });

  const fh = (db as unknown as { wal: { fh: { writev: (...a: unknown[]) => Promise<unknown> } } }).wal.fh;
  const orig = fh.writev.bind(fh);
  let boom = true;
  fh.writev = async (...a: unknown[]) => {
    if (boom) {
      boom = false;
      throw new Error('injected WAL failure');
    }
    return orig(...a);
  };

  await assert.rejects(
    db.batch([
      { op: 'set', key: 'a', value: { n: 99 } },
      { op: 'set', key: 'b', value: { n: 2 } },
    ]),
    /injected/,
  );
  assert.deepEqual(db.get('a'), { n: 1 }, 'a must be restored to pre-batch value');
  assert.equal(db.get('b'), undefined, 'b must not exist');
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// --- #4 RESP server is binary-safe for non-ASCII values ---------------------

test('RESP GET returns correct UTF-8 bulk for non-ASCII values', async () => {
  const dir = await tmpDir();
  const { port, close } = await startServer({ dir, port: 0 });
  try {
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1');
      const chunks: Buffer[] = [];
      sock.on('data', (c) => chunks.push(c));
      sock.on('connect', () => {
        const v = Buffer.from('北京', 'utf8');
        const set = `*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$${v.length}\r\n`;
        sock.write(Buffer.concat([Buffer.from(set, 'binary'), v, Buffer.from('\r\n')]));
        setTimeout(() => sock.write('GET k\r\n'), 50);
        setTimeout(() => sock.end(), 150);
      });
      sock.on('end', () => resolve(Buffer.concat(chunks)));
      sock.on('error', reject);
    });
    const expected = Buffer.concat([Buffer.from('$6\r\n', 'binary'), Buffer.from('北京', 'utf8'), Buffer.from('\r\n', 'binary')]);
    assert.ok(raw.includes(expected), `expected bulk reply, got ${JSON.stringify(raw.toString('binary'))}`);
  } finally {
    await close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- #5 buffer codec get returns an independent copy ------------------------

test('buffer codec: mutating a returned value does not corrupt the store', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'buffer' });
  await db.set('k', Buffer.from('hello'));
  const b = db.get('k')!;
  b[0] = 0xff;
  assert.equal(db.get('k')![0], 0x68, 'stored value must be unchanged');
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// --- #6 batch unique: swaps and del+set are valid ---------------------------

test('batch allows swapping a unique value between two keys', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createIndex('byMail', { field: 'email', unique: true });
  await db.set('u1', { email: 'alice@example.test' });
  await db.set('u2', { email: 'bob@example.test' });
  await db.batch([
    { op: 'set', key: 'u1', value: { email: 'bob@example.test' } },
    { op: 'set', key: 'u2', value: { email: 'alice@example.test' } },
  ]);
  assert.equal(db.get('u1')?.email, 'bob@example.test');
  assert.equal(db.get('u2')?.email, 'alice@example.test');
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('batch allows del(u1) + set(u2) reusing u1 unique value', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createIndex('byMail', { field: 'email', unique: true });
  await db.set('u1', { email: 'shared@example.test' });
  await db.batch([
    { op: 'del', key: 'u1' },
    { op: 'set', key: 'u2', value: { email: 'shared@example.test' } },
  ]);
  assert.equal(db.get('u1'), undefined);
  assert.equal(db.get('u2')?.email, 'shared@example.test');
  assert.deepEqual(db.findEq('byMail', 'shared@example.test').map((r) => r.key), ['u2']);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('batch still rejects genuine unique violations', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createIndex('byMail', { field: 'email', unique: true });
  await db.set('u1', { email: 'duplicate@example.test' });
  await assert.rejects(db.batch([{ op: 'set', key: 'u2', value: { email: 'duplicate@example.test' } }]), /unique/i);
  assert.equal(db.get('u2'), undefined);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// --- #7 createIndex(unique) rejects existing duplicates ---------------------

test('createIndex(unique) rejects existing duplicate data', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.set('a', { email: 'duplicate@example.test' });
  await db.set('b', { email: 'duplicate@example.test' });
  await assert.rejects(db.createIndex('byMail', { field: 'email', unique: true }), /unique/i);
  assert.equal(db.listIndexes().length, 0, 'index must not persist after failed create');
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// --- #8 batch/mset enforce key length ---------------------------------------

test('batch rejects keys longer than 128 chars', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  const longKey = 'k'.repeat(200);
  await assert.rejects(db.batch([{ op: 'set', key: longKey, value: { v: 1 } }]), /key too long/i);
  assert.equal(db.get(longKey), undefined);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// --- #9 TTL heap does not grow unboundedly ----------------------------------

test('repeated TTL updates on one key do not bloat the heap', { timeout: 30_000 }, async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string', activeExpireIntervalMs: 0 });
  for (let i = 0; i < 5000; i++) await db.set('k', 'v', { ttl: 1_000_000 });
  const heapSize = (db as unknown as { store: { heap: { size: number } } }).store.heap.size;
  assert.ok(heapSize < 100, `heap should stay small, got ${heapSize}`);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// --- #10 size excludes expired keys -----------------------------------------

test('size excludes expired-but-not-yet-reaped keys', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string', activeExpireIntervalMs: 0 });
  await db.set('e', 'v', { ttl: 1 });
  await db.set('s', 'ok');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(db.size, 1);
  assert.equal(db.scan().length, 1);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// --- #11 range index indexes array fields per element -----------------------

test('range index indexes array fields per element', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createIndex('byScore', { field: 'scores', type: 'range' });
  await db.set('a', { scores: [10, 20, 30] });
  await db.set('b', { scores: [25] });
  const r = db.findRange('byScore', { min: 0, max: 100 });
  assert.equal(r.length, 4, `expected 4 indexed elements, got ${r.length}`);
  assert.deepEqual(db.findRange('byScore', { min: 20, max: 20 }).map((x) => x.key), ['a']);
  // update removes old elements
  await db.set('a', { scores: [99] });
  assert.deepEqual(db.findRange('byScore', { min: 10, max: 30 }).map((x) => x.key), ['b']);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// --- #12 dtColumns drops emptied columns ------------------------------------

test('dtColumns drops columns that no record has anymore', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.set('a', { v: 1 }, { dt: { created: 100 } });
  await db.del('a');
  assert.deepEqual(db.dtColumns(), []);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// --- #13 RESP MSET sets all keys (atomic via batch) -------------------------

test('RESP MSET sets all keys', async () => {
  const dir = await tmpDir();
  const { port, close } = await startServer({ dir, port: 0 });
  try {
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1');
      const chunks: Buffer[] = [];
      sock.on('data', (c) => chunks.push(c));
      sock.on('connect', () => {
        sock.write('MSET a 1 b 2 c 3\r\n');
        setTimeout(() => sock.write('GET a\r\nGET b\r\nGET c\r\n'), 40);
        setTimeout(() => sock.end(), 140);
      });
      sock.on('end', () => resolve(Buffer.concat(chunks)));
      sock.on('error', reject);
    });
    const s = raw.toString('binary');
    assert.ok(s.includes('+OK'));
    assert.ok(s.includes('$1\r\n1\r\n'));
    assert.ok(s.includes('$1\r\n2\r\n'));
    assert.ok(s.includes('$1\r\n3\r\n'));
  } finally {
    await close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// --- #14 openOrRebuild only rebuilds on corruption --------------------------

test('openOrRebuild rebuilds on corrupt index-definition JSON', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createIndex('byV', { field: 'v' });
  await db.set('k', { v: 1 });
  await db.close();
  await fs.writeFile(path.join(dir, 'db.indexes.json'), '{ not valid json', 'utf8');

  let rebuilt = false;
  const db2 = await MiniDb.openOrRebuild({ dir, valueCodec: 'json' }, { onRebuild: () => (rebuilt = true) });
  assert.ok(rebuilt, 'onRebuild should be called');
  // the corrupt sidecar (derived state) is dropped; the data is preserved
  assert.deepEqual(db2.get('k'), { v: 1 });
  assert.deepEqual(db2.listIndexes(), []);
  await db2.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// --- #15 open failure releases resources (lock usable again) ----------------

test('open failure on corrupt index JSON releases the lock', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.set('k', { v: 1 });
  await db.close();
  await fs.writeFile(path.join(dir, 'db.indexes.json'), '{ not valid json', 'utf8');

  await assert.rejects(MiniDb.open({ dir, valueCodec: 'json' }), /JSON|Unexpected/i);
  // Lock must be released so a subsequent open can proceed. Remove the corrupt
  // definition file so recovery can continue from the snapshot/WAL.
  await fs.rm(path.join(dir, 'db.indexes.json'), { force: true });
  const db2 = await MiniDb.open({ dir, valueCodec: 'json' });
  assert.equal(db2.get('k')?.v, 1, 'data intact after failed open');
  await db2.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// --- WAL poison / flush-group rollback (write-failure semantics) ------------
//
// Fault-injection assertions for the commit point: a failed WAL write/fsync
// poisons the WAL, the failed frames are physically truncated away (in-place
// recovery), every touched flush group rolls back to its pre-group records,
// and later writes queue behind the recovery instead of hitting the poisoned
// WAL. All synchronization is barrier-driven (in-flight writev gates,
// condition polling, the recovery gate inside every commit) — no fixed sleeps
// on the assertion path.

type WalFh = { writev: (...a: unknown[]) => Promise<unknown>; sync: () => Promise<void> };

function walFh(db: MiniDb<unknown>): WalFh {
  return (db as unknown as { wal: { fh: WalFh } }).wal.fh;
}

/** One-shot writev failure on the live WAL's append handle. */
function failNextWritev(db: MiniDb<unknown>): void {
  const fh = walFh(db);
  const orig = fh.writev.bind(fh);
  let fail = true;
  fh.writev = async (...a: unknown[]) => {
    if (fail) {
      fail = false;
      throw new Error('injected WAL failure');
    }
    return orig(...a);
  };
}

/** Condition-driven barrier (not a fixed sleep): poll until `cond` holds. */
async function waitFor(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const MEM_OPTS = { valueCodec: 'string' as const, fsyncPolicy: 'no' as const, activeExpireIntervalMs: 0 };

test('WAL poison: a failed writev is truncated away — the rejected key never reappears and later writes stay consistent (disk mode)', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open<string>({ dir, ...MEM_OPTS, valueMode: 'disk' });
  failNextWritev(db as MiniDb<unknown>);

  const err: Error = await db.set('failed', 'not-written').then(
    () => {
      throw new Error('expected the set to reject');
    },
    (e) => e as Error,
  );
  assert.match(String(err), /injected WAL failure/);
  assert.equal((err as { ambiguous?: boolean }).ambiguous, true, 'a failure past the commit point is marked ambiguous');
  assert.equal(db.get('failed'), undefined, 'the group rollback hides the rejected write in-memory');
  assert.equal(db.stats.walWriteErrors, 1, 'writev-class failure counted');
  assert.equal(db.stats.walFsyncErrors, 0);

  // The next write queues behind the in-place recovery, then lands at the
  // real EOF: disk-mode get() must not short-read a stale predicted offset.
  await db.set('ok', 'persisted');
  assert.equal(db.get('ok'), 'persisted');
  await db.close();

  db = await MiniDb.open<string>({ dir, ...MEM_OPTS, valueMode: 'disk' });
  assert.equal(db.get('failed'), undefined, 'rejected write must not reappear after reopen');
  assert.equal(db.get('ok'), 'persisted');
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('WAL poison: a half-written group is fully revoked — in-memory and reopen agree that both keys are absent', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open<string>({ dir, ...MEM_OPTS });
  const fh = walFh(db as MiniDb<unknown>);
  const orig = fh.writev.bind(fh);
  let calls = 0;
  fh.writev = async (bufs: unknown[]) => {
    calls++;
    // Both sets coalesce into one group commit: land only the first frame,
    // then fail the remainder of the batch.
    if (calls === 1) return orig([bufs[0]]);
    throw new Error('injected after first frame');
  };

  const results = await Promise.allSettled([db.set('first', 'should-fail'), db.set('second', 'should-fail')]);
  assert.deepEqual(
    results.map((r) => r.status),
    ['rejected', 'rejected'],
  );
  assert.equal(db.get('first'), undefined, 'in-memory state must match what reopen replays');
  assert.equal(db.get('second'), undefined);
  await db.close();

  db = await MiniDb.open<string>({ dir, ...MEM_OPTS });
  assert.equal(db.get('first'), undefined, 'the half-written frame was truncated by the in-place recovery');
  assert.equal(db.get('second'), undefined);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("WAL poison: an fsync failure (fsyncPolicy 'always') revokes the rejected write — no reappears after reopen", async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open<string>({ dir, valueCodec: 'string', fsyncPolicy: 'always', activeExpireIntervalMs: 0 });
  const fh = walFh(db as MiniDb<unknown>);
  const origSync = fh.sync.bind(fh);
  let fail = true;
  fh.sync = async () => {
    if (fail) {
      fail = false;
      throw new Error('injected fsync failure');
    }
    return origSync();
  };

  const err: Error = await db.set('rejected', 'reappears').then(
    () => {
      throw new Error('expected the set to reject');
    },
    (e) => e as Error,
  );
  assert.match(String(err), /injected fsync failure/);
  assert.equal((err as { ambiguous?: boolean }).ambiguous, true);
  assert.equal(db.get('rejected'), undefined);
  assert.equal(db.stats.walFsyncErrors, 1, 'fsync-class failure counted separately');
  assert.equal(db.stats.walWriteErrors, 0, 'not a writev-class failure');
  await db.close();

  db = await MiniDb.open<string>({ dir, valueCodec: 'string', fsyncPolicy: 'always', activeExpireIntervalMs: 0 });
  assert.equal(db.get('rejected'), undefined, 'rejected write must not reappear after reopen');
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('WAL poison: same-key ops failing in one group restore the pre-group value; a cross-group failure keeps the committed value', async () => {
  // Same group: A and B share the failed batch — the key rolls back to 'old'
  // (never the never-committed intermediate A).
  const dir1 = await tmpDir();
  let db = await MiniDb.open<string>({ dir: dir1, ...MEM_OPTS });
  await db.set('k', 'old');
  failNextWritev(db as MiniDb<unknown>);
  const results = await Promise.allSettled([db.set('k', 'A'), db.set('k', 'B')]);
  assert.deepEqual(
    results.map((r) => r.status),
    ['rejected', 'rejected'],
  );
  assert.equal(db.get('k'), 'old', 'group rollback restores the pre-group value, not an intermediate one');
  await db.close();
  db = await MiniDb.open<string>({ dir: dir1, ...MEM_OPTS });
  assert.equal(db.get('k'), 'old', 'reopen agrees with the in-memory state');
  await db.close();
  await fs.rm(dir1, { recursive: true, force: true });

  // Different groups: A commits in its own batch, B's later batch fails — the
  // key stays 'A' in-memory and after reopen.
  const dir2 = await tmpDir();
  db = await MiniDb.open<string>({ dir: dir2, ...MEM_OPTS });
  await db.set('k', 'A');
  failNextWritev(db as MiniDb<unknown>);
  await assert.rejects(db.set('k', 'B'), /injected WAL failure/);
  assert.equal(db.get('k'), 'A', 'a failed later group must not roll back a committed value');
  await db.close();
  db = await MiniDb.open<string>({ dir: dir2, ...MEM_OPTS });
  assert.equal(db.get('k'), 'A');
  await db.close();
  await fs.rm(dir2, { recursive: true, force: true });
});

test('WAL poison: an applyOp contract violation poisons the WAL and rolls the group back — no half-commit anywhere', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open<{ t: string }>({ dir, valueCodec: 'json', fsyncPolicy: 'no', activeExpireIntervalMs: 0 });
  await db.createTextIndex('ft', { fields: ['t'] });
  // Stage 11: applyOp's text-index entry point is addPrepared (pre-validated
  // tokens); breaking its must-not-throw contract exercises the same
  // defensive path the old ti.add injection did.
  const ti = (db as unknown as { text: Map<string, { addPrepared: (k: string, t: readonly string[]) => void }> }).text.get('ft')!;
  const origAdd = ti.addPrepared.bind(ti);
  let boom = true;
  ti.addPrepared = (k: string, t: readonly string[]) => {
    if (boom) {
      boom = false;
      throw new Error('injected apply failure');
    }
    origAdd(k, t);
  };

  const err: Error = await db.set('doc', { t: 'hello world' }).then(
    () => {
      throw new Error('expected the set to reject');
    },
    (e) => e as Error,
  );
  assert.match(String(err), /injected apply failure/);
  assert.equal((err as { ambiguous?: boolean }).ambiguous, true);
  assert.equal(db.get('doc'), undefined, 'no half-commit in the store');
  assert.deepEqual(
    db.search('ft', 'hello'),
    [],
    'no half-commit in the text index',
  );

  // The defensive poison triggers the same in-place recovery as a write
  // failure; later writes land normally.
  await db.set('after', { t: 'fine' });
  assert.equal(db.get('after')?.t, 'fine');
  await db.close();

  db = await MiniDb.open<{ t: string }>({ dir, valueCodec: 'json', fsyncPolicy: 'no', activeExpireIntervalMs: 0 });
  assert.equal(db.get('doc'), undefined, 'the half-applied write never reached disk');
  assert.equal(db.get('after')?.t, 'fine');
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('WAL poison: when the recovery truncate fails the instance is write-disabled but stays readable and closable', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open<string>({ dir, ...MEM_OPTS });
  await db.set('k', 'v');
  failNextWritev(db as MiniDb<unknown>);

  const origTruncate = fs.truncate;
  (fs as unknown as { truncate: unknown }).truncate = async () => {
    throw new Error('injected truncate failure');
  };
  try {
    await assert.rejects(db.set('bad', 'x'), /injected WAL failure/);
    await waitFor(() => db.writeDisabled !== null, 'writeDisabled to be set');
  } finally {
    (fs as unknown as { truncate: unknown }).truncate = origTruncate;
  }
  assert.match(String(db.writeDisabled), /injected truncate failure/);

  await assert.rejects(db.set('more', 'x'), /writes are disabled/);
  await assert.rejects(db.batch([{ op: 'set', key: 'b2', value: 'x' }]), /writes are disabled/);
  assert.equal(db.get('k'), 'v', 'reads keep working');
  await db.close(); // must not throw
  await fs.rm(dir, { recursive: true, force: true });
});

test('everysec background sync failure neither poisons the WAL nor rejects writes (stage-1 semantics regression)', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open<string>({ dir, valueCodec: 'string', fsyncPolicy: 'everysec', syncIntervalMs: 10, activeExpireIntervalMs: 0 });
  const fh = walFh(db as MiniDb<unknown>);
  const origSync = fh.sync.bind(fh);
  const boom = new Error('injected background fsync failure');
  fh.sync = () => Promise.reject(boom);
  try {
    // Writes are acknowledged from the page cache: the failing background
    // fsync never rejects them.
    await db.set('k', 'v');
    await waitFor(() => db.stats.walFsyncErrors >= 1, 'walFsyncErrors to be counted');
    assert.equal(db.stats.lastWalFsyncError, boom, 'sticky error is observable');
    assert.equal(db.wal.poison, null, 'a background sync failure must not poison the WAL');
    await db.set('k2', 'v2');
    assert.equal(db.get('k'), 'v');
    assert.equal(db.get('k2'), 'v2');
  } finally {
    fh.sync = origSync; // let close()'s final sync succeed
  }
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('WAL poison: an applyOp violation queued behind an in-flight batch still lets that batch commit', async () => {
  // The in-flight batch (op A) must keep its own fate when a later op's
  // applyOp violation poisons the pending queue: A commits, the poisoned op
  // is revoked, and the recovery truncates nothing of A's bytes (the
  // truncation point is the queued region's start, applied only after the
  // in-flight batch settled — no zero-extended gap on reopen).
  const dir = await tmpDir();
  let db = await MiniDb.open<{ t: string }>({ dir, valueCodec: 'json', fsyncPolicy: 'no', activeExpireIntervalMs: 0 });
  await db.createTextIndex('ft', { fields: ['t'] });

  const fh = walFh(db as MiniDb<unknown>);
  const orig = fh.writev.bind(fh);
  let releaseWritev!: () => void;
  const writevGate = new Promise<void>((r) => (releaseWritev = r));
  let writevCalls = 0;
  fh.writev = async (...a: unknown[]) => {
    writevCalls++;
    if (writevCalls === 1) await writevGate; // park A's batch mid-flight
    return orig(...a);
  };

  const opA = db.set('a', { t: 'first' });
  await waitFor(() => writevCalls === 1, "op A's writev to be in flight");

  const ti = (db as unknown as { text: Map<string, { addPrepared: (k: string, t: readonly string[]) => void }> }).text.get('ft')!;
  const origAdd = ti.addPrepared.bind(ti);
  let boom = true;
  ti.addPrepared = (k: string, t: readonly string[]) => {
    if (boom) {
      boom = false;
      throw new Error('injected apply failure');
    }
    origAdd(k, t);
  };
  await assert.rejects(db.set('b', { t: 'second' }), /injected apply failure/);
  assert.ok(db.wal.poison, 'the apply violation poisoned the pending queue');

  releaseWritev();
  await opA; // A's batch was in flight before the poison: it commits
  await waitFor(() => db.wal.poison === null, 'the in-place recovery to finish');

  assert.equal(db.get('a')?.t, 'first');
  assert.equal(db.get('b'), undefined);
  await db.set('c', { t: 'third' });
  await db.close();

  db = await MiniDb.open<{ t: string }>({ dir, valueCodec: 'json', fsyncPolicy: 'no', activeExpireIntervalMs: 0 });
  assert.equal(db.get('a')?.t, 'first', 'the committed in-flight batch survives reopen');
  assert.equal(db.get('b'), undefined);
  assert.equal(db.get('c')?.t, 'third');
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('WAL poison: an applyOp violation on a never-enqueued frame (sealed WAL) does not poison and rolls back per-op', async () => {
  // During a compaction rotation the old WAL is sealed: an op's appendLoc is
  // rejected with WAL_SEALED and the frame is NEVER enqueued. An applyOp
  // violation on such an op must not poison the WAL (the rotation can still
  // commit a new, shorter file at db.wal — a poison recorded with the old
  // file's coordinates would corrupt it during the in-place recovery); only
  // the partial in-memory mutation needs undoing.
  const dir = await tmpDir();
  let db = await MiniDb.open<{ t: string }>({ dir, valueCodec: 'json', fsyncPolicy: 'no', activeExpireIntervalMs: 0 });
  await db.createTextIndex('ft', { fields: ['t'] });
  await db.set('old', { t: 'keep' });

  const ti = (db as unknown as { text: Map<string, { addPrepared: (k: string, t: readonly string[]) => void }> }).text.get('ft')!;
  ti.addPrepared = () => {
    throw new Error('injected apply failure');
  };
  // Simulate the rotation seal (what db.wal.seal() does inside compaction).
  db.wal.seal();

  const err: Error = await db.set('bad', { t: 'x' }).then(
    () => {
      throw new Error('expected the set to reject');
    },
    (e) => e as Error,
  );
  assert.match(String(err), /injected apply failure/);
  assert.equal(db.wal.poison, null, 'a never-enqueued frame poisons nothing');
  assert.equal(db.get('bad'), undefined, 'the partial apply was undone');
  assert.equal(db.get('old')?.t, 'keep');
  assert.deepEqual(db.search('ft', 'keep').map((h) => h.key), ['old'], 'derived indexes stayed consistent');
  await db.close(); // the sealed WAL still flushes its (empty) queue and closes

  db = await MiniDb.open<{ t: string }>({ dir, valueCodec: 'json', fsyncPolicy: 'no', activeExpireIntervalMs: 0 });
  assert.equal(db.get('bad'), undefined);
  assert.equal(db.get('old')?.t, 'keep');
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('WAL poison: in-place recovery skips the truncate when the WAL file was replaced (stale coordinates)', async () => {
  // Defense-in-depth for the rotation window: a poison whose failedAtOffset
  // was recorded against the OLD file must never zero-extend the NEW, shorter
  // file that a committed rotation left at db.wal.
  const dir = await tmpDir();
  let db = await MiniDb.open<string>({ dir, ...MEM_OPTS });
  for (let i = 0; i < 10; i++) await db.set(`k${i}`, `v${i}`);
  await db.wal.flush();
  const staleOffset = (await fs.stat(path.join(dir, 'db.wal'))).size;
  assert.ok(staleOffset > 0);

  // Poison the WAL directly (no op rejection, so no recovery is kicked yet).
  db.wal.poisonPending(new Error('injected poison'));
  const poison = db.wal.poison!;
  assert.equal(poison.failedAtOffset, staleOffset);

  // Simulate a successful rotation committing a NEW, shorter WAL at the same
  // path: the recorded offset now belongs to the old file's coordinates.
  await fs.writeFile(path.join(dir, 'db.wal'), Buffer.alloc(0));

  // Drive the recovery: the stale-coordinate guard must skip the truncate —
  // zero-extending to the stale offset would corrupt the new file.
  await (db as unknown as { recoverWalInPlace(w: unknown): Promise<void> }).recoverWalInPlace(db.wal);
  assert.equal((await fs.stat(path.join(dir, 'db.wal'))).size, 0, 'the new file was not zero-extended');
  assert.equal(db.wal.poison, null, 'the poison is cleared');

  await db.set('post', 'ok');
  assert.equal(db.get('post'), 'ok');
  await db.close();
  db = await MiniDb.open<string>({ dir, ...MEM_OPTS });
  assert.equal(db.size, 1, 'only the post-recovery write is in the fresh WAL');
  assert.equal(db.get('post'), 'ok');
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('WAL poison: close() in the same tick as a failing write resolves cleanly and leaves a consistent file', async () => {
  // The WAL's final flush itself drives the queued failing batch: close()
  // must swallow the poison, wait for the recovery the op's rejection kicks,
  // and still release everything. The first writev parks so close() provably
  // begins while the failing batch is in flight.
  const dir = await tmpDir();
  let db = await MiniDb.open<string>({ dir, ...MEM_OPTS });
  const fh = walFh(db as MiniDb<unknown>);
  const orig = fh.writev.bind(fh);
  let releaseWritev!: () => void;
  const writevGate = new Promise<void>((r) => (releaseWritev = r));
  let calls = 0;
  fh.writev = async (...a: unknown[]) => {
    calls++;
    if (calls === 1) {
      await writevGate;
      throw new Error('injected WAL failure');
    }
    return orig(...a);
  };

  const op = db.set('bad', 'x');
  await waitFor(() => calls === 1, 'the failing writev to be in flight');
  const closing = db.close();
  releaseWritev();
  await assert.rejects(op, /injected WAL failure/);
  await closing; // must not throw even though the failure landed mid-close

  db = await MiniDb.open<string>({ dir, ...MEM_OPTS });
  assert.equal(db.get('bad'), undefined, 'the revoked write did not survive close+reopen');
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('backup waits out an in-flight WAL recovery instead of copying the un-acked tail', async () => {
  const dir = await tmpDir();
  const backupDir = await tmpDir();
  const restoreDir = await tmpDir();
  const db = await MiniDb.open<string>({ dir, ...MEM_OPTS });
  await db.set('k', 'v');
  failNextWritev(db as MiniDb<unknown>);

  // Park the recovery's truncate so the backup provably overlaps the
  // in-flight recovery; the backup must wait it out and re-fence.
  const origTruncate = fs.truncate;
  let releaseTruncate!: () => void;
  const truncateGate = new Promise<void>((r) => (releaseTruncate = r));
  (fs as unknown as { truncate: unknown }).truncate = async (p: unknown, len?: number) => {
    await truncateGate;
    return origTruncate(p as Parameters<typeof origTruncate>[0], len);
  };
  try {
    await assert.rejects(db.set('bad', 'x'), /injected WAL failure/);
    const backingUp = db.backup(backupDir, { compact: false });
    releaseTruncate();
    await backingUp;
  } finally {
    (fs as unknown as { truncate: unknown }).truncate = origTruncate;
  }
  assert.equal(db.get('bad'), undefined);
  await db.close();

  // The backup carries the recovered state: the acknowledged write is in,
  // the revoked one is not.
  const restored = await MiniDb.restore<string>(backupDir, restoreDir, { ...MEM_OPTS, force: true });
  assert.equal(restored.get('k'), 'v');
  assert.equal(restored.get('bad'), undefined, 'the un-acked tail never reached the backup');
  await restored.close();
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(backupDir, { recursive: true, force: true });
  await fs.rm(restoreDir, { recursive: true, force: true });
});

// --- stage 11: validation before side effects --------------------------------
//
// The write pipeline is prepare (encode + canonical + tokenize) → unique
// check → ensureMemoryFor (eviction) → commit, so a rejected write leaves the
// database untouched (review #6), and a structurally corrupt batch frame is
// skipped wholesale by recovery (review #9).

test('a unique-conflicting insert is rejected before any eviction side effect (review #6)', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({
      dir,
      valueCodec: 'json',
      fsyncPolicy: 'no',
      autoCompact: false,
      maxMemoryBytes: 190,
      maxMemoryPolicy: 'evict-lru',
    });
    await db.createIndex('u', { field: 'u', unique: true });
    await db.set('owner', { u: 'taken', pad: 'x'.repeat(20) });
    await db.set('victim', { u: 'free', pad: 'y'.repeat(20) });
    db.get('owner'); // touch: 'victim' becomes the LRU eviction candidate
    const evictionsBefore = db.stats.evictions;

    // The conflicting value fails the unique check; before stage 11 the
    // eviction ran FIRST and the rejected insert still deleted the victim.
    await assert.rejects(db.set('bad', { u: 'taken', pad: 'z'.repeat(100) }), UniqueViolationError);
    assert.equal(db.get('bad'), undefined);
    assert.ok(db.get('owner'), 'untouched keys stay');
    assert.ok(db.get('victim'), 'the failed insert must not evict the LRU victim');
    assert.equal(db.stats.evictions, evictionsBefore, 'zero side effects: no eviction ran');

    // Sanity: a LEGAL oversized write under the same budget still evicts —
    // the eviction pressure is real, only the ordering changed.
    await db.set('big', { u: 'new', pad: 'z'.repeat(100) });
    assert.ok(db.stats.evictions > evictionsBefore, 'a legal write still evicts under pressure');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** Hand-rolled batch-body encoder without encodeBatchOps' type assertion, so
 *  a test can craft a body the real encoder would never emit (review #9). */
function rawBatchBody(ops: { type: number; key: string; value?: string }[]): Buffer {
  const parts: { type: number; key: Buffer; value: Buffer }[] = [];
  let total = 2;
  for (const op of ops) {
    const key = Buffer.from(op.key);
    const value = op.value === undefined ? Buffer.alloc(0) : Buffer.from(op.value);
    total += 1 + 2 + 4 + 4 + 8 + key.length + value.length;
    parts.push({ type: op.type, key, value });
  }
  const body = Buffer.alloc(total);
  let o = 0;
  body.writeUInt16LE(parts.length, o); o += 2;
  for (const op of parts) {
    body.writeUInt8(op.type, o); o += 1;
    body.writeUInt16LE(op.key.length, o); o += 2;
    body.writeUInt32LE(op.value.length, o); o += 4;
    body.writeUInt32LE(0, o); o += 4; // metaLen
    body.writeBigInt64LE(0n, o); o += 8; // expireAt
    op.key.copy(body, o); o += op.key.length;
    op.value.copy(body, o); o += op.value.length;
  }
  return body;
}

/** Append a raw TYPE_BATCH frame (valid CRC) to a closed db's WAL and reopen:
 *  the frame's body fails strict validation, so recovery must skip the WHOLE
 *  batch — the `accepted` sub-op must not be applied (review #9). */
async function reopenWithAppendedBatch(body: Buffer): Promise<{ dir: string; db: MiniDb<string> }> {
  const dir = await tmpDir();
  let db = await MiniDb.open<string>({ dir, ...MEM_OPTS });
  await db.close();
  await fs.appendFile(path.join(dir, 'db.wal'), encodeFrame({ type: TYPE_BATCH, key: Buffer.alloc(0), value: body }));
  db = await MiniDb.open<string>({ dir, ...MEM_OPTS });
  return { dir, db };
}

test('recovery skips a batch with an unknown sub-op type wholesale (review #9)', async () => {
  const body = rawBatchBody([
    { type: TYPE_SET, key: 'accepted', value: 'yes' },
    { type: 99, key: 'unknown', value: 'ignored' },
  ]);
  const { dir, db } = await reopenWithAppendedBatch(body);
  try {
    assert.equal(db.get('accepted'), undefined, 'the whole batch is skipped, not half-applied');
    assert.equal(db.get('unknown'), undefined);
    assert.equal(db.recoveryInfo!.corruptBatches, 1, 'the skipped batch is accounted');
    // The db stays fully usable after the skip.
    await db.set('after', 'ok');
    assert.equal(db.get('after'), 'ok');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('recovery skips a batch with trailing bytes wholesale (review #9)', async () => {
  const valid = encodeBatchOps([{ type: TYPE_SET, key: Buffer.from('accepted'), value: Buffer.from('yes'), meta: null, expireAt: 0 }]);
  const body = Buffer.concat([valid, Buffer.from([0xde, 0xad])]);
  const { dir, db } = await reopenWithAppendedBatch(body);
  try {
    assert.equal(db.get('accepted'), undefined, 'trailing bytes invalidate the whole batch');
    assert.equal(db.recoveryInfo!.corruptBatches, 1);
    await db.set('after', 'ok');
    assert.equal(db.get('after'), 'ok');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a mid-batch applyOp violation rolls the whole batch back — memory and reopen agree (stage 7 group rollback)', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open<{ t: string }>({ dir, valueCodec: 'json', fsyncPolicy: 'no', activeExpireIntervalMs: 0 });
  await db.createTextIndex('ft', { fields: ['t'] });
  // Break applyOp's must-not-throw contract on the SECOND op of the batch:
  // the first op is already applied when the batch fails, and both must
  // disappear (stage 11 keeps applyOp pure; this exercises the defensive
  // poison + group rollback that remains as the backstop).
  const ti = (db as unknown as { text: Map<string, { addPrepared: (k: string, t: readonly string[]) => void }> }).text.get('ft')!;
  const origAdd = ti.addPrepared.bind(ti);
  let calls = 0;
  ti.addPrepared = (k: string, t: readonly string[]) => {
    calls++;
    if (calls === 2) throw new Error('injected mid-batch apply failure');
    origAdd(k, t);
  };

  const err: Error = await db
    .batch([
      { op: 'set', key: 'x1', value: { t: 'first' } },
      { op: 'set', key: 'x2', value: { t: 'second' } },
    ])
    .then(
      () => {
        throw new Error('expected the batch to reject');
      },
      (e) => e as Error,
    );
  assert.match(String(err), /injected mid-batch apply failure/);
  assert.equal((err as { ambiguous?: boolean }).ambiguous, true);
  assert.equal(db.get('x1'), undefined, 'the op applied before the failure is rolled back too');
  assert.equal(db.get('x2'), undefined);
  assert.deepEqual(db.search('ft', 'first'), [], 'no half-batch in the text index');
  assert.deepEqual(db.search('ft', 'second'), []);

  // Later writes land after the in-place recovery; reopen agrees with memory.
  await db.set('after', { t: 'fine' });
  await db.close();
  db = await MiniDb.open<{ t: string }>({ dir, valueCodec: 'json', fsyncPolicy: 'no', activeExpireIntervalMs: 0 });
  assert.equal(db.get('x1'), undefined, 'the revoked batch never reached disk');
  assert.equal(db.get('x2'), undefined);
  assert.equal(db.get('after')?.t, 'fine');
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});
