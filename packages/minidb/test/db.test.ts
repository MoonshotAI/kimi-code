// test/db.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';
import { encodeFrame, TYPE_SET } from '../src/codec.js';

const B = (s) => Buffer.from(s);

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-db-'));
}

test('set/get persists across reopen (string codec)', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'everysec' });
    await db.set('a', '1');
    await db.set('b', '2');
    assert.equal(db.get('a'), '1');
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string' });
    assert.equal(db.get('a'), '1');
    assert.equal(db.get('b'), '2');
    assert.equal(db.size, 2);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('del persists across reopen', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    await db.set('x', '1');
    await db.set('y', '2');
    await db.del('x');
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string' });
    assert.equal(db.get('x'), undefined);
    assert.equal(db.get('y'), '2');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('json codec round-trips values', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.set('obj', { a: 1, b: [2, 3] });
    await db.close();
    db = await MiniDb.open({ dir, valueCodec: 'json' });
    assert.deepEqual(db.get('obj'), { a: 1, b: [2, 3] });
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ttl / expire', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'string', activeExpireIntervalMs: 0 });
    await db.set('t', 'v', { ttl: 50 });
    assert.ok(db.ttl('t') > 0 && db.ttl('t') <= 50);
    assert.equal(db.ttl('nope'), -2);
    await db.expire('t', 1000);
    assert.ok(db.ttl('t') > 50);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('recovery truncates a torn WAL tail and keeps valid data', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    for (let i = 0; i < 100; i++) await db.set(`k${i}`, `v${i}`);
    await db.close();

    // Append a half-written frame to simulate a crash mid-write.
    const walPath = path.join(dir, 'db.wal');
    const partial = encodeFrame({ type: TYPE_SET, key: B('torn'), value: B('x'.repeat(200)) }).subarray(0, 11);
    await fs.appendFile(walPath, partial);

    db = await MiniDb.open({ dir, valueCodec: 'string' });
    assert.equal(db.recoveryInfo.truncatedWal, true);
    assert.equal(db.size, 100);
    assert.equal(db.get('k0'), 'v0');
    assert.equal(db.get('k99'), 'v99');
    await db.close();

    // The torn tail is gone for good.
    const reopened = await MiniDb.open({ dir, valueCodec: 'string' });
    assert.equal(reopened.recoveryInfo.truncatedWal, false);
    assert.equal(reopened.size, 100);
    await reopened.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('maxMemory reject policy blocks writes over budget', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'string', maxMemoryBytes: 50, maxMemoryPolicy: 'reject' });
    await db.set('a', '1234567890');
    await db.set('b', '1234567890');
    await db.set('c', '1234567890');
    await db.set('d', '1234567890');
    await assert.rejects(() => db.set('e', '1234567890'), /maxMemory exceeded/);
    assert.equal(db.get('e'), undefined);
    assert.ok(db.stats.maxMemoryRejections >= 1);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('maxMemory evict-lru evicts old keys to make room', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'string', maxMemoryBytes: 50, maxMemoryPolicy: 'evict-lru' });
    await db.set('a', '1234567890');
    await db.set('b', '1234567890');
    await db.set('c', '1234567890');
    await db.set('d', '1234567890');
    assert.equal(db.get('a'), '1234567890'); // touch a; b becomes the LRU victim
    await db.set('e', '1234567890');
    assert.equal(db.get('a'), '1234567890');
    assert.equal(db.get('b'), undefined);
    assert.equal(db.get('e'), '1234567890');
    assert.ok(db.stats.evictions >= 1);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('backup + restore preserves data, indexes, and text search', async () => {
  const dir = await tmpDir();
  const backupDir = await tmpDir();
  const restoreDir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createIndex('byCity', { field: 'city' });
    await db.createTextIndex('body', { fields: ['body'] });
    await db.set('a', { city: 'Paris', body: 'hello world' });
    await db.set('b', { city: 'London', body: 'hello London' });
    await db.backup(backupDir);
    await db.close();

    const restored = await MiniDb.restore(backupDir, restoreDir, { valueCodec: 'json' });
    assert.deepEqual(restored.get('a'), { city: 'Paris', body: 'hello world' });
    assert.deepEqual(restored.findEq('byCity', 'London').map((r) => r.key), ['b']);
    assert.deepEqual(restored.search('body', 'hello').map((r) => r.key).sort(), ['a', 'b']);
    await restored.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(backupDir, { recursive: true, force: true });
    await fs.rm(restoreDir, { recursive: true, force: true });
  }
});

test('valueMode disk stores value pointers and reads from WAL', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', valueMode: 'disk', fsyncPolicy: 'no' });
    const big = 'x'.repeat(1000);
    await db.set('a', big);
    const rec = db.store.map.get('a');
    assert.equal(rec?.ref.kind, 'disk');
    assert.equal(rec?.ref.kind === 'disk' && rec.ref.loc.file, 'wal');
    assert.equal(db.get('a'), big);
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string', valueMode: 'disk' });
    const rec2 = db.store.map.get('a');
    assert.equal(rec2?.ref.kind, 'disk');
    assert.equal(db.get('a'), big);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('valueMode disk batch stores value pointers and survives reopen', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', valueMode: 'disk', fsyncPolicy: 'no' });
    await db.batch([
      { op: 'set', key: 'a', value: '1'.repeat(100) },
      { op: 'set', key: 'b', value: '2'.repeat(100) },
    ]);
    assert.equal(db.store.map.get('a')?.ref.kind, 'disk');
    assert.equal(db.store.map.get('b')?.ref.kind, 'disk');
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string', valueMode: 'disk' });
    assert.equal(db.get('a'), '1'.repeat(100));
    assert.equal(db.get('b'), '2'.repeat(100));
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('valueMode disk compaction remaps pointers to the snapshot', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', valueMode: 'disk', fsyncPolicy: 'no' });
    await db.set('a', '1'.repeat(1000));
    await db.set('b', '2'.repeat(1000));
    await db.compact();
    const rec = db.store.map.get('a');
    assert.equal(rec?.ref.kind, 'disk');
    assert.equal(rec?.ref.kind === 'disk' && rec.ref.loc.file, 'snapshot');
    assert.equal(db.get('a'), '1'.repeat(1000));
    assert.equal(db.get('b'), '2'.repeat(1000));
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string', valueMode: 'disk' });
    assert.equal(db.get('a'), '1'.repeat(1000));
    assert.equal(db.get('b'), '2'.repeat(1000));
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('valueMode disk maxMemory excludes value bulk', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({
      dir,
      valueCodec: 'string',
      valueMode: 'disk',
      maxMemoryBytes: 200,
      maxMemoryPolicy: 'reject',
      fsyncPolicy: 'no',
    });
    await db.set('a', 'x'.repeat(1000));
    await db.set('b', 'y'.repeat(1000));
    await db.set('c', 'z'.repeat(1000));
    assert.equal(db.get('a'), 'x'.repeat(1000));
    assert.ok(db.store.bytes < 200);
    await assert.rejects(() => db.set('d', 'w'.repeat(1000)), /maxMemory exceeded/);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('valueMode auto selects disk when persisted files exceed maxMemoryBytes', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    await db.set('a', 'x'.repeat(1000));
    await db.close();

    const walSize = (await fs.stat(path.join(dir, 'db.wal'))).size;
    db = await MiniDb.open({
      dir,
      valueCodec: 'string',
      valueMode: 'auto',
      maxMemoryBytes: Math.max(1, walSize - 1),
      fsyncPolicy: 'no',
    });
    assert.equal(db.valueMode, 'disk');
    assert.equal(db.store.map.get('a')?.ref.kind, 'disk');
    assert.equal(db.get('a'), 'x'.repeat(1000));
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('valueMode auto selects memory when persisted files fit maxMemoryBytes', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    await db.set('a', 'x'.repeat(1000));
    await db.close();

    const walSize = (await fs.stat(path.join(dir, 'db.wal'))).size;
    db = await MiniDb.open({
      dir,
      valueCodec: 'string',
      valueMode: 'auto',
      maxMemoryBytes: walSize + 1000,
      fsyncPolicy: 'no',
    });
    assert.equal(db.valueMode, 'memory');
    assert.equal(db.store.map.get('a')?.ref.kind, 'memory');
    assert.equal(db.get('a'), 'x'.repeat(1000));
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('valueMode auto without maxMemoryBytes defaults to memory', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'no' });
    await db.set('a', 'x'.repeat(1000));
    await db.close();

    db = await MiniDb.open({ dir, valueCodec: 'string', valueMode: 'auto', fsyncPolicy: 'no' });
    assert.equal(db.valueMode, 'memory');
    assert.equal(db.store.map.get('a')?.ref.kind, 'memory');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
