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
import { TextIndex, tokenize } from '../src/text-index/index.js';
import { normalizeLiteral, ngramTerm, createNgramTokenizer } from '../src/trigram.js';
import {
  encodePostingList,
  decodePostingList,
  encodeRecord,
  decodeRecord,
  PostingsFile,
} from '../src/text-postings.js';
import { barrier } from './helpers.js';

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
    const { dict } = await PostingsFile.rebuild(p, [
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
    const { dict: dict2 } = await PostingsFile.rebuild(p, [{ term: 'only', entries: [[7, 1]] }]);
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
    const { dict } = await PostingsFile.rebuild(p, [{ term: 'a', entries: [[1, 1]] }]);
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
    // More docs than BUILD_YIELD_DOCS (512), so the build is guaranteed to
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

for (const indexGenerations of [false, true]) {
  test(`MiniDb: compaction rebuilds postings (file reclaimed) [indexGenerations: ${indexGenerations}]`, async () => {
    const dir = await tmpDir();
    try {
      const db = await MiniDb.open({ dir, valueCodec: 'json', autoCompact: false, indexGenerations });
      await db.createTextIndex('bio', { fields: ['bio'] });
      for (let i = 0; i < 50; i++) await db.set('k' + i, { bio: 'hello world ' + i });
      const p = path.join(dir, 'db.text-bio.postings');
      if (indexGenerations) {
        // The background generation build may already have re-published the
        // base (root file reclaimed) — either location proves persistence.
        const inGen = fssync.existsSync(path.join(dir, 'CURRENT'));
        assert.ok(fssync.existsSync(p) || inGen, 'postings persisted (root or generation)');
      } else {
        assert.ok(fssync.existsSync(p));
      }
      // overwrite everything to create tombstones, then add more (delta grows)
      for (let i = 0; i < 50; i++) await db.set('k' + i, { bio: 'goodbye world ' + i });
      for (let i = 50; i < 80; i++) await db.set('k' + i, { bio: 'hello again ' + i });

      await db.compact(); // should rebuild postings from the live store

      // after compaction the postings reflect the latest values only
      assert.equal(db.search('bio', 'hello').length, 30); // k50..k79
      assert.equal(db.search('bio', 'goodbye').length, 50); // k0..k49
      if (indexGenerations) {
        // The base moved into the published generation: the legacy root file
        // is reclaimed and CURRENT's generation carries the fresh postings.
        assert.ok(!fssync.existsSync(p), 'root postings reclaimed after generation publish');
        const gen = db.getIndexGeneration()!;
        assert.ok(gen, 'compaction published a generation');
        assert.ok(fssync.existsSync(path.join(dir, 'generations', gen.id, 'text-bio.postings')), 'postings live in the generation');
      } else {
        assert.ok(fssync.existsSync(p), 'legacy path keeps the root postings file');
      }
      await db.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

test('MiniDb: compaction skips the postings rebuild when the index is clean [legacy]', async () => {
  const dir = await tmpDir();
  // Count TextIndex.build calls to prove which compactions rebuilt postings.
  const orig = TextIndex.prototype.build;
  let builds = 0;
  TextIndex.prototype.build = async function (this: TextIndex, ...args) {
    builds++;
    return orig.apply(this, args);
  } as typeof orig;
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json', autoCompact: false, indexGenerations: false });
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

test('MiniDb: compaction skips the postings rebuild when the index is clean [generation]', async () => {
  const dir = await tmpDir();
  // Same skip, generation style: the clean index is re-published by hard
  // link, so PostingsFile.rebuild (the actual postings rewrite) runs only
  // for the create and the one DIRTY compaction.
  const orig = PostingsFile.rebuild;
  let rebuilds = 0;
  PostingsFile.rebuild = async function (...args) {
    rebuilds++;
    return orig.apply(this, args);
  } as typeof orig;
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json', autoCompact: false });
    await db.createTextIndex('bio', { fields: ['bio'] }); // rewrite #1
    await db.set('a', { bio: 'hello world' });
    await db.compact(); // delta dirty -> generation build rewrites postings (#2)
    await db.compact(); // clean now -> re-published by link, no rewrite
    assert.equal(rebuilds, 2);
    assert.deepEqual(db.search('bio', 'hello').map((h) => h.key), ['a']);
    await db.close();
  } finally {
    PostingsFile.rebuild = orig;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

for (const indexGenerations of [false, true]) {
  test(`MiniDb: writes during a compaction postings rebuild stay consistent [indexGenerations: ${indexGenerations}]`, async () => {
    const dir = await tmpDir();
    // Deterministic barrier instead of the old "3000 docs keep the compaction
    // busy long enough" timing inference (review #28): the compaction's
    // derived-state rebuild is parked on a deferred, so the writes PROVABLY
    // land while it is in flight, and each write's promise is explicitly
    // settled instead of fire-and-forget. The barrier arms AFTER
    // createTextIndex so its call 1 is the compaction rebuild, not the
    // create. On the legacy path the rebuild is TextIndex.build; with
    // generations it is the staged build's PostingsFile.rebuild inside the
    // generation publish.
    let gate!: ReturnType<typeof barrier>;
    try {
      const db = await MiniDb.open({ dir, valueCodec: 'json', autoCompact: false, indexGenerations });
      await db.createTextIndex('bio', { fields: ['bio'] });
      for (let i = 0; i < 50; i++) await db.set(`d${i}`, { bio: `hello doc${i}` });

      gate = indexGenerations ? barrier(PostingsFile, 'rebuild') : barrier(TextIndex.prototype, 'build');
      const compactP = db.compact();
      await gate.entered; // the compaction is provably inside the postings rebuild
      const writes = Promise.all([db.set('extra', { bio: 'hello extra' }), db.set('d0', { bio: 'goodbye replaced' }), db.del('d1')]);
      gate.release();
      await writes;
      await compactP;
      assert.equal(db.stats.compactions, 1);

      assert.equal(db.search('bio', 'hello', { limit: 10_000 }).length, 49);
      assert.deepEqual(db.search('bio', 'extra').map((h) => h.key), ['extra']);
      assert.deepEqual(db.search('bio', 'goodbye').map((h) => h.key), ['d0']);
      assert.deepEqual(db.search('bio', 'doc1').map((h) => h.key), []);
      await db.close();

      // The mid-compaction writes are durable and consistent across a reopen.
      const db2 = await MiniDb.open({ dir, valueCodec: 'json' });
      assert.equal(db2.search('bio', 'hello', { limit: 10_000 }).length, 49);
      assert.deepEqual(db2.search('bio', 'extra').map((h) => h.key), ['extra']);
      await db2.close();
    } finally {
      gate?.restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

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

// ---- top-K + delta reverse map (plan/02 bounded hot paths) ----------------

test('TextIndex: top-K ranks score desc with a stable key tie-break', async () => {
  const dir = await tmpDir();
  try {
    const ti = new TextIndex({ postingsPath: path.join(dir, 't.postings') });
    // Every doc has the same term freq and the same doc length, so all scores
    // are identical and the order must come from the key tie-break alone.
    await ti.build([
      { key: 'k3', value: { bio: 'common pad' } },
      { key: 'k1', value: { bio: 'common pad' } },
      { key: 'k2', value: { bio: 'common pad' } },
    ]);
    assert.deepEqual(ti.search('common', { limit: 2 }).map((h) => h.key), ['k1', 'k2'], 'equal scores -> key asc');
    assert.deepEqual(ti.search('common', { limit: 10 }).map((h) => h.key), ['k1', 'k2', 'k3']);
    assert.deepEqual(ti.search('common', { limit: 0 }), [], 'limit 0 stays empty');
    ti.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TextIndex: top-K over many candidates matches the full-ranking reference', async () => {
  const dir = await tmpDir();
  try {
    const ti = new TextIndex({ postingsPath: path.join(dir, 't.postings') });
    const entries: { key: string; value: { bio: string } }[] = [];
    for (let i = 0; i < 500; i++) {
      // Vary both term frequency (i % 7 + 1) and doc length (i % 11 pads), so
      // scores differ across docs; a third of the docs carry no 'x' at all.
      const reps = i % 3 === 0 ? 0 : (i % 7) + 1;
      const body = `${'x '.repeat(reps)}${Array.from({ length: i % 11 }, (_, j) => `p${j}`).join(' ')}`.trim();
      entries.push({ key: `k${String(i).padStart(4, '0')}`, value: { bio: body } });
    }
    await ti.build(entries);

    // The full ranking (limit above the candidate count returns everything).
    const all = ti.search('x', { limit: 1_000_000 });
    const matching = entries.filter((e) => e.value.bio.includes('x')).length;
    assert.equal(all.length, matching, 'unbounded search returns every scoring doc');
    for (let i = 1; i < all.length; i++) {
      const [p, c] = [all[i - 1]!, all[i]!];
      assert.ok(p.score > c.score || (p.score === c.score && p.key < c.key), `rank order at ${i}`);
    }
    const rank = new Map(all.map((h, i) => [h.key, i]));
    for (const limit of [1, 5, 10, 50, 499]) {
      const hits = ti.search('x', { limit });
      assert.equal(hits.length, Math.min(limit, all.length));
      // Exactly the first `limit` rows of the full ranking, in the same order.
      assert.deepEqual(
        hits.map((h) => h.key),
        all.slice(0, limit).map((h) => h.key),
        `limit=${limit} is the full ranking's prefix`,
      );
      for (const h of hits) assert.ok(rank.get(h.key)! < limit);
    }
    ti.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TextIndex: overwrite/remove prune the delta via the doc reverse map', () => {
  const ti = new TextIndex(); // memory base; adds go to the delta
  ti.add('a', { bio: 'apple banana' });
  ti.add('b', { bio: 'cherry' });
  assert.equal(ti.termCount(), 3);

  ti.add('a', { bio: 'mango' }); // overwrite: apple/banana leave the delta
  assert.deepEqual(ti.search('apple').map((h) => h.key), []);
  assert.deepEqual(ti.search('banana').map((h) => h.key), []);
  assert.deepEqual(ti.search('mango').map((h) => h.key), ['a']);
  assert.equal(ti.termCount(), 2, 'pruned terms leave the vocabulary (cherry, mango)');

  ti.remove('b');
  assert.deepEqual(ti.search('cherry').map((h) => h.key), []);
  assert.equal(ti.termCount(), 1, 'only mango remains');
  ti.close();
});


// ---- query-time postings budget (maxVisits / searchBounded) ---------------

test('TextIndex: maxVisits truncates a hot term and reports visits (disk-backed)', async () => {
  const dir = await tmpDir();
  try {
    const ti = new TextIndex({ postingsPath: path.join(dir, 't.postings') });
    const entries: { key: string; value: { bio: string } }[] = [];
    for (let i = 0; i < 500; i++) entries.push({ key: `k${String(i).padStart(4, '0')}`, value: { bio: 'x pad' } });
    await ti.build(entries);

    const full = ti.searchBounded('x', { limit: 1_000 });
    assert.equal(full.hits.length, 500);
    assert.equal(full.truncated, false);
    assert.ok(full.visits >= 500);

    const bounded = ti.searchBounded('x', { limit: 1_000, maxVisits: 100 });
    assert.equal(bounded.truncated, true, 'the budget cut the hot list short');
    assert.ok(bounded.visits <= 100, `visits stay within the budget, got ${bounded.visits}`);
    assert.ok(bounded.hits.length > 0 && bounded.hits.length <= 100);
    // A truncated result is a SUBSET of the full matches — never false hits.
    const fullKeys = new Set(full.hits.map((h) => h.key));
    for (const h of bounded.hits) assert.ok(fullKeys.has(h.key), `${h.key} is a real match`);

    // The same options through plain search() keep returning just the hits.
    assert.deepEqual(
      ti.search('x', { limit: 1_000, maxVisits: 100 }).map((h) => h.key),
      bounded.hits.map((h) => h.key),
    );
    // Unbudgeted callers are unaffected, and a capped read never poisoned the
    // postings cache with a partial list.
    assert.equal(ti.search('x', { limit: 1_000 }).length, 500);
    ti.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('TextIndex: maxVisits caps the memory base the same way', async () => {
  const ti = new TextIndex(); // memory base
  for (let i = 0; i < 200; i++) ti.add(`k${String(i).padStart(4, '0')}`, { bio: 'x pad' });

  const bounded = ti.searchBounded('x', { limit: 1_000, maxVisits: 50 });
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.visits <= 50);
  assert.ok(bounded.hits.length > 0 && bounded.hits.length <= 50);
  assert.equal(ti.search('x', { limit: 1_000 }).length, 200, 'unbudgeted search unaffected');
  ti.close();
});

test('TextIndex: AND under a budget yields a subset with complete per-doc scores', async () => {
  const dir = await tmpDir();
  try {
    const ti = new TextIndex({ postingsPath: path.join(dir, 't.postings') });
    const entries: { key: string; value: { bio: string } }[] = [];
    // 'hot' appears in 500 docs, 'rare' in 3 of them.
    for (let i = 0; i < 500; i++) {
      const rare = i < 3 ? ' rare' : '';
      entries.push({ key: `k${String(i).padStart(4, '0')}`, value: { bio: `hot pad${rare}` } });
    }
    await ti.build(entries);

    const full = ti.searchBounded('hot rare', { limit: 1_000 });
    assert.equal(full.hits.length, 3);

    // The budget is exhausted by the hot term, but the selective term decodes
    // first; the intersection can only shrink — a subset, never false hits.
    // (Scores under a truncated budget are approximate: idf is computed from
    // the decoded list, whose df the cap shrinks. The `truncated` flag is
    // what tells the caller not to trust completeness.)
    const bounded = ti.searchBounded('hot rare', { limit: 1_000, maxVisits: 60 });
    assert.equal(bounded.truncated, true);
    const fullKeys = new Set(full.hits.map((h) => h.key));
    assert.ok(bounded.hits.length <= full.hits.length);
    for (const h of bounded.hits) {
      assert.ok(fullKeys.has(h.key), `${h.key} is a true AND match`);
      assert.ok(h.score > 0);
    }

    // A zero budget cannot assemble any AND candidate set: empty + flagged.
    const zero = ti.searchBounded('hot rare', { limit: 1_000, maxVisits: 0 });
    assert.equal(zero.truncated, true);
    assert.equal(zero.hits.length, 0);
    ti.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MiniDb: searchBounded surfaces values, visits and the truncated flag', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no' });
    await db.createTextIndex('body', { fields: ['bio'] });
    for (let i = 0; i < 300; i++) {
      await db.set(`k${String(i).padStart(4, '0')}`, { bio: 'x pad', n: i });
    }

    const bounded = db.searchBounded('body', 'x', { limit: 1_000, maxVisits: 80 });
    assert.equal(bounded.truncated, true);
    assert.ok(bounded.visits <= 80);
    assert.ok(bounded.hits.length > 0 && bounded.hits.length <= 80);
    for (const h of bounded.hits) assert.equal(typeof h.value.n, 'number', 'hits carry decoded values');

    const full = db.search('body', 'x', { limit: 1_000 });
    assert.equal(full.length, 300);
    const fullKeys = new Set(full.map((h) => h.key));
    for (const h of bounded.hits) assert.ok(fullKeys.has(h.key));
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});


// ---- plan 10: sidecar mutation serialization + staged → persist → publish --

/** White-box handle on the private persistTextIndexDefinitions, to inject a
 *  sidecar-write failure at the exact transaction point. */
function stubTextPersist(db: MiniDb, impl: (defs: { name: string }[]) => Promise<void>): () => void {
  const priv = db as unknown as { persistTextIndexDefinitions: (defs: { name: string }[]) => Promise<void> };
  const saved = priv.persistTextIndexDefinitions;
  priv.persistTextIndexDefinitions = impl;
  return () => {
    priv.persistTextIndexDefinitions = saved;
  };
}

async function textSidecarNames(dir: string): Promise<string[]> {
  try {
    return (JSON.parse(await fs.readFile(path.join(dir, 'db.textindexes.json'), 'utf8')) as { name: string }[])
      .map((d) => d.name)
      .sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

test('MiniDb: concurrent createTextIndex calls are serialized; memory == sidecar == reopen', async () => {
  const dir = await tmpDir();
  let db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.set('a', { title: 'hello world', body: 'full text body' });
    const results = await Promise.allSettled([
      db.createTextIndex('title', { fields: ['title'] }),
      db.createTextIndex('body', { fields: ['body'] }),
      db.dropTextIndex('neverThere'),
    ]);
    assert.deepEqual(
      results.map((r) => (r.status === 'rejected' ? String(r.reason) : r.status)),
      ['fulfilled', 'fulfilled', 'fulfilled'],
    );
    assert.deepEqual(await textSidecarNames(dir), ['body', 'title']);
    // Both builds (registered before building) saw the pre-existing document.
    assert.deepEqual(db.search('title', 'hello').map((r) => r.key), ['a']);
    assert.deepEqual(db.search('body', 'text').map((r) => r.key), ['a']);
    await db.close();
    db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    assert.deepEqual(await textSidecarNames(dir), ['body', 'title']);
    assert.deepEqual(db.search('title', 'hello').map((r) => r.key), ['a']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MiniDb: createTextIndex persist failure: no phantom, postings removed, original error rethrown, retry succeeds', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.set('a', { text: 'hello world' });
    const boom = new Error('injected sidecar write failure');
    const restore = stubTextPersist(db, async () => {
      throw boom;
    });
    await assert.rejects(db.createTextIndex('body', { fields: ['text'] }), (e) => e === boom);
    restore();
    // No phantom: the index is gone from memory and from the sidecar, and its
    // derived postings file was removed (exactly like dropTextIndex would).
    assert.throws(() => db.search('body', 'hello'), /no such text index/);
    assert.deepEqual(await textSidecarNames(dir), []);
    assert.deepEqual(
      (await fs.readdir(dir)).filter((f) => f.includes('postings')),
      [],
    );
    // Retry succeeds — no phantom "already exists".
    await db.createTextIndex('body', { fields: ['text'] });
    assert.deepEqual(db.search('body', 'hello').map((r) => r.key), ['a']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MiniDb: dropTextIndex persist failure: the index stays searchable and the sidecar is unchanged', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.createTextIndex('body', { fields: ['text'] });
    await db.set('a', { text: 'hello world' });
    const before = await fs.readFile(path.join(dir, 'db.textindexes.json'), 'utf8');
    const boom = new Error('injected sidecar write failure');
    const restore = stubTextPersist(db, async () => {
      throw boom;
    });
    await assert.rejects(db.dropTextIndex('body'), (e) => e === boom);
    restore();
    // The index is still live: searchable, and its postings file intact.
    assert.deepEqual(db.search('body', 'hello').map((r) => r.key), ['a']);
    assert.equal(await fs.readFile(path.join(dir, 'db.textindexes.json'), 'utf8'), before);
    // A later successful drop persists fine.
    assert.equal(await db.dropTextIndex('body'), true);
    assert.deepEqual(await textSidecarNames(dir), []);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});


test('MiniDb: dropTextIndex persist window: a compaction postings rebuild skips the dropping index (no orphan, no leaked handle)', async () => {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  try {
    await db.createTextIndex('body', { fields: ['text'] });
    // Dirty the index so it is a postings-rebuild candidate.
    await db.set('a', { text: 'hello world' });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inPersist = new Promise<void>((r) => (entered = r));
    // Park INSIDE the persist, then let the real write through: the drop
    // completes end-to-end, only delayed.
    const privPersist = db as unknown as { persistTextIndexDefinitions(defs: { name: string }[]): Promise<void> };
    const original = privPersist.persistTextIndexDefinitions;
    const restore = stubTextPersist(db, async (defs) => {
      entered();
      await gate;
      await original.call(db, defs);
    });
    const drop = db.dropTextIndex('body');
    // The drop is parked inside its persist, the index marked staged-drop.
    await inPersist;
    const priv = db as unknown as {
      rebuildTextPostings(): Promise<void>;
      text: Map<string, TextIndex>;
    };
    const ti = priv.text.get('body')!;
    assert.equal(ti.needsRebuild(), true, 'setup: the index is a rebuild candidate');
    // A background compaction's postings rebuild lands in the window. The
    // build (if started) sets ti.building synchronously, so this assertion is
    // not timing-dependent.
    const rebuild = priv.rebuildTextPostings();
    assert.equal(ti.building, false, 'a dropping index must not start a postings build');
    release();
    assert.equal(await drop, true);
    await rebuild;
    restore();
    // No late build commit: no orphan postings file re-created after the
    // drop's close+rm, and no live handle left on the dropped index.
    assert.deepEqual((await fs.readdir(dir)).filter((f) => f.includes('postings')), []);
    assert.equal((ti as unknown as { pf: unknown }).pf, null);
    assert.deepEqual(await textSidecarNames(dir), []);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- stage 11: tokenizer output validated at the write boundary ------------

type TiPrivates = {
  delta: Map<string, Map<number, number>>;
  deltaCount: number;
  docLen: Map<number, number>;
  keys: (string | undefined)[];
  keyToId: Map<string, number>;
  buildQueue: unknown;
};

test('TextIndex: a throwing tokenizer leaves the live view, delta and buildQueue untouched (review #24)', () => {
  let fail = false;
  const ti = new TextIndex({
    tokenizer: (s) => {
      if (fail) throw new Error('boom');
      return tokenize(s);
    },
    // A working query tokenizer (the ngram pair pattern): searches must not
    // go through the failing index-side tokenizer.
    queryTokenizer: (s) => tokenize(s),
  });
  const priv = ti as unknown as TiPrivates;

  ti.add('k', { bio: 'hello world' });
  assert.deepEqual(ti.search('hello').map((h) => h.key), ['k']);

  // Overwrite with a failing tokenizer: rejected BEFORE any mutation, so the
  // old document stays searchable instead of being tombstoned into a ghost.
  fail = true;
  assert.throws(() => {
    ti.add('k', { bio: 'goodbye world' });
  }, /boom/);
  assert.equal(ti.N, 1);
  assert.deepEqual(ti.search('hello').map((h) => h.key), ['k'], 'old doc survives the failed overwrite');
  assert.deepEqual(ti.search('goodbye'), []);
  assert.equal(priv.docLen.size, 1, 'no ghost docLen entry');
  assert.equal(priv.keys.length, 1, 'no ghost docID');
  assert.equal(priv.deltaCount, 2, 'delta holds exactly the old doc’s terms');

  // A fresh key fails just as cleanly.
  assert.throws(() => {
    ti.add('fresh', { bio: 'quux' });
  }, /boom/);
  assert.equal(ti.N, 1);
  assert.equal(priv.keyToId.has('fresh'), false);

  // Mid-build: the failed write never reaches the build queue either, so the
  // swap-time replay cannot re-throw half-way through the queue.
  fail = false;
  const b = ti.beginBuild();
  b.add('staged', { bio: 'staged doc' });
  fail = true;
  assert.throws(() => {
    ti.add('q', { bio: 'queued?' });
  }, /boom/);
  assert.equal((priv.buildQueue as unknown[] | null)?.length, 0, 'the failed add was never queued');
  assert.deepEqual(ti.search('hello').map((h) => h.key), ['k'], 'live view intact during the build');
  b.abort();
  ti.close();
});

test('TextIndex: an overlong custom-tokenizer term is rejected before any mutation (review #27)', async () => {
  const dir = await tmpDir();
  try {
    const ti = new TextIndex({ postingsPath: path.join(dir, 't.postings'), tokenizer: () => ['你'.repeat(30000)] });
    const priv = ti as unknown as TiPrivates;
    // '你'.repeat(30000) is 90000 utf8 bytes > 0xffff — it would have made
    // every postings rebuild throw RangeError, permanently poisoning the index.
    assert.throws(() => {
      ti.add('k', { bio: 'x' });
    }, /longer than 65535 utf8 bytes/);
    assert.equal(ti.N, 0);
    assert.equal(priv.docLen.size, 0);
    assert.equal(priv.deltaCount, 0);
    // The build path validates at the same boundary (and aborts cleanly).
    await assert.rejects(ti.build([{ key: 'k', value: { bio: 'x' } }]), /longer than 65535 utf8 bytes/);
    ti.close();

    // A healthy index over the same postings path builds and searches fine.
    const ti2 = new TextIndex({ postingsPath: path.join(dir, 't.postings') });
    ti2.add('k', { bio: 'hello world' });
    await ti2.build([{ key: 'k', value: { bio: 'hello world' } }]);
    assert.deepEqual(ti2.search('hello').map((h) => h.key), ['k']);
    ti2.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MiniDb: a throwing tokenizer rejects set with zero side effects; the old doc stays searchable (review #24)', async () => {
  const dir = await tmpDir();
  try {
    let db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    await db.createTextIndex('ft', { fields: ['t'] });
    await db.set('k1', { t: 'hello world' });
    const ti = (db as unknown as { text: Map<string, { tokenizer: (s: string) => string[] }> }).text.get('ft')!;
    const priv = ti as unknown as TiPrivates & { N: number };
    const origTokenizer = ti.tokenizer;
    ti.tokenizer = () => {
      throw new Error('boom');
    };

    // Insert rejected: store, delta, buildQueue, N, docLen all untouched.
    await assert.rejects(db.set('k2', { t: 'bad insert' }), /boom/);
    assert.equal(db.get('k2'), undefined);
    assert.equal(db.size, 1);
    // Overwrite rejected: the old document is fully intact.
    await assert.rejects(db.set('k1', { t: 'goodbye' }), /boom/);
    assert.deepEqual(db.get('k1'), { t: 'hello world' });
    assert.deepEqual(db.search('ft', 'hello').map((h) => h.key), ['k1'], 'old doc still searchable');
    assert.deepEqual(db.search('ft', 'goodbye'), []);
    assert.equal(priv.N, 1);
    assert.equal(priv.docLen.size, 1);
    assert.equal(priv.deltaCount, 2, 'delta holds exactly the old doc’s terms');
    assert.equal(priv.buildQueue, null);

    // Restored tokenizer: writes flow again; reopen agrees.
    ti.tokenizer = origTokenizer;
    await db.set('k2', { t: 'fine' });
    await db.close();
    db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    assert.deepEqual(db.get('k1'), { t: 'hello world' });
    assert.deepEqual(db.get('k2'), { t: 'fine' });
    assert.deepEqual(db.search('ft', 'hello').map((h) => h.key), ['k1']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('MiniDb: an overlong tokenizer term rejects set/batch; the postings rebuild stays healthy (review #27)', async () => {
  const dir = await tmpDir();
  try {
    const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
    await db.createTextIndex('ft', { fields: ['t'] });
    await db.set('good', { t: 'hello world' });
    const ti = (db as unknown as { text: Map<string, { tokenizer: (s: string) => string[]; customTokenizer: boolean }> }).text.get('ft')!;
    const origTokenizer = ti.tokenizer;
    // Simulate a custom tokenizer (the MiniDb definition only ever wires
    // default/ngram): the length validation only guards custom output.
    ti.customTokenizer = true;
    ti.tokenizer = () => ['你'.repeat(30000)];

    await assert.rejects(db.set('bad', { t: 'x' }), /longer than 65535 utf8 bytes/);
    await assert.rejects(db.batch([{ op: 'set', key: 'bad2', value: { t: 'x' } }]), /longer than 65535 utf8 bytes/);
    assert.equal(db.get('bad'), undefined, 'the poisonous doc never enters the store');
    assert.equal(db.get('bad2'), undefined);

    // Back to a healthy tokenizer: writes and the postings rebuild both work.
    ti.customTokenizer = false;
    ti.tokenizer = origTokenizer;
    await db.set('good2', { t: 'another doc' });
    await db.compact(); // rotates + rebuilds text postings from the store
    assert.deepEqual(db.search('ft', 'hello').map((h) => h.key), ['good']);
    assert.deepEqual(db.search('ft', 'another').map((h) => h.key), ['good2']);
    await db.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- stage 6: byte-bounded cache + async search + rebase ---------------------

test('decoded postings cache honors the byte budget, not just the term count', async () => {
  const dir = await tmpDir();
  try {
    const postingsPath = path.join(dir, 'p.postings');
    const ti = new TextIndex({ postingsPath, cacheTerms: 1000, cacheBytes: 4096 });
    // 200 docs each carrying many distinct terms -> several large decoded
    // lists; a 4 KiB byte budget can only hold a handful of them.
    for (let i = 0; i < 200; i++) {
      ti.add(`k${i}`, { text: `alpha beta gamma doc${i} shared${i % 10} common` });
    }
    await ti.build([...Array(200)].map((_, i) => ({ key: `k${i}`, value: { text: `alpha beta gamma doc${i} shared${i % 10} common` } })));
    // Warm the cache with several hot lists (each has 200 entries ~ 4.8 KiB
    // by the cache's own accounting).
    ti.search('alpha');
    ti.search('beta');
    ti.search('gamma');
    ti.search('common');
    const cacheSize = (ti as unknown as { cache: Map<string, unknown> }).cache.size;
    assert.ok(cacheSize < 4, `byte budget evicted big lists (cache holds ${cacheSize})`);
    // Results stay correct after eviction.
    assert.equal(ti.search('alpha', { limit: 300 }).length, 200);
    await fs.rm(dir, { recursive: true, force: true });
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    throw e;
  }
});

test('searchBoundedAsync matches searchBounded on a disk-backed index', async () => {
  const dir = await tmpDir();
  try {
    const postingsPath = path.join(dir, 'p.postings');
    const ti = new TextIndex({ postingsPath });
    await ti.build([...Array(500)].map((_, i) => ({ key: `k${i}`, value: { text: `hello world doc ${i} 异步 ${i % 11}` } })));
    for (const q of ['hello', '异步', 'hello world', 'missing-term']) {
      assert.deepEqual(await ti.searchBoundedAsync(q, { limit: 25 }), ti.searchBounded(q, { limit: 25 }), q);
    }
    // With a visit budget too (capped decodes must match as well).
    assert.deepEqual(await ti.searchBoundedAsync('hello', { maxVisits: 10 }), ti.searchBounded('hello', { maxVisits: 10 }));
    ti.close();
    await fs.rm(dir, { recursive: true, force: true });
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    throw e;
  }
});

test('commitRebase swaps in an externally built base and replays the capture', async () => {
  const dir = await tmpDir();
  try {
    const postingsPath = path.join(dir, 'p.postings');
    const ti = new TextIndex({ postingsPath });
    await ti.build([
      { key: 'a', value: { text: 'alpha one' } },
      { key: 'b', value: { text: 'beta two' } },
    ]);
    assert.equal(ti.search('alpha').length, 1);

    // Stage a "worker-produced" base by hand: a fresh postings file with a
    // different doc set, then commit it through the rebase machinery while
    // mutations land during the capture window.
    const workerPostings = path.join(dir, 'w.postings');
    const agg = new Map<string, Map<number, number>>([
      ['gamma', new Map([[0, 1]])],
      ['three', new Map([[0, 1]])],
    ]);
    const { PostingsFile: PF } = await import('../src/text-postings.js');
    const built = await PF.rebuild(workerPostings, [...agg].map(([term, entries]) => ({ term, entries })));
    ti.beginRebase();
    // Mutations landing AFTER the capture started: must be replayed onto the
    // new base at commit (they already applied to the live view too).
    ti.add('d', { text: 'delta four' });
    ti.remove('a');
    const containers = await TextIndex.prepareRebaseContainers([...built.dict], ['c'], new Map([[0, 2]]));
    ti.commitRebase({
      postingsPath: workerPostings,
      containers,
      liveCount: 1,
      postingsFileInfo: { bytes: built.bytes, crc32: built.crc32 },
    });
    // New base visible; old base gone; captured ops replayed.
    assert.deepEqual(ti.search('gamma').map((h) => h.key), ['c']);
    assert.equal(ti.search('alpha').length, 0);
    assert.deepEqual(ti.search('delta').map((h) => h.key), ['d']);
    ti.close();
    await fs.rm(dir, { recursive: true, force: true });
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    throw e;
  }
});

test('abortRebase discards the capture and keeps the previous base', async () => {
  const dir = await tmpDir();
  try {
    const postingsPath = path.join(dir, 'p.postings');
    const ti = new TextIndex({ postingsPath });
    await ti.build([{ key: 'a', value: { text: 'alpha one' } }]);
    ti.beginRebase();
    ti.add('b', { text: 'beta two' });
    ti.abortRebase();
    assert.equal(ti.rebasing, false);
    assert.equal(ti.search('alpha').length, 1);
    assert.equal(ti.search('beta').length, 1);
    ti.close();
    await fs.rm(dir, { recursive: true, force: true });
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    throw e;
  }
});

test('commitRebase adopts a disk base over a memory-base index (read-only scratch shape)', async () => {
  const dir = await tmpDir();
  try {
    // A memory-base index (the read-only-open shape) adopts the worker-built
    // disk base from a caller-owned location instead of throwing — the same
    // flip a generation attach makes.
    const ti = new TextIndex({});
    assert.ok(ti.memBase !== null);
    ti.add('old', { text: 'stale one' });

    const workerPostings = path.join(dir, 'w.postings');
    const agg = new Map<string, Map<number, number>>([['gamma', new Map([[0, 1]])]]);
    const built = await PostingsFile.rebuild(workerPostings, [...agg].map(([term, entries]) => ({ term, entries })));
    // The deferred open-time build arms the capture and marks the base
    // unavailable until the commit lands.
    ti.basePending = true;
    ti.beginRebase();
    assert.throws(() => ti.search('gamma'), /still building/);
    ti.add('new', { text: 'delta two' });
    const containers = await TextIndex.prepareRebaseContainers([...built.dict], ['c'], new Map([[0, 1]]));
    ti.commitRebase({
      postingsPath: workerPostings,
      containers,
      liveCount: 1,
      postingsFileInfo: { bytes: built.bytes, crc32: built.crc32 },
    });
    assert.equal(ti.memBase, null); // flipped to the adopted disk base
    assert.equal(ti.basePending, false);
    assert.equal(ti.currentPostingsPath, workerPostings);
    // The old memory base is gone; the captured write replayed onto the new one.
    assert.deepEqual(ti.search('gamma').map((h) => h.key), ['c']);
    assert.equal(ti.search('stale').length, 0);
    assert.deepEqual(ti.search('delta').map((h) => h.key), ['new']);
    ti.close();
    await fs.rm(dir, { recursive: true, force: true });
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    throw e;
  }
});

test('an async base read straddling a base commit re-reads the fresh base instead of caching the stale one', async () => {
  const dir = await tmpDir();
  try {
    const p1 = path.join(dir, 'a.postings');
    const ti = new TextIndex({ postingsPath: p1 });
    await ti.build([{ key: 'a', value: { text: 'alpha' } }]);
    // Count terms instead of searching here — a search would warm the
    // decoded-postings cache and the straddle below would never reach the file.
    assert.equal(ti.termCount(), 1);

    // Park the async postings read on a gate; a base commit lands meanwhile.
    const realPf = ti.pf!;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    ti.pf = {
      path: realPf.path,
      read: (entry: never, max?: number) => realPf.read(entry, max),
      readAsync: async (entry: never, max?: number) => {
        await gate;
        return realPf.read(entry, max);
      },
      close: () => realPf.close(),
    } as unknown as PostingsFile;

    const readP = ti.searchBoundedAsync('alpha');
    // Let the read reach the parked gate before committing the new base.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const b = ti.beginBuild({ postingsPath: path.join(dir, 'b.postings') });
    b.add('b', { text: 'beta' }); // the new base has no 'alpha' at all
    await b.commit();
    release();

    const res = await readP;
    // The straddled read must NOT serve the stale base's hit, and the cache
    // must not be poisoned either: the next query sees only the fresh base.
    assert.deepEqual(res.hits, []);
    assert.deepEqual(ti.searchBounded('alpha').hits, []);
    assert.equal(ti.searchBounded('beta').hits.length, 1);
    ti.close();
    await fs.rm(dir, { recursive: true, force: true });
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    throw e;
  }
});

test('TextIndexBuildingError while the base is pending (sync + async + query)', async () => {
  const ti = new TextIndex({ name: 'guarded' });
  ti.add('k', { text: 'hello world' });
  // Pending base: every search entry raises the typed signal instead of
  // silently serving the delta alone.
  ti.basePending = true;
  assert.throws(() => ti.search('hello'), (e: unknown) => e instanceof Error && e.name === 'TextIndexBuildingError');
  assert.throws(() => ti.searchBounded('hello'), /still building/);
  await assert.rejects(ti.searchBoundedAsync('hello'), /still building/);
  // A base build with a LIVE old base underneath does NOT set the flag:
  // staged builds keep serving (beginBuild alone must not trip the guard).
  ti.basePending = false;
  const b = ti.beginBuild();
  assert.equal(ti.search('hello').length, 1);
  b.abort();
  assert.equal(ti.search('hello').length, 1);
});
