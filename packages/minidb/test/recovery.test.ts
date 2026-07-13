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
