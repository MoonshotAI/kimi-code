// test/e2e/stress.test.ts
//
// Stress tests for MiniDb. Unlike the per-component unit tests and the
// sequential fuzz/model e2e's, these hammer the database with high in-flight
// concurrency, explicit WAL-rotation storms, torn/corrupt tails, mass TTL
// expiry, memory-pressure eviction, live read-only openers, and multi-process
// lock contention — then assert the durability contract: every acknowledged
// write survives, the in-memory view and the recovered view always agree, and
// reads/queries never change behavior under load.
//
// Tests in the "bug evidence" section pin, one per discovered bug, the exact
// contract that currently breaks under stress. The "coverage" section holds
// the stress configurations that behave correctly and must keep behaving.

import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MiniDb } from '../../src/index.js';
import { startServer } from '../../src/server.js';
import { tmpDir, rmrf } from './helpers/tmp.js';
import { mulberry32 } from './helpers/prng.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const fmtErrs = (errs: unknown[], n = 5): string =>
  errs
    .slice(0, n)
    .map((e) => String((e as Error)?.message ?? e))
    .join(' | ');

// Write storm with an explicit compaction fired mid-run; a unique index makes
// write commits queue on the unique-conflict lock, which widens the async gap
// between the compaction gate check and the WAL append so rotations genuinely
// race in-flight writers (without it, the storm outruns every rotation).
async function driveStormWithRotation(
  db: MiniDb<{ n: number; pad: string }>,
  opts: { writers?: number; perWriter?: number; compactsAt?: number[] },
): Promise<{ acked: Map<string, { n: number; pad: string }>; failures: unknown[] }> {
  const { writers = 64, perWriter = 8 } = opts;
  const compactsAt = new Set(opts.compactsAt ?? [150]);
  const acked = new Map<string, { n: number; pad: string }>();
  const failures: unknown[] = [];
  let nextN = 0;
  const compacting: Promise<unknown>[] = [];
  await Promise.all(
    Array.from({ length: writers }, async (_, w) => {
      for (let i = 0; i < perWriter; i++) {
        const key = `w${w}:k${i}`;
        const value = { n: nextN++, pad: 'z'.repeat(400) };
        try {
          await db.set(key, value);
          acked.set(key, value);
          if (compactsAt.has(acked.size)) compacting.push(db.compact());
        } catch (err) {
          failures.push(err);
        }
      }
    }),
  );
  await Promise.all(compacting);
  return { acked, failures };
}

// ===========================================================================
// Bug evidence: WAL compaction rotation is not atomic with respect to writers
// ===========================================================================

// The rotation gate only parks writers that call set() AFTER _rotateLock is
// assigned; writers that already passed the check (and are suspended between
// it and wal.append) still append into the OLD WAL inside the critical
// section. Frames appended past the rotation's endOffset are lost even though
// the write returned success, so acknowledged keys vanish after reopen.
test(
  'stress: acknowledged writes must never be lost by a WAL rotation (memory mode)',
  { timeout: 120_000 },
  async () => {
    const dir = await tmpDir('minidb-stress-rotmem-');
    const db = await MiniDb.open<{ n: number; pad: string }>({ dir, valueCodec: 'json', fsyncPolicy: 'always' });
    await db.createIndex('n', { field: 'n', unique: true });
    const { acked, failures } = await driveStormWithRotation(db, {});
    expect(db.stats.compactions).toBeGreaterThan(0);
    // No write may fail spuriously ("WAL is closed") during normal operation.
    expect(failures, `spurious write failures: ${fmtErrs(failures)}`).toEqual([]);
    await db.close();

    const db2 = await MiniDb.open<{ n: number; pad: string }>({ dir, valueCodec: 'json' });
    const lost: string[] = [];
    for (const [key] of acked) if (db2.get(key) === undefined) lost.push(key);
    expect(lost, `${lost.length} acknowledged writes lost after rotation`).toEqual([]);
    await db2.close();
    await rmrf(dir);
  },
);

// Same rotation race in valueMode 'disk': a record whose WAL pointer is
// published against the rotated-away file points at the wrong bytes, so reads
// of acknowledged keys return other frames' payloads (or throw) — silent data
// corruption on the live database, still there after a reopen.
test(
  'stress: acknowledged writes must stay readable and exact under rotation (disk mode)',
  { timeout: 120_000 },
  async () => {
    const dir = await tmpDir('minidb-stress-rotdisk-');
    const opts = { dir, valueCodec: 'json' as const, valueMode: 'disk' as const, fsyncPolicy: 'always' as const };
    const db = await MiniDb.open<{ n: number; pad: string }>(opts);
    await db.createIndex('n', { field: 'n', unique: true });
    const { acked, failures } = await driveStormWithRotation(db, {});
    expect(failures, `spurious write failures: ${fmtErrs(failures)}`).toEqual([]);

    const wrong: string[] = [];
    for (const [key, value] of acked) {
      let got: { n: number; pad: string } | undefined;
      expect(() => {
        got = db.get(key);
      }, `read of acknowledged key ${key} threw`).not.toThrow();
      if (JSON.stringify(got) !== JSON.stringify(value)) wrong.push(key);
    }
    expect(wrong, `${wrong.length} acknowledged keys return corrupted values`).toEqual([]);
    await db.close();

    const db2 = await MiniDb.open<{ n: number; pad: string }>(opts);
    const lost: string[] = [];
    for (const [key] of acked) if (db2.get(key) === undefined) lost.push(key);
    expect(lost, `${lost.length} acknowledged writes lost after rotation`).toEqual([]);
    await db2.close();
    await rmrf(dir);
  },
);

// ===========================================================================
// Bug evidence: recovery truncation desynchronizes the WAL offsets
// ===========================================================================

// MiniDb.open opens the WAL (capturing size/nextOffset) BEFORE recovery
// truncates a torn tail; the WAL object keeps stale offsets afterwards. New
// writes in valueMode 'disk' publish value pointers shifted by the truncated
// byte count, so get() reads the NEXT frame's payload (or hits a short read),
// and compaction dies trying to read through the same stale pointers.
test(
  'stress: torn-tail recovery must not desync later writes (disk mode)',
  { timeout: 60_000 },
  async () => {
    const dir = await tmpDir('minidb-stress-torn-');
    const opts = { dir, valueCodec: 'buffer' as const, valueMode: 'disk' as const, fsyncPolicy: 'no' as const };
    const seedVal = Buffer.alloc(256, 0xa5);
    {
      const db = await MiniDb.open<Buffer>(opts);
      for (let i = 0; i < 50; i++) await db.set(`seed${i}`, seedVal);
      await db.close();
    }
    // Crash-simulated torn frame at the WAL tail.
    const torn = Buffer.concat([Buffer.from([0x4d, 0x44, 1, 0, 5, 0]), Buffer.alloc(97, 0xff)]);
    await fs.appendFile(path.join(dir, 'db.wal'), torn);

    const db = await MiniDb.open<Buffer>(opts);
    try {
      expect(db.recoveryInfo?.truncatedWal, 'recovery must truncate the torn tail').toBe(true);
      const post = (i: number): Buffer => Buffer.alloc(200 + i, (i * 13) % 251);
      for (let i = 0; i < 40; i++) await db.set(`post${i}`, post(i));
      for (let i = 0; i < 40; i++) expect(db.get(`post${i}`), `get(post${i})`).toEqual(post(i));
      for (let i = 0; i < 50; i++) expect(db.get(`seed${i}`), `get(seed${i})`).toEqual(seedVal);
      await db.compact();
      for (let i = 0; i < 40; i++) expect(db.get(`post${i}`), `post-compact get(post${i})`).toEqual(post(i));
      for (let i = 0; i < 50; i++) expect(db.get(`seed${i}`), `post-compact get(seed${i})`).toEqual(seedVal);
    } finally {
      await db.close().catch(() => {});
    }

    const db3 = await MiniDb.open<Buffer>(opts);
    try {
      for (let i = 0; i < 40; i++) {
        const want = Buffer.alloc(200 + i, (i * 13) % 251);
        expect(db3.get(`post${i}`), `reopened get(post${i})`).toEqual(want);
      }
      for (let i = 0; i < 50; i++) expect(db3.get(`seed${i}`), `reopened get(seed${i})`).toEqual(seedVal);
    } finally {
      await db3.close();
      await rmrf(dir);
    }
  },
);

// ===========================================================================
// Bug evidence: stale-lock takeover admits multiple owners
// ===========================================================================

// LockFile.acquire unlinks a stale lock and retries blindly. When several
// processes race to take over a crashed owner's lock, the loser's unlink can
// delete the winner's fresh lock file (and ENOENT on readFile is also treated
// as "stale"), so many racers end up believing they hold the lock at once —
// i.e. several writers on one database directory.
test(
  'stress: a stale lock must be taken over by exactly one process',
  { timeout: 180_000 },
  async () => {
    const dir = await tmpDir('minidb-stress-lock-');
    const lockPath = path.join(dir, 'db.lock');
    const RACER = path.join(__dirname, 'helpers', 'lock-racer.ts');
    const DEAD_PID = 2 ** 30 - 3;
    // 6-way simultaneous takeover still exposes any cascade (the historical
    // failure mode grants everyone the lock), while fitting the test's process
    // budget on 2-core runners (every racer is a full node+tsx child).
    const RACERS = 6;
    const ROUNDS = 25;

    const outputs: string[] = [];
    const children = Array.from({ length: RACERS }, () => {
      const child = spawn(process.execPath, ['--import', 'tsx', RACER, lockPath, dir, String(ROUNDS)], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        let j;
        while ((j = buf.indexOf('\n')) >= 0) {
          outputs.push(buf.slice(0, j));
          buf = buf.slice(j + 1);
        }
      });
      return child;
    });

    const violations: string[] = [];
    try {
      // Wait for every racer to be parked at the gate, otherwise boot stagger
      // (exports finish importing at very different times) makes the first
      // rounds measure sequential acquisitions as exclusivity violations.
      for (;;) {
        if (outputs.filter((l) => l === 'READY').length >= RACERS) break;
        await new Promise((res) => setTimeout(res, 5));
      }
      for (let r = 0; r < ROUNDS; r++) {
        await fs.writeFile(lockPath, JSON.stringify({ pid: DEAD_PID, ts: Date.now() }));
        await fs.writeFile(`${dir}/go-${r}`, '1');
        const want = `R${r} `;
        for (;;) {
          const lines = outputs.filter((l) => l.startsWith(want));
          if (lines.length >= RACERS) {
            const holders = lines.filter((l) => l.endsWith(' 1'));
            if (holders.length !== 1) violations.push(`round ${r}: ${holders.length} holders (${holders.join(', ')})`);
            break;
          }
          await new Promise((res) => setTimeout(res, 1));
        }
        await fs.unlink(`${dir}/go-${r}`).catch(() => {});
      }
      expect(violations, `lock takeover violated exclusivity:\n${violations.slice(0, 10).join('\n')}`).toEqual([]);
    } finally {
      for (const c of children) c.kill('SIGKILL');
      await rmrf(dir).catch(() => {});
    }
  },
);

// ===========================================================================
// Bug evidence: read-only opener compacts (and destroys) a live database
// ===========================================================================

// MiniDb.open() runs `if (db.autoCompact && shouldCompact(db)) compact(db)`
// with no readOnly guard. A read-only opener of a hot database renames
// db.snapshot/db.wal out from under the LIVE writer; the writer keeps writing
// into an unlinked inode and every subsequent acknowledged write is lost.
test(
  'stress: a read-only open must never modify the database or break a live writer',
  { timeout: 60_000 },
  async () => {
    const dir = await tmpDir('minidb-stress-rocompact-');
    const writer = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'always' });
    for (let i = 0; i < 20; i++) await writer.set(`before${i}`, { i, pad: 'x'.repeat(400) });

    const reader = await MiniDb.open({ dir, valueCodec: 'json', onLockFail: 'readonly', compactThresholdBytes: 1024 });
    expect(reader.readOnly).toBe(true);
    expect(reader.stats.compactions, 'read-only instance ran a compaction').toBe(0);
    await reader.close();

    for (let i = 0; i < 10; i++) await writer.set(`after${i}`, { i });
    await writer.close();

    const check = await MiniDb.open({ dir, valueCodec: 'json' });
    let afterLive = 0;
    let beforeLive = 0;
    for (let i = 0; i < 10; i++) if (check.get(`after${i}`) !== undefined) afterLive++;
    for (let i = 0; i < 20; i++) if (check.get(`before${i}`) !== undefined) beforeLive++;
    expect(beforeLive).toBe(20);
    expect(afterLive, 'writes acknowledged by the live writer after a read-only open').toBe(10);
    await check.close();
    await rmrf(dir);
  },
);

// A read-only open of an empty directory must not create files either.
test('stress: a read-only open of an empty dir creates no files', { timeout: 30_000 }, async () => {
  const dir = await tmpDir('minidb-stress-rofiles-');
  const ro = await MiniDb.open({ dir, readOnly: true });
  await ro.close();
  const files = await fs.readdir(dir);
  expect(files).toEqual([]);
  await rmrf(dir);
});

// ===========================================================================
// Bug evidence: one oversized token permanently destroys a text index
// ===========================================================================

// Postings records cap termLen at uint16. A single document carrying a
// >64KiB token makes every later postings rebuild (run by compaction) throw
// AFTER the delta + base dictionaries were already cleared — the whole text
// index is silently emptied, searches return nothing, and every compaction
// from then on fails (while stats.compactions still counts them as done).
test(
  'stress: a single oversized token must not poison the text index and compaction',
  { timeout: 60_000 },
  async () => {
    const dir = await tmpDir('minidb-stress-textpoison-');
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    await db.createTextIndex('docs', { fields: ['body'] });
    await db.set('normal', { body: 'hello world' });
    await db.set('poison', { body: `${'a'.repeat(70_000)} hello` });

    // Compaction must keep working regardless of document content.
    await expect(db.compact(), 'compaction failed because of a document').resolves.toBeUndefined();
    // The index must still answer instead of silently returning nothing.
    expect(db.search('docs', 'hello').map((h) => h.key).sort(), 'search after compaction').toEqual([
      'normal',
      'poison',
    ]);
    await db.close();
    await rmrf(dir);
  },
);

// ===========================================================================
// Bug evidence: dt-ordered query fast path returns different rows
// ===========================================================================

// query() takes a fast path when a single dt column is bounded and limit is
// set; the fast path ignores the dt cond's own offset/count while the general
// path honors them, so the same predicate returns different rows depending on
// whether `limit` is present.
test(
  'stress: dt-ordered fast path must agree with the general path on offset/count',
  { timeout: 30_000 },
  async () => {
    const dir = await tmpDir('minidb-stress-dtfast-');
    const db = await MiniDb.open({ dir, valueCodec: 'json' });
    for (let i = 0; i < 10; i++) await db.set(`d${i}`, { v: i }, { dt: { t: i * 10 } });
    const general = db.query({ dt: { t: { offset: 3, count: 4 } } }).map((r) => r.key);
    const fast = db.query({ dt: { t: { offset: 3, count: 4 } }, limit: 10 }).map((r) => r.key);
    expect(fast).toEqual(general);
    await db.close();
    await rmrf(dir);
  },
);

// ===========================================================================
// Bug evidence: RESP server emits out-of-order replies
// ===========================================================================

// Each socket 'data' event spawns its own async handler, so a slow command in
// one packet (SET with fsync 'always') races socket.write()s from faster
// commands in the next packet. Replies then arrive out of order and pipelined
// clients desynchronize.
test(
  'stress: RESP server must serialize replies per connection',
  { timeout: 60_000 },
  async () => {
    const dir = await tmpDir('minidb-stress-resp-');
    const { port, close } = await startServer({ dir, port: 0, fsyncPolicy: 'always' });
    const SET = '*3\r\n$3\r\nSET\r\n$4\r\nkey1\r\n$1000\r\n' + 'v'.repeat(1000) + '\r\n';
    const PING = 'PING\r\n';

    const round = (): Promise<string> =>
      new Promise((resolve, reject) => {
        const sock = net.createConnection(port, '127.0.0.1');
        let buf = '';
        sock.on('data', (d) => (buf += String(d)));
        sock.on('error', reject);
        sock.write(SET);
        setTimeout(() => sock.write(PING.repeat(20)), 1);
        setTimeout(() => {
          sock.end();
          resolve(buf);
        }, 300);
      });

    let inverted = 0;
    const ROUNDS = 12;
    try {
      for (let r = 0; r < ROUNDS; r++) {
        const reply = await round();
        const okIdx = reply.indexOf('+OK');
        const pongIdx = reply.indexOf('+PONG');
        if (pongIdx !== -1 && (okIdx === -1 || pongIdx < okIdx)) inverted++;
      }
      expect(inverted, `${inverted}/${ROUNDS} connections saw PINGs answered before the earlier SET`).toBe(0);
    } finally {
      await close();
      await rmrf(dir);
    }
  },
);

// ===========================================================================
// Coverage: torn-tail recovery in memory mode
// ===========================================================================
test(
  'stress: torn-tail recovery in memory mode stays correct across compaction',
  { timeout: 60_000 },
  async () => {
    const dir = await tmpDir('minidb-stress-tornmem-');
    const opts = { dir, valueCodec: 'json' as const, fsyncPolicy: 'no' as const };
    const want = new Map<string, unknown>();
    {
      const db = await MiniDb.open(opts);
      for (let i = 0; i < 50; i++) {
        const v = { i, pad: 's'.repeat(200) };
        await db.set(`seed${i}`, v);
        want.set(`seed${i}`, v);
      }
      await db.close();
    }
    const torn = Buffer.concat([Buffer.from([0x4d, 0x44, 1, 0, 5, 0]), Buffer.alloc(97, 0xff)]);
    await fs.appendFile(path.join(dir, 'db.wal'), torn);

    const db = await MiniDb.open(opts);
    try {
      expect(db.recoveryInfo?.truncatedWal).toBe(true);
      for (let i = 0; i < 40; i++) {
        const v = { i, pad: 'p'.repeat(240) };
        await db.set(`post${i}`, v);
        want.set(`post${i}`, v);
      }
      await db.compact();
    } finally {
      await db.close().catch(() => {});
    }
    const db2 = await MiniDb.open(opts);
    try {
      expect(db2.size).toBe(want.size);
      for (const [key, value] of want) expect(db2.get(key), `recovered ${key}`).toEqual(value);
    } finally {
      await db2.close();
      await rmrf(dir);
    }
  },
);

// ===========================================================================
// Coverage: mass TTL expiry racing compaction and reopen
// ===========================================================================
test('stress: mass TTL expiry across compaction and reopen', { timeout: 90_000 }, async () => {
  const dir = await tmpDir('minidb-stress-ttl-');
  const KEEP = 300;
  const EPHEM = 700;
  const db = await MiniDb.open<{ i: number; pad?: string }>({
    dir,
    valueCodec: 'json',
    fsyncPolicy: 'no',
    compactThresholdBytes: 48 * 1024,
  });
  try {
    for (let i = 0; i < KEEP; i++) await db.set(`keep${i}`, { i }, { dt: { created: 1_000_000 + i } });
    for (let i = 0; i < EPHEM; i++) await db.set(`temp${i}`, { i, pad: 'z'.repeat(300) }, { ttl: 80 });
    for (let i = 0; i < 120; i++) await db.set(`churn${i}`, { i, pad: 'q'.repeat(900) });
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 0; i < 120; i++) await db.del(`churn${i}`);

    expect(db.size).toBe(KEEP);
    for (let i = 0; i < EPHEM; i++) expect(db.get(`temp${i}`), `temp${i} must be gone`).toBeUndefined();
    expect(db.scan().length).toBe(KEEP);
    expect(db.dtRange('created').length).toBe(KEEP);
  } finally {
    await db.close().catch(() => {});
  }
  const db2 = await MiniDb.open<{ i: number }>({ dir, valueCodec: 'json' });
  try {
    expect(db2.size, 'reopened size').toBe(KEEP);
    expect(db2.scan().length).toBe(KEEP);
    for (let i = 0; i < KEEP; i++) expect(db2.get(`keep${i}`)).toEqual({ i });
    for (let i = 0; i < EPHEM; i++) expect(db2.has(`temp${i}`), `temp${i} resurrected`).toBe(false);
    expect(db2.dtRange('created').length).toBe(KEEP);
  } finally {
    await db2.close();
    await rmrf(dir);
  }
});

// ===========================================================================
// Coverage: full-text index consistency under churn, compaction, reopen
// ===========================================================================
test(
  'stress: full-text index stays consistent under churn, compaction, reopen',
  { timeout: 120_000 },
  async () => {
    const dir = await tmpDir('minidb-stress-text-');
    const VOCAB = Array.from({ length: 120 }, (_, i) => `tok${i}`);
    const rng = mulberry32(42);
    const model = new Map<string, string>();
    const liveHits = (term: string): string[] =>
      [...model].filter(([, b]) => b.split(' ').includes(term)).map(([k]) => k).sort();

    const db = await MiniDb.open<{ body: string }>({ dir, valueCodec: 'json', fsyncPolicy: 'no', compactThresholdBytes: 48 * 1024 });
    try {
      await db.createTextIndex('docs', { fields: ['body'] });
      for (let iter = 0; iter < 1500; iter++) {
        const key = `d${Math.floor(rng() * 300)}`;
        if (rng() < 0.25) {
          await db.del(key);
          model.delete(key);
        } else {
          const body = Array.from({ length: 8 + Math.floor(rng() * 24) }, () => VOCAB[Math.floor(rng() * VOCAB.length)]).join(' ');
          await db.set(key, { body });
          model.set(key, body);
        }
        if (iter % 250 === 249) {
          for (const term of ['tok5', 'tok77']) {
            const hits = db.search('docs', term, { limit: 10_000 }).map((h) => h.key).sort();
            expect(hits, `iter ${iter}: search("${term}")`).toEqual(liveHits(term));
          }
        }
      }
    } finally {
      await db.close().catch(() => {});
    }
    const db2 = await MiniDb.open<{ body: string }>({ dir, valueCodec: 'json' });
    try {
      for (const term of ['tok5', 'tok77']) {
        const hits = db2.search('docs', term, { limit: 10_000 }).map((h) => h.key).sort();
        expect(hits, `after reopen: search("${term}")`).toEqual(liveHits(term));
      }
    } finally {
      await db2.close();
      await rmrf(dir);
    }
  },
);

// ===========================================================================
// Coverage: evict-lru under churn — budget holds, key set matches after reopen
// ===========================================================================
test(
  'stress: evict-lru under compaction churn — no resurrection, strict budget',
  { timeout: 120_000 },
  async () => {
    const dir = await tmpDir('minidb-stress-lru-');
    const budget = 192 * 1024;
    const db = await MiniDb.open<{ i: number; pad: string }>({
      dir,
      valueCodec: 'json',
      fsyncPolicy: 'no',
      maxMemoryBytes: budget,
      maxMemoryPolicy: 'evict-lru',
      compactThresholdBytes: 64 * 1024,
    });
    try {
      for (let i = 0; i < 2500; i++) {
        await db.set(`ek${i}`, { i, pad: 'e'.repeat(1100) });
        if (i % 7 === 0) db.get(`ek${Math.max(0, i - 3)}`);
      }
      expect(db.stats.compactions).toBeGreaterThan(0);
      expect(db.store.bytes).toBeLessThanOrEqual(Math.ceil(budget * 1.05));
      expect(db.stats.evictions).toBeGreaterThan(0);
    } catch (err) {
      await db.close().catch(() => {});
      await rmrf(dir).catch(() => {});
      throw err;
    }
    const before = new Map(db.scan().map((e) => [e.key, e.value] as const));
    await db.close();

    const db2 = await MiniDb.open<{ i: number; pad: string }>({ dir, valueCodec: 'json' });
    try {
      const after = new Map(db2.scan().map((e) => [e.key, e.value] as const));
      expect(after.size, 'reopened key set must equal pre-close key set').toBe(before.size);
      for (const [key, value] of before) {
        expect(after.get(key), `value of ${key} changed across reopen`).toEqual(value);
      }
    } finally {
      await db2.close();
      await rmrf(dir);
    }
  },
);

// ===========================================================================
// Coverage: maxMemory reject leaves the db consistent and writable
// ===========================================================================
test('stress: maxMemory reject leaves the db consistent and writable', { timeout: 60_000 }, async () => {
  const dir = await tmpDir('minidb-stress-reject-');
  const db = await MiniDb.open<{ i: number; pad: string }>({
    dir,
    valueCodec: 'json',
    maxMemoryBytes: 32 * 1024,
    maxMemoryPolicy: 'reject',
  });
  let ok = 0;
  let rej = 0;
  try {
    for (let i = 0; i < 400; i++) {
      try {
        await db.set(`rk${i}`, { i, pad: 'r'.repeat(400) });
        ok++;
      } catch (err) {
        rej++;
        expect(String((err as Error).message)).toMatch(/maxMemory/);
      }
    }
    expect(ok).toBeGreaterThan(0);
    expect(rej).toBeGreaterThan(0);
    for (let i = 0; i < 400; i++) {
      const v = db.get(`rk${i}`);
      if (v !== undefined) expect(v).toEqual({ i, pad: 'r'.repeat(400) });
    }
    for (let i = 0; i < 400; i += 2) await db.del(`rk${i}`);
    await db.set('post-reject', { i: -1, pad: 'ok' });
    expect(db.get('post-reject')).toEqual({ i: -1, pad: 'ok' });
  } catch (err) {
    await db.close().catch(() => {});
    await rmrf(dir).catch(() => {});
    throw err;
  }
  const before = new Map(db.scan().map((e) => [e.key, e.value] as const));
  await db.close();

  const db2 = await MiniDb.open<{ i: number; pad: string }>({ dir, valueCodec: 'json' });
  try {
    const after = new Map(db2.scan().map((e) => [e.key, e.value] as const));
    expect(after.size).toBe(before.size);
    for (const [key, value] of before) expect(after.get(key), key).toEqual(value);
  } finally {
    await db2.close();
    await rmrf(dir);
  }
});

// ===========================================================================
// Coverage: read-only openers alongside a live compacting writer
// ===========================================================================
test('stress: read-only openers alongside a live compacting writer', { timeout: 90_000 }, async () => {
  const dir = await tmpDir('minidb-stress-ro-');
  const writer = await MiniDb.open<{ n: number; pad: string }>({
    dir,
    valueCodec: 'json',
    fsyncPolicy: 'no',
    compactThresholdBytes: 96 * 1024,
    autoCompact: true,
  });
  const errors: unknown[] = [];
  let n = 0;
  const stop = Date.now() + 5000;
  const wf = (async (): Promise<void> => {
    while (Date.now() < stop) {
      await writer.set(`rk${n}`, { n, pad: 'w'.repeat(700) });
      n++;
    }
  })();
  try {
    while (Date.now() < stop) {
      try {
        const ro = await MiniDb.open({ dir, valueCodec: 'json', onLockFail: 'readonly', autoCompact: false });
        const rows = ro.scan();
        for (const r of rows) expect(r.key).toMatch(/^rk\d+$/);
        await ro.close();
      } catch (err) {
        errors.push(err);
      }
      await new Promise((r) => setTimeout(r, 40));
    }
  } finally {
    await wf;
    await writer.close();
  }
  expect(errors, `read-only failures: ${fmtErrs(errors)}`).toEqual([]);
  const db = await MiniDb.open<{ n: number }>({ dir, valueCodec: 'json' });
  try {
    expect(db.size).toBe(n);
    for (let i = 0; i < n; i++) expect(db.get(`rk${i}`)).toEqual({ n: i, pad: 'w'.repeat(700) });
  } finally {
    await db.close();
    await rmrf(dir);
  }
});

// ===========================================================================
// Coverage: batch durability under churn + explicit rotation storm
// ===========================================================================
test('stress: batch durability under compaction churn', { timeout: 120_000 }, async () => {
  const dir = await tmpDir('minidb-stress-batch-');
  const db = await MiniDb.open<{ ts: string; j: number; pad: string }>({
    dir,
    valueCodec: 'json',
    fsyncPolicy: 'no',
    compactThresholdBytes: 64 * 1024,
  });
  const acked = new Map<string, { ts: string; j: number; pad: string }>();
  const failures: unknown[] = [];
  const writers = Promise.all(
    Array.from({ length: 12 }, async (_, w) => {
      for (let i = 0; i < 120; i++) {
        const ts = `b${w}:${i}`;
        const ops = Array.from({ length: 8 }, (_, j) => {
          const value = { ts, j, pad: 'b'.repeat(300) };
          return { op: 'set' as const, key: `${ts}:${j}`, value };
        });
        try {
          await db.batch(ops);
          for (const o of ops) acked.set(o.key, o.value);
        } catch (err) {
          failures.push(err);
        }
      }
    }),
  );
  const rotations = (async () => {
    for (let r = 0; r < 25; r++) await db.compact().catch(() => {});
  })();
  try {
    await Promise.all([writers, rotations]);
    expect(db.stats.compactions).toBeGreaterThan(0);
    expect(failures, `spurious batch failures: ${fmtErrs(failures)}`).toEqual([]);
  } finally {
    await db.close().catch(() => {});
  }
  const db2 = await MiniDb.open<{ ts: string; j: number; pad: string }>({ dir, valueCodec: 'json' });
  try {
    expect(db2.size).toBe(acked.size);
    for (const [key, value] of acked) expect(db2.get(key), key).toEqual(value);
  } finally {
    await db2.close();
    await rmrf(dir);
  }
});

// ===========================================================================
// Coverage: oversized batches reject cleanly, apply nothing, db stays usable
// ===========================================================================
test('stress: a >65535-op batch rejects cleanly and applies nothing', { timeout: 60_000 }, async () => {
  const dir = await tmpDir('minidb-stress-bigbatch-');
  const db = await MiniDb.open({ dir, valueCodec: 'json' });
  const ops = Array.from({ length: 65_536 }, (_, i) => ({ op: 'set' as const, key: `k${i}`, value: { i } }));
  await expect(db.batch(ops)).rejects.toThrow();
  expect(db.size).toBe(0);
  await db.set('alive', { ok: true });
  expect(db.size).toBe(1);
  await db.close();
  const db2 = await MiniDb.open({ dir, valueCodec: 'json' });
  expect(db2.get('alive')).toEqual({ ok: true });
  await db2.close();
  await rmrf(dir);
});

// ===========================================================================
// Coverage: full-feature soak with churn, compaction, reopen
// ===========================================================================
test(
  'stress soak: full-feature model consistency with churn, compaction, reopen',
  { timeout: 300_000 },
  async () => {
    const dir = await tmpDir('minidb-stress-soak-');
    const rng = mulberry32(1337);
    type Doc = { g: number; score: number; n: number; body?: string; pad?: string };
    const model = new Map<string, { doc: Doc; dt: number | null }>();
    let nextN = 0;
    let db = await MiniDb.open<Doc>({ dir, valueCodec: 'json', fsyncPolicy: 'no', compactThresholdBytes: 96 * 1024 });

    const checkAll = async (ctx: string, dbi: MiniDb<Doc>): Promise<void> => {
      const scanned = dbi.scan({});
      expect(scanned.length, `${ctx}: scan length`).toBe(model.size);
      for (const e of scanned) expect(e.value, `${ctx}: value of ${e.key}`).toEqual(model.get(e.key)!.doc);
      const byDt = dbi.dtRange('created').map((r) => r.key).sort();
      const modelDt = [...model].filter(([, v]) => v.dt !== null).map(([k]) => k).sort();
      expect(byDt, `${ctx}: dtRange('created')`).toEqual(modelDt);
      for (const g of [0, 3, 7]) {
        const hits = dbi.findEq('g', g).map((r) => r.key).sort();
        const want = [...model].filter(([, v]) => v.doc.g === g).map(([k]) => k).sort();
        expect(hits, `${ctx}: findEq(g=${g})`).toEqual(want);
      }
      const ranged = dbi.findRange('score', { min: 0, max: 100 }).map((r) => r.key).sort();
      const wantRanged = [...model].filter(([, v]) => v.doc.score >= 0 && v.doc.score <= 100).map(([k]) => k).sort();
      expect(ranged, `${ctx}: findRange(score 0..100)`).toEqual(wantRanged);
      const hits = dbi.search('docs', 'alpha', { limit: 10_000 }).map((h) => h.key).sort();
      const wantHits = [...model].filter(([, v]) => (v.doc.body ?? '').split(' ').includes('alpha')).map(([k]) => k).sort();
      expect(hits, `${ctx}: search(alpha)`).toEqual(wantHits);
    };

    try {
      await db.createIndex('g', { field: 'g' });
      await db.createIndex('score', { field: 'score', type: 'range' });
      await db.createIndex('n', { field: 'n', unique: true });
      await db.createTextIndex('docs', { fields: ['body'] });

      const VOCAB = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
      // Sequential ops: the model is exact. (Concurrent same-key ordering with
      // a model is intentionally NOT what this soak checks.)
      for (let iter = 0; iter < 3000; iter++) {
        const key = `s${Math.floor(rng() * 400)}`;
        const roll = rng();
        if (roll < 0.5) {
          const doc: Doc = {
            g: Math.floor(rng() * 8),
            score: Math.floor(rng() * 200) - 50,
            n: nextN++,
            body: Array.from({ length: 4 }, () => VOCAB[Math.floor(rng() * VOCAB.length)]).join(' '),
            pad: 'p'.repeat(50 + Math.floor(rng() * 300)),
          };
          const dt = rng() < 0.4 ? 1_700_000_000_000 + Math.floor(rng() * 1_000_000) : null;
          await db.set(key, doc, dt ? { dt: { created: dt } } : {});
          model.set(key, { doc, dt });
        } else if (roll < 0.65) {
          await db.del(key);
          model.delete(key);
        } else if (roll < 0.75) {
          const ops = Array.from({ length: 4 }, () => {
            const k = `s${Math.floor(rng() * 400)}`;
            const doc: Doc = { g: Math.floor(rng() * 8), score: Math.floor(rng() * 200) - 50, n: nextN++, body: 'alpha batch' };
            return { op: 'set' as const, key: k, value: doc };
          });
          await db.batch(ops);
          for (const o of ops) model.set(o.key, { doc: o.value, dt: null });
        } else {
          const g = Math.floor(rng() * 8);
          const hits = db.findEq('g', g);
          for (const h of hits) expect(h.value?.g).toBe(g);
        }
        if (iter % 400 === 399) await checkAll(`iter ${iter}`, db);
        if (iter % 1000 === 999 && iter < 2999) {
          await db.close();
          db = await MiniDb.open<Doc>({ dir, valueCodec: 'json', fsyncPolicy: 'no', compactThresholdBytes: 96 * 1024 });
          await checkAll(`post-reopen iter ${iter}`, db);
        }
      }
      await checkAll('final', db);
      await db.close();
      await rmrf(dir);
    } catch (err) {
      await db.close().catch(() => {});
      await rmrf(dir).catch(() => {});
      throw err;
    }
  },
);

