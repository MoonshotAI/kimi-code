// test/batch.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-batch-'));
}

test('batch applies multiple ops atomically', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  try {
    await db.batch([
      { op: 'set', key: 'a', value: { n: 1 } },
      { op: 'set', key: 'b', value: { n: 2 } },
      { op: 'del', key: 'a' },
    ]);
    assert.equal(db.get('a'), undefined);
    assert.deepEqual(db.get('b'), { n: 2 });
    assert.equal(db.size, 1);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('batch with dt + indexes updates everything', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createIndex('byCity', { field: 'city' });
  try {
    await db.batch([
      { op: 'set', key: 'u1', value: { city: 'Paris' }, dt: { created: 100 } },
      { op: 'set', key: 'u2', value: { city: 'Paris' }, dt: { created: 200 } },
    ]);
    assert.deepEqual(db.findEq('byCity', 'Paris').map((r) => r.key).sort(), ['u1', 'u2']);
    assert.deepEqual(db.dtRange('created', { gte: 100 }).map((r) => r.key).sort(), ['u1', 'u2']);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('batch unique violation rejects the whole batch', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  await db.createIndex('byEmail', { field: 'email', unique: true });
  await db.set('a', { email: 'x@y.com' });
  try {
    await assert.rejects(
      () => db.batch([{ op: 'set', key: 'b', value: { email: 'ok@y.com' } }, { op: 'set', key: 'c', value: { email: 'x@y.com' } }]),
      /unique/,
    );
    // neither op applied
    assert.equal(db.get('b'), undefined);
    assert.equal(db.get('c'), undefined);
    assert.equal(db.size, 1);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('batch is atomic on recovery: a corrupt batch frame skips the whole batch', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'always', autoCompact: false });
    await db.set('before', { v: 0 });
    await db.batch([
      { op: 'set', key: 'x', value: { v: 1 } },
      { op: 'set', key: 'y', value: { v: 2 } },
    ]);
    await db.set('after', { v: 3 });
    await db.close();

    // Corrupt the batch frame (the 2nd frame, between 'before' and 'after').
    const wal = path.join(dir, 'db.wal');
    const buf = await fs.readFile(wal);
    const magic = Buffer.from([0x4d, 0x44]);
    const second = buf.indexOf(magic, buf.indexOf(magic) + 1); // start of batch frame
    buf[second + 30] ^= 0xff; // flip a byte inside the batch body -> bad crc
    await fs.writeFile(wal, buf);

    db = await MiniDb.open({ dir, valueCodec: 'json', recovery: 'resync' });
    assert.equal(db.get('before').v, 0, 'before survives');
    // the batch is either fully skipped or (if resync lands inside) neither x nor y appears
    // — but it must NEVER be the case that only one of x/y is present.
    const x = db.get('x');
    const y = db.get('y');
    assert.ok(!(x !== undefined && y === undefined), 'batch must not be half-applied (x only)');
    assert.ok(!(x === undefined && y !== undefined), 'batch must not be half-applied (y only)');
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('empty batch is a no-op', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  try {
    await db.batch([]);
    assert.equal(db.size, 0);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
