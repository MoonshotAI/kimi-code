// test/text-index.test.ts
//
// Larger-than-RAM full-text index: postings codec, on-disk postings file, and
// the TextIndex (delta + tombstones + disk-backed base + cache).

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';
import { TextIndex } from '../src/text-index.js';
import {
  encodePostingList,
  decodePostingList,
  encodeRecord,
  decodeRecord,
  PostingsFile,
} from '../src/text-postings.js';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-text-'));
}

// ---- codec ---------------------------------------------------------------

test('postings codec: roundtrip + delta compression', () => {
  const entries: [number, number][] = [
    [0, 1],
    [3, 2],
    [10, 5],
    [1000, 1],
    [40000, 7],
  ];
  const enc = encodePostingList(entries);
  assert.deepEqual(decodePostingList(enc), entries);
  // delta+varint should beat a naive 8 bytes/pair for dense-ish ids.
  assert.ok(enc.length < entries.length * 8, `expected compression, got ${enc.length} bytes`);
});

test('postings codec: empty list', () => {
  assert.deepEqual(decodePostingList(encodePostingList([])), []);
});

test('record frame: CRC detects corruption', () => {
  const payload = encodePostingList([
    [1, 1],
    [2, 3],
  ]);
  const rec = encodeRecord('hello', 2, payload);
  const good = decodeRecord(rec);
  assert.equal(good.term, 'hello');
  assert.equal(good.df, 2);
  assert.deepEqual(decodePostingList(good.payload), [
    [1, 1],
    [2, 3],
  ]);

  const bad = Buffer.from(rec);
  bad[2] ^= 0xff; // flip a byte inside the term
  assert.throws(() => decodeRecord(bad), /crc mismatch/);
});

// ---- PostingsFile --------------------------------------------------------

test('PostingsFile: rebuild + positioned read', async () => {
  const dir = await tmpDir();
  try {
    const p = path.join(dir, 'x.postings');
    const dict = PostingsFile.rebuildSync(p, [
      {
        term: 'hello',
        entries: [
          [0, 1],
          [5, 2],
          [9, 1],
        ],
      },
      {
        term: '北京',
        entries: [
          [1, 3],
          [2, 1],
        ],
      },
      { term: 'empty', entries: [] }, // must be skipped
    ]);
    assert.equal(dict.size, 2);
    assert.ok(!dict.has('empty'));

    const pf = PostingsFile.open(p);
    assert.deepEqual(pf.read(dict.get('hello')!), [
      [0, 1],
      [5, 2],
      [9, 1],
    ]);
    assert.deepEqual(pf.read(dict.get('北京')!), [
      [1, 3],
      [2, 1],
    ]);
    pf.close();

    // rebuild is atomic: a second rebuild replaces the file and dict.
    const dict2 = PostingsFile.rebuildSync(p, [{ term: 'only', entries: [[7, 1]] }]);
    assert.equal(dict2.size, 1);
    const pf2 = PostingsFile.open(p);
    assert.deepEqual(pf2.read(dict2.get('only')!), [[7, 1]]);
    pf2.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('PostingsFile: corrupt record throws on read', async () => {
  const dir = await tmpDir();
  try {
    const p = path.join(dir, 'x.postings');
    const dict = PostingsFile.rebuildSync(p, [{ term: 'a', entries: [[1, 1]] }]);
    // flip a byte in the file payload
    const e = dict.get('a')!;
    const fd = fssync.openSync(p, 'r+');
    fssync.writeSync(fd, Buffer.from([0xff]), 0, 1, e.off + Math.floor(e.len / 2));
    fssync.closeSync(fd);

    const pf = PostingsFile.open(p);
    assert.throws(() => pf.read(e), /crc mismatch/);
    pf.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- TextIndex (direct, disk-backed) -------------------------------------

test('TextIndex: add + search (AND/OR) disk-backed', async () => {
  const dir = await tmpDir();
  try {
    const ti = new TextIndex({ postingsPath: path.join(dir, 't.postings') });
    ti.add('a', { bio: 'hello world from London' });
    ti.add('b', { bio: '我住在北京，喜欢编程' });
    ti.add('c', { bio: '我在上海写代码' });

    assert.deepEqual(ti.search('hello').map((h) => h.key), ['a']);
    assert.deepEqual(ti.search('北京').map((h) => h.key), ['b']);
    assert.deepEqual(ti.search('北京 上海', { op: 'OR' }).map((h) => h.key).sort(), ['b', 'c']);
    // AND across two terms only present together in 'b'
    assert.deepEqual(ti.search('北京 编程').map((h) => h.key), ['b']);
    ti.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TextIndex: overwrite tombstones old postings', async () => {
  const dir = await tmpDir();
  try {
    const ti = new TextIndex({ postingsPath: path.join(dir, 't.postings') });
    ti.add('a', { bio: 'hello world' });
    assert.deepEqual(ti.search('hello').map((h) => h.key), ['a']);
    // overwrite 'a' with different text -> old 'hello' posting must be gone
    ti.add('a', { bio: 'goodbye world' });
    assert.deepEqual(ti.search('hello').map((h) => h.key), []);
    assert.deepEqual(ti.search('goodbye').map((h) => h.key), ['a']);
    assert.equal(ti.N, 1);
    ti.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TextIndex: remove deletes postings', async () => {
  const dir = await tmpDir();
  try {
    const ti = new TextIndex({ postingsPath: path.join(dir, 't.postings') });
    ti.add('a', { bio: 'hello world' });
    ti.add('b', { bio: 'hello there' });
    ti.remove('a');
    assert.deepEqual(ti.search('hello').map((h) => h.key), ['b']);
    assert.equal(ti.N, 1);
    ti.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TextIndex: build persists to disk + merges delta after build', async () => {
  const dir = await tmpDir();
  try {
    const p = path.join(dir, 't.postings');
    const ti = new TextIndex({ postingsPath: p });
    ti.build([
      { key: 'a', value: { bio: 'hello world' } },
      { key: 'b', value: { bio: '我住在北京' } },
    ]);
    assert.ok(fssync.existsSync(p), 'postings file should exist after build');
    assert.deepEqual(ti.search('hello').map((h) => h.key), ['a']);

    // new writes after build go to the in-memory delta and are still found
    ti.add('c', { bio: 'hello from c' });
    assert.deepEqual(ti.search('hello').map((h) => h.key).sort(), ['a', 'c']);
    ti.close();

    // a fresh TextIndex over the same file sees the base but not the lost delta
    // (delta is volatile by design; the db rebuilds from the Store on open).
    const ti2 = new TextIndex({ postingsPath: p });
    // rebuild base from the file's perspective by re-reading the same entries
    ti2.build([
      { key: 'a', value: { bio: 'hello world' } },
      { key: 'b', value: { bio: '我住在北京' } },
    ]);
    assert.deepEqual(ti2.search('hello').map((h) => h.key), ['a']);
    ti2.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TextIndex: memory-only mode (no postingsPath)', () => {
  const ti = new TextIndex(); // memory base
  ti.add('a', { bio: 'hello world' });
  ti.add('b', { bio: '北京天安门' });
  assert.deepEqual(ti.search('hello').map((h) => h.key), ['a']);
  assert.deepEqual(ti.search('北京').map((h) => h.key), ['b']);
  assert.equal(ti.termCount() > 0, true);
  ti.close();
});

// ---- through MiniDb ------------------------------------------------------

test('MiniDb: text postings written to disk, search survives reopen', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createTextIndex('bio', { fields: ['bio'] });
    await db.set('a', { bio: '我爱北京天安门' });
    await db.set('b', { bio: '今天天气不错' });
    await db.close();

    assert.ok(fssync.existsSync(path.join(dir, 'db.text-bio.postings')), 'postings file exists');

    db = await MiniDb.open({ dir, valueCodec: 'json' });
    assert.deepEqual(db.search('bio', '北京').map((r) => r.key), ['a']);
    // overwrite then reopen -> tombstone must not resurrect old text
    await db.set('a', { bio: '我爱上海' });
    await db.close();
    db = await MiniDb.open({ dir, valueCodec: 'json' });
    assert.deepEqual(db.search('bio', '北京').map((r) => r.key), []);
    assert.deepEqual(db.search('bio', '上海').map((r) => r.key), ['a']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MiniDb: compaction rebuilds postings (file reclaimed)', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json', autoCompact: false });
    await db.createTextIndex('bio', { fields: ['bio'] });
    for (let i = 0; i < 50; i++) await db.set('k' + i, { bio: 'hello world ' + i });
    const p = path.join(dir, 'db.text-bio.postings');
    assert.ok(fssync.existsSync(p));
    // overwrite everything to create tombstones, then add more (delta grows)
    for (let i = 0; i < 50; i++) await db.set('k' + i, { bio: 'goodbye world ' + i });
    for (let i = 50; i < 80; i++) await db.set('k' + i, { bio: 'hello again ' + i });

    await db.compact(); // should rebuild postings from the live store

    // after compaction the postings reflect the latest values only
    assert.equal(db.search('bio', 'hello').length, 30); // k50..k79
    assert.equal(db.search('bio', 'goodbye').length, 50); // k0..k49
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
