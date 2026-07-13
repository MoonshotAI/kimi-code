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
import { MiniDb } from '../src/index.js';
import { startServer } from '../src/server.js';

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
  await db.set('u1', { email: 'a@x.com' });
  await db.set('u2', { email: 'b@x.com' });
  await db.batch([
    { op: 'set', key: 'u1', value: { email: 'b@x.com' } },
    { op: 'set', key: 'u2', value: { email: 'a@x.com' } },
  ]);
  assert.equal(db.get('u1')?.email, 'b@x.com');
  assert.equal(db.get('u2')?.email, 'a@x.com');
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('batch allows del(u1) + set(u2) reusing u1 unique value', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createIndex('byMail', { field: 'email', unique: true });
  await db.set('u1', { email: 'x@y.com' });
  await db.batch([
    { op: 'del', key: 'u1' },
    { op: 'set', key: 'u2', value: { email: 'x@y.com' } },
  ]);
  assert.equal(db.get('u1'), undefined);
  assert.equal(db.get('u2')?.email, 'x@y.com');
  assert.deepEqual(db.findEq('byMail', 'x@y.com').map((r) => r.key), ['u2']);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('batch still rejects genuine unique violations', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createIndex('byMail', { field: 'email', unique: true });
  await db.set('u1', { email: 'x@y.com' });
  await assert.rejects(db.batch([{ op: 'set', key: 'u2', value: { email: 'x@y.com' } }]), /unique/i);
  assert.equal(db.get('u2'), undefined);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// --- #7 createIndex(unique) rejects existing duplicates ---------------------

test('createIndex(unique) rejects existing duplicate data', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.set('a', { email: 'dup@x.com' });
  await db.set('b', { email: 'dup@x.com' });
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

test('repeated TTL updates on one key do not bloat the heap', async () => {
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
  await db.set('k', { v: 1 });
  await db.close();
  await fs.writeFile(path.join(dir, 'db.indexes.json'), '{ not valid json', 'utf8');

  let rebuilt = false;
  const db2 = await MiniDb.openOrRebuild({ dir, valueCodec: 'json' }, { onRebuild: () => (rebuilt = true) });
  assert.ok(rebuilt, 'onRebuild should be called');
  assert.equal(db2.get('k'), undefined, 'rebuilt db is empty');
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
