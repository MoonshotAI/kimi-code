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
import { normalizeLiteral, ngramTerm, createNgramTokenizer } from '../src/trigram.js';
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
    const dict = await PostingsFile.rebuild(p, [
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
    const dict2 = await PostingsFile.rebuild(p, [{ term: 'only', entries: [[7, 1]] }]);
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
    const dict = await PostingsFile.rebuild(p, [{ term: 'a', entries: [[1, 1]] }]);
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
    await ti.build([
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
    await ti2.build([
      { key: 'a', value: { bio: 'hello world' } },
      { key: 'b', value: { bio: '我住在北京' } },
    ]);
    assert.deepEqual(ti2.search('hello').map((h) => h.key), ['a']);
    ti2.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TextIndex: writes landing mid-build are replayed onto the new base', async () => {
  const dir = await tmpDir();
  try {
    const p = path.join(dir, 't.postings');
    const ti = new TextIndex({ postingsPath: p });
    // More docs than BUILD_YIELD_DOCS (2048), so the build is guaranteed to
    // yield at least once before its swap — the setImmediate below then lands
    // strictly inside the build window.
    const docs = Array.from({ length: 3000 }, (_, i) => ({
      key: `d${i}`,
      value: { bio: `hello doc${i}` },
    }));
    const buildP = ti.build(docs);
    let landedMidBuild = false;
    setImmediate(() => {
      landedMidBuild = ti.building;
      ti.add('extra', { bio: 'hello extra' }); // new key
      ti.add('d0', { bio: 'goodbye replaced' }); // overwrite a staged key
      ti.remove('d1'); // delete a staged key
    });
    await buildP;
    assert.ok(landedMidBuild, 'writes landed while the build was in flight');

    // Live view during the build stayed correct, and the queue replay made
    // the new base exact: 3000 staged + extra − replaced-d0 − removed-d1.
    assert.equal(ti.N, 3000);
    assert.deepEqual(ti.search('extra').map((h) => h.key), ['extra']);
    assert.deepEqual(ti.search('goodbye').map((h) => h.key), ['d0']);
    assert.deepEqual(ti.search('doc1').map((h) => h.key), []);
    assert.equal(ti.search('hello', { limit: 10_000 }).length, 2999);
    ti.close();
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

test('MiniDb: compaction skips the postings rebuild when the index is clean', async () => {
  const dir = await tmpDir();
  // Count TextIndex.build calls to prove which compactions rebuilt postings.
  const orig = TextIndex.prototype.build;
  let builds = 0;
  TextIndex.prototype.build = async function (this: TextIndex, ...args) {
    builds++;
    return orig.apply(this, args);
  } as typeof orig;
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json', autoCompact: false });
    await db.createTextIndex('bio', { fields: ['bio'] }); // build #1
    await db.set('a', { bio: 'hello world' });
    await db.compact(); // delta dirty -> rebuild #2
    await db.compact(); // clean now -> rebuild skipped
    assert.equal(builds, 2);
    assert.deepEqual(db.search('bio', 'hello').map((h) => h.key), ['a']);
    await db.close();
  } finally {
    TextIndex.prototype.build = orig;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MiniDb: writes during a compaction postings rebuild stay consistent', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json', autoCompact: false });
    await db.createTextIndex('bio', { fields: ['bio'] });
    // More docs than the snapshot yield cadence, so the compaction is still
    // running when the setImmediate writes below land.
    for (let i = 0; i < 3000; i++) await db.set(`d${i}`, { bio: `hello doc${i}` });

    const compactP = db.compact();
    setImmediate(() => {
      void db.set('extra', { bio: 'hello extra' });
      void db.set('d0', { bio: 'goodbye replaced' });
      void db.del('d1');
    });
    await compactP;
    assert.equal(db.stats.compactions, 1);

    assert.equal(db.search('bio', 'hello', { limit: 10_000 }).length, 2999);
    assert.deepEqual(db.search('bio', 'extra').map((h) => h.key), ['extra']);
    assert.deepEqual(db.search('bio', 'goodbye').map((h) => h.key), ['d0']);
    assert.deepEqual(db.search('bio', 'doc1').map((h) => h.key), []);
    await db.close();

    // The mid-compaction writes are durable and consistent across a reopen.
    const db2 = await MiniDb.open({ dir, valueCodec: 'json' });
    assert.equal(db2.search('bio', 'hello', { limit: 10_000 }).length, 2999);
    assert.deepEqual(db2.search('bio', 'extra').map((h) => h.key), ['extra']);
    await db2.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- trigram (n-gram literal tokenizer) ------------------------------------

test('trigram: normalization (case, NFKC, code points)', () => {
  assert.equal(normalizeLiteral('AbC'), 'abc');
  // NFKC folds compatibility glyphs: fullwidth dollar -> ascii dollar
  assert.equal(normalizeLiteral('＄100'), '$100');
  // surrogate pairs count as one code point and survive normalization
  assert.equal(Array.from(normalizeLiteral('A🙂')).length, 2);
  assert.equal(normalizeLiteral('🙂'), '🙂');
});

test('trigram: hash terms are stable and width-tagged', () => {
  // crc32 of the utf8 bytes, low 22 bits, base 36 — pinned so every process
  // derives the same term for the same n-gram.
  assert.equal(ngramTerm('ab'), '24m0d');
  assert.equal(ngramTerm('abc'), '31exfm');
  assert.equal(ngramTerm('🚀🎉'), '217syy');
  // 2-grams and 3-grams live in different tag namespaces and can never alias
  assert.ok(ngramTerm('ab').startsWith('2'));
  assert.ok(ngramTerm('abc').startsWith('3'));
  assert.notEqual(ngramTerm('ab'), ngramTerm('abc'));
  assert.throws(() => ngramTerm('a'), /2- or 3-gram/);
});

test('trigram: index vs query tokenizer shapes', () => {
  const ix = createNgramTokenizer();
  const q = createNgramTokenizer({ forQuery: true });
  // shorter than 2 normalized code points -> no terms (upper layer rejects)
  assert.deepEqual(q('a'), []);
  assert.deepEqual(ix('a'), []);
  assert.deepEqual(q(''), []);
  // length 2: both sides emit exactly the one 2-gram
  assert.deepEqual(q('AB'), [ngramTerm('ab')]);
  assert.deepEqual(ix('AB'), [ngramTerm('ab')]);
  // length >= 3: query side only 3-grams; index side 3-grams + 2-grams
  assert.deepEqual(q('abcd'), [ngramTerm('abc'), ngramTerm('bcd')]);
  assert.deepEqual(ix('abcd').sort(), [ngramTerm('ab'), ngramTerm('abc'), ngramTerm('bc'), ngramTerm('bcd'), ngramTerm('cd')].sort());
  // emoji are single code points: '🙂a' has length 2 -> one 2-gram, not a
  // 3-gram over split UTF-16 surrogates
  assert.deepEqual(q('🙂a'), [ngramTerm('🙂a')]);
});

test('trigram: normalization can change length (single ligature ﬀ becomes a legal query)', () => {
  // 'ﬀ' (U+FB00) is one code point, but NFKC folds it to 'ff' — so the query
  // side emits exactly one 2-gram and the search layer's >=2 check (judged
  // after normalization) accepts what looks like a 1-character query.
  assert.equal(normalizeLiteral('ﬀ'), 'ff');
  assert.deepEqual(createNgramTokenizer({ forQuery: true })('ﬀ'), [ngramTerm('ff')]);
});

test('trigram: query of exactly 3 code points emits its single 3-gram', () => {
  const q = createNgramTokenizer({ forQuery: true });
  // the boundary where the query side switches from 2-grams to 3-grams
  assert.deepEqual(q('abc'), [ngramTerm('abc')]);
  assert.deepEqual(q('已通过'), [ngramTerm('已通过')]);
  // the index side of a 3-char text still emits both widths
  assert.deepEqual(
    createNgramTokenizer()('abc').sort(),
    [ngramTerm('abc'), ngramTerm('ab'), ngramTerm('bc')].sort(),
  );
});

test('TextIndex: injected n-gram tokenizer matches symbol substrings', async () => {
  const dir = await tmpDir();
  try {
    // Wired the same way MiniDb.createTextIndex(..., { tokenizer: 'ngram' })
    // does: index side both widths, query side forQuery.
    const ti = new TextIndex({
      postingsPath: path.join(dir, 'tri.postings'),
      tokenizer: createNgramTokenizer(),
      queryTokenizer: createNgramTokenizer({ forQuery: true }),
    });
    ti.add('cpp', { text: 'modern C++ patterns' });
    ti.add('arrow', { text: 'rewrite a->b safely' });
    ti.add('dash', { text: 'a-b is not an arrow' }); // shares 'a-' but has no '->'
    ti.add('done', { text: '检查项 **已通过** 审核' });
    ti.add('latex', { text: 'inline math $\\frac{a}{b}$ here' });
    ti.add('emoji', { text: 'launch 🚀🎉 today' });

    assert.deepEqual(ti.search('C++').map((h) => h.key), ['cpp']);
    assert.deepEqual(ti.search('c++').map((h) => h.key), ['cpp']); // case-insensitive
    assert.deepEqual(ti.search('->').map((h) => h.key), ['arrow']); // 2-char query via 2-gram
    assert.deepEqual(ti.search('a->b').map((h) => h.key), ['arrow']); // distractor 'a-b' excluded
    assert.deepEqual(ti.search('已通过').map((h) => h.key), ['done']);
    assert.deepEqual(ti.search('\\frac{a}{b}').map((h) => h.key), ['latex']);
    assert.deepEqual(ti.search('🚀🎉').map((h) => h.key), ['emoji']);
    // single character yields no terms, hence no hits
    assert.deepEqual(ti.search('a'), []);
    ti.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TextIndex: n-gram tokenizer delta add/remove/overwrite', async () => {
  const dir = await tmpDir();
  try {
    const ti = new TextIndex({
      postingsPath: path.join(dir, 'tri.postings'),
      tokenizer: createNgramTokenizer(),
      queryTokenizer: createNgramTokenizer({ forQuery: true }),
    });
    await ti.build([{ key: 'a', value: { text: 'C++ guide' } }]);
    assert.deepEqual(ti.search('c++').map((h) => h.key), ['a']);

    // writes after build land in the delta and stay searchable
    ti.add('b', { text: 'C++ cookbook' });
    assert.deepEqual(ti.search('c++').map((h) => h.key).sort(), ['a', 'b']);

    ti.remove('a');
    assert.deepEqual(ti.search('c++').map((h) => h.key), ['b']);
    assert.equal(ti.N, 1);

    // overwrite tombstones the old n-grams
    ti.add('b', { text: 'plain c guide' });
    assert.deepEqual(ti.search('c++').map((h) => h.key), []);
    assert.deepEqual(ti.search('c guide').map((h) => h.key), ['b']);
    ti.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TextIndex: queryTokenizer tokenizes searches when given, falls back otherwise', async () => {
  const dir = await tmpDir();
  try {
    // Docs are indexed under the index tokenizer's term; a search must
    // consult the QUERY tokenizer's term instead.
    const ti = new TextIndex({
      postingsPath: path.join(dir, 't.postings'),
      tokenizer: () => ['idx-term'],
      queryTokenizer: () => ['query-term'],
    });
    ti.add('a', { text: 'whatever' });
    assert.deepEqual(ti.search('anything'), []); // looks up 'query-term', never indexed
    ti.close();

    // Without a queryTokenizer, search falls back to the index tokenizer.
    const fallback = new TextIndex({
      postingsPath: path.join(dir, 't2.postings'),
      tokenizer: () => ['idx-term'],
    });
    fallback.add('a', { text: 'whatever' });
    assert.deepEqual(fallback.search('anything').map((h) => h.key), ['a']);
    fallback.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MiniDb: n-gram text index tokenizes queries with the forQuery shape', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createTextIndex('tri', { fields: ['text'], tokenizer: 'ngram' });
    // 'ab only' shares the 2-gram 'ab' with the query 'abc' but none of its
    // 3-grams. Under OR, an index-side query tokenizer (3-grams + 2-grams)
    // would surface it via 'ab'; the forQuery side emits only the 'abc'
    // 3-gram, so nothing matches.
    await db.set('partial', { text: 'ab only' });
    assert.deepEqual(db.search('tri', 'abc', { op: 'OR' }), []);
    await db.set('full', { text: 'abc here' });
    assert.deepEqual(db.search('tri', 'abc', { op: 'OR' }).map((r) => r.key), ['full']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MiniDb: n-gram text index persists tokenizer, survives reopen', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createTextIndex('tri', { fields: ['text'], tokenizer: 'ngram' });
    await db.createTextIndex('body', { fields: ['text'] });
    await db.set('a', { text: 'modern C++ patterns' });
    await db.set('b', { text: 'plain c plus plus' });
    await db.close();

    // the sidecar records the tokenizer for the n-gram index; the default
    // index keeps the legacy shape (no tokenizer field), which is also what
    // definition files written before n-gram support look like.
    const defs = JSON.parse(await fs.readFile(path.join(dir, 'db.textindexes.json'), 'utf8')) as {
      name: string;
      tokenizer?: string;
    }[];
    assert.equal(defs.find((d) => d.name === 'tri')!.tokenizer, 'ngram');
    assert.ok(!('tokenizer' in defs.find((d) => d.name === 'body')!));

    db = await MiniDb.open({ dir, valueCodec: 'json' });
    // n-gram index restored as n-gram: 'C++' matches only the real substring
    assert.deepEqual(db.search('tri', 'C++').map((r) => r.key), ['a']);
    // default index restored as default: 'C++' still tokenizes to the word 'c'
    assert.deepEqual(db.search('body', 'C++').map((r) => r.key).sort(), ['a', 'b']);

    // delta writes after reopen use the restored tokenizer too
    await db.set('c', { text: 'another C++ note' });
    assert.deepEqual(db.search('tri', 'c++').map((r) => r.key).sort(), ['a', 'c']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MiniDb: createTextIndex rejects an unknown tokenizer', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await assert.rejects(
      db.createTextIndex('x', { tokenizer: 'bogus' as 'ngram' }),
      /unknown text index tokenizer/,
    );
    // the failed creation left nothing behind
    assert.throws(() => db.search('x', 'q'), /no such text index/);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
