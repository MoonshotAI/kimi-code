// Regression tests for non-ASCII keys and read-only WAL recovery.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-r3-'));
}

test('non-ASCII key: set/get/has works (live, no restart)', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    await db.set('é', 'accent');
    await db.set('北京', 'cjk');
    await db.set('key🎉', 'emoji');
    assert.equal(db.get('é'), 'accent');
    assert.equal(db.get('北京'), 'cjk');
    assert.equal(db.get('key🎉'), 'emoji');
    assert.equal(db.has('é'), true);
    assert.equal(db.has('missing-é'), false);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('non-ASCII key survives close + reopen (WAL recovery)', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'string' });
  await db.set('北京', 'v1');
  await db.set('上海', 'v2');
  await db.close();

  db = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    assert.equal(db.get('北京'), 'v1');
    assert.equal(db.get('上海'), 'v2');
    assert.equal(db.has('北京'), true);
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('non-ASCII key survives compaction (snapshot recovery)', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({
    dir,
    valueCodec: 'string',
    compactThresholdBytes: 1,
    autoCompact: false,
  });
  await db.set('城市', 'Beijing');
  await db.set('要删除', 'gone');
  await db.del('要删除');
  await db.compact();
  await db.close();

  db = await MiniDb.open({ dir, valueCodec: 'string' });
  try {
    assert.equal(db.get('城市'), 'Beijing');
    assert.equal(db.get('要删除'), undefined, 'tombstone must survive compaction');
  } finally {
    await db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('readOnly open does not truncate a torn WAL tail', async () => {
  const dir = await tmpDir();
  const walPath = path.join(dir, 'db.wal');

  let db = await MiniDb.open({ dir, valueCodec: 'string' });
  await db.set('a', '1');
  await db.close();

  const torn = Buffer.from([0x4d, 0x44, 0x01, 0x00, 0x01, 0x00]);
  await fs.appendFile(walPath, torn);
  const sizeBefore = (await fs.stat(walPath)).size;

  db = await MiniDb.open({ dir, valueCodec: 'string', readOnly: true });
  try {
    assert.equal(db.get('a'), '1', 'valid record is still readable');
  } finally {
    await db.close();
  }
  const sizeAfter = (await fs.stat(walPath)).size;
  assert.equal(sizeAfter, sizeBefore, 'readOnly open must not truncate the WAL');
});
