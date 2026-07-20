// test/recovery.test.js
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';
import { HEADER_SIZE, CRC_SIZE } from '../src/codec.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-recover-'));
}

// Each record: key='kN'(2B), value='vN'(2B), no meta -> 22+2+2+0+4 = 30 bytes
const FRAME = HEADER_SIZE + 2 + 2 + 0 + CRC_SIZE;

async function writeFive(dir) {
  const db = await MiniDb.open({ dir, valueCodec: 'string', fsyncPolicy: 'always', autoCompact: false });
  for (let i = 0; i < 5; i++) await db.set(`k${i}`, `v${i}`);
  await db.close();
}

test('resync: a single corrupt frame mid-file only loses that frame', async () => {
  const dir = await tmpDir();
  try {
    await writeFive(dir);
    const walPath = path.join(dir, 'db.wal');
    const buf = await fs.readFile(walPath);
    assert.equal(buf.length, FRAME * 5);

    // Corrupt k2's value (frame at offset 2*FRAME; value starts after header+key).
    buf[2 * FRAME + HEADER_SIZE + 2] ^= 0xff;
    await fs.writeFile(walPath, buf);

    const db = await MiniDb.open({ dir, valueCodec: 'string', recovery: 'resync' });
    assert.equal(db.recoveryInfo.corruptRanges.length, 1);
    assert.deepEqual(db.recoveryInfo.corruptRanges[0], [2 * FRAME, 3 * FRAME]);
    assert.equal(db.recoveryInfo.lostBytes, FRAME);

    // k2 lost, everything else recovered.
    assert.equal(db.get('k0'), 'v0');
    assert.equal(db.get('k1'), 'v1');
    assert.equal(db.get('k2'), undefined);
    assert.equal(db.get('k3'), 'v3');
    assert.equal(db.get('k4'), 'v4');
    assert.equal(db.size, 4);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resync: multiple corrupt frames are each skipped', async () => {
  const dir = await tmpDir();
  try {
    await writeFive(dir);
    const walPath = path.join(dir, 'db.wal');
    const buf = await fs.readFile(walPath);
    buf[1 * FRAME + HEADER_SIZE + 2] ^= 0xff; // k1
    buf[3 * FRAME + HEADER_SIZE + 2] ^= 0xff; // k3
    await fs.writeFile(walPath, buf);

    const db = await MiniDb.open({ dir, valueCodec: 'string' });
    assert.equal(db.recoveryInfo.corruptRanges.length, 2);
    assert.deepEqual(
      [...new Set(['k0', 'k1', 'k2', 'k3', 'k4'].filter((k) => db.get(k) !== undefined))].sort(),
      ['k0', 'k2', 'k4'],
    );
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('resync: torn tail is still truncated', async () => {
  const dir = await tmpDir();
  try {
    await writeFive(dir);
    const walPath = path.join(dir, 'db.wal');
    const valid = await fs.readFile(walPath);
    // append a half-written frame
    await fs.appendFile(walPath, valid.subarray(0, 11));

    const db = await MiniDb.open({ dir, valueCodec: 'string' });
    assert.equal(db.recoveryInfo.truncatedWal, true);
    assert.equal(db.size, 5);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('strict mode truncates at the first bad frame', async () => {
  const dir = await tmpDir();
  try {
    await writeFive(dir);
    const walPath = path.join(dir, 'db.wal');
    const buf = await fs.readFile(walPath);
    buf[2 * FRAME + HEADER_SIZE + 2] ^= 0xff; // corrupt k2
    await fs.writeFile(walPath, buf);

    const db = await MiniDb.open({ dir, valueCodec: 'string', recovery: 'strict' });
    // strict recovers k0,k1 then stops at k2; k3,k4 are NOT recovered.
    assert.equal(db.get('k0'), 'v0');
    assert.equal(db.get('k1'), 'v1');
    assert.equal(db.size, 2);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// catchUpFromWal: a read-only replica applies only the WAL frames appended
// after its watermark; the result must be identical to a from-scratch replay
// (store, dt, compound, secondary, unique and text indexes alike).
for (const valueMode of ['memory', 'disk'] as const) {
  test(`catchUpFromWal (${valueMode}): mixed tail applies identically to a full reopen`, { timeout: 60_000 }, async () => {
    const dir = await tmpDir();
    try {
      const doc = (i: number) => ({ n: i, c: `c${i % 7}`, u: `u${i}`, t: `alpha beta w${i % 13}` });
      const writer = await MiniDb.open<Record<string, unknown>>({
        dir,
        valueCodec: 'json',
        valueMode,
        fsyncPolicy: 'no',
        autoCompact: false,
      });
      await writer.createIndex('c', { field: 'c' });
      await writer.createIndex('n', { field: 'n', type: 'range' });
      await writer.createIndex('u', { field: 'u', unique: true });
      await writer.createTextIndex('t', { fields: ['t'] });
      await writer.createCompoundIndex('cg', { groupBy: 'c', orderBy: 'n' });
      for (let i = 0; i < 2000; i++) await writer.set(`pre:${i}`, doc(i), { dt: { created: 1700000000000 + i } });

      const reader = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', valueMode, readOnly: true });
      const ri = reader.recoveryInfo!;
      assert.ok(ri.walScanEnd > 0);
      assert.ok(ri.walIno !== 0);

      // Mixed storm: updates, new sets, dels, one BATCH frame, short/long TTL,
      // dt-only change. 500 + 500 + 300 + 1 + 2 = 1303 appended frames.
      for (let i = 1500; i < 2000; i++) {
        await writer.set(`pre:${i}`, { ...doc(i), n: i * 10, t: `alpha changed w${i % 13}` }, { dt: { created: 1700000009000 + i } });
      }
      for (let i = 0; i < 500; i++) await writer.set(`s:${i}`, { ...doc(i), u: `us${i}` }, { dt: { created: 1700001000000 + i } });
      for (let i = 0; i < 1500; i += 5) await writer.del(`pre:${i}`);
      await writer.batch([
        { op: 'set', key: 's:b1', value: doc(9001), dt: { created: 1700002000000 } },
        { op: 'set', key: 's:b2', value: { ...doc(9002), t: 'alpha batch' } },
        { op: 'del', key: 's:b1' },
      ]);
      await writer.set('s:short', doc(9100), { ttl: 1 });
      await writer.set('s:long', doc(9101), { ttl: 3_600_000 });

      const res = await reader.catchUpFromWal(ri.walScanEnd);
      assert.ok(res, 'clean watermark must catch up');
      assert.equal(res.appliedFrames, 1303);
      assert.ok(res.offset > ri.walScanEnd);

      // Reference: a full from-scratch replay of the same files.
      const ref = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', valueMode, readOnly: true });
      const sortByKey = (a: { key: string }, b: { key: string }): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      assert.equal(reader.size, ref.size);
      assert.deepEqual(reader.scan(), ref.scan());
      assert.deepEqual(reader.dtColumns(), ref.dtColumns());
      assert.deepEqual(reader.findEq('c', 'c3').sort(sortByKey), ref.findEq('c', 'c3').sort(sortByKey));
      assert.deepEqual(reader.findEq('u', 'u1700'), ref.findEq('u', 'u1700'));
      assert.deepEqual(
        reader.findRange('n', { min: 100, max: 500 }).sort(sortByKey),
        ref.findRange('n', { min: 100, max: 500 }).sort(sortByKey),
      );
      assert.deepEqual(reader.dtRange('created', { gte: 1700000009000, limit: 20 }), ref.dtRange('created', { gte: 1700000009000, limit: 20 }));
      assert.deepEqual(reader.compoundRange('cg', 'c2', { limit: 25 }), ref.compoundRange('cg', 'c2', { limit: 25 }));
      assert.deepEqual(reader.search('t', 'alpha'), ref.search('t', 'alpha'));
      assert.deepEqual(reader.search('t', 'changed'), ref.search('t', 'changed'));
      assert.deepEqual(reader.search('t', 'batch'), ref.search('t', 'batch'));
      assert.equal(reader.get('s:short'), undefined);
      assert.equal(ref.get('s:short'), undefined);
      assert.deepEqual(reader.get('s:long'), ref.get('s:long'));

      // No new writes: catch-up is a cheap no-op at the same offset.
      assert.deepEqual(await reader.catchUpFromWal(res.offset), { offset: res.offset, appliedFrames: 0 });
      // Not a frame boundary (byte 3 of the first frame's header: flags=0).
      assert.equal(await reader.catchUpFromWal(3), null);

      await ref.close();
      await reader.close();
      await writer.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}
