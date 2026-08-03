// bench/message-range.ts
//
// Benchmarks the "show me the user's most recent messages" query:
//   predicate:  role === 'user' AND ts >= since (last 7 days)
//   order:      ts DESC
//   limit:      50   (the typical "recent N" UI pattern)
//
// This is a message-granularity range query with a SMALL LIMIT, which is a
// different shape from the session-level benches:
//   - import-kimi-code / search-baseline index whole sessions (one doc/session).
//   - the metadata lookups (workspace lookup, dt range over sessions) return
//     ALL matches, so at small N a linear filter beats the index.
// Here, an ordered dt index can walk just `limit` entries (O(log N + limit))
// instead of scanning + sorting the whole set (O(N log M)). We measure at the
// real scale (~7.2k user messages) and at scaled-up sizes to find the
// crossover where the index starts winning.
//
// Run:  node --import tsx bench/message-range.ts

import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MiniDb } from '../src/index.js';

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const LIMIT = 50;
const WINDOW_DAYS = 30; // replicated timestamps are spread over the last 30 days
const SINCE_DAYS = 7; // "recent" = last 7 days

interface Msg {
  id: string;
  ts: number;
  role: string;
  text: string;
}

function loadRealMessages(): Msg[] {
  const DATA = path.join(os.homedir(), '.kimi-code');
  const lines = readFileSync(path.join(DATA, 'session_index.jsonl'), 'utf8').trim().split('\n');
  const out: Msg[] = [];
  for (const line of lines) {
    let meta: any;
    try {
      meta = JSON.parse(line);
    } catch {
      continue;
    }
    const wire = path.join(meta.sessionDir, 'agents', 'main', 'wire.jsonl');
    if (!existsSync(wire)) continue;
    let raw: string;
    try {
      raw = readFileSync(wire, 'utf8');
    } catch {
      continue;
    }
    for (const ln of raw.split('\n')) {
      if (!ln) continue;
      let o: any;
      try {
        o = JSON.parse(ln);
      } catch {
        continue;
      }
      if (o.type !== 'context.append_message' || !o.message) continue;
      const m = o.message;
      const ts = typeof o.time === 'number' ? o.time : 0;
      let text = '';
      for (const c of m.content || [])
        if (c && c.type === 'text' && typeof c.text === 'string') text += c.text;
      out.push({ id: `${meta.sessionId}:${out.length}`, ts, role: m.role || 'user', text });
    }
  }
  return out;
}

// Replicate the real messages to N, spreading timestamps uniformly over the
// last WINDOW_DAYS so the "last SINCE_DAYS" match fraction stays ~constant.
function scaleTo(real: Msg[], n: number): Msg[] {
  const now = Date.now();
  const span = WINDOW_DAYS * 864e5;
  const out: Msg[] = Array.from({ length: n }, (_, i) => {
    const r = real[i % real.length]!;
    return {
      id: `m${i}`,
      ts: now - Math.floor((i / n) * span),
      role: r.role,
      text: r.text,
    };
  });
  return out;
}

async function buildMinidb(msgs: Msg[]): Promise<{ db: any; buildMs: number; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-msg-'));
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  const t0 = performance.now();
  // concurrent insert in chunks to avoid one giant promise array
  const CHUNK = 5000;
  for (let s = 0; s < msgs.length; s += CHUNK) {
    const p: Promise<unknown>[] = [];
    for (let i = s; i < Math.min(s + CHUNK, msgs.length); i++) {
      const m = msgs[i]!;
      p.push(db.set(m.id, { role: m.role, text: m.text }, { dt: { ts: m.ts } }));
    }
    await Promise.all(p);
  }
  return { db, buildMs: performance.now() - t0, dir };
}

function med(fn: () => void, runs = 9): number {
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  return t[(runs / 2) | 0]!;
}

async function runCase(label: string, msgs: Msg[]) {
  const since = Date.now() - SINCE_DAYS * 864e5;

  // ---- minidb dt index ----
  const { db, buildMs, dir } = await buildMinidb(msgs);
  let indexHits = 0;
  const indexMs = med(() => {
    const res = db.dtRange('ts', { gte: since, reverse: true, limit: LIMIT });
    indexHits = res.length;
  });
  // variant: return ALL matches (no limit), to mirror the earlier metadata case
  let allHits = 0;
  const indexAllMs = med(() => {
    const res = db.dtRange('ts', { gte: since });
    allHits = res.length;
  });
  if (global.gc) global.gc();
  const heap = process.memoryUsage().heapUsed;
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });

  // ---- naive baseline ----
  let naiveHits = 0;
  const naiveMs = med(() => {
    const res = msgs.filter((m) => m.ts >= since).sort((a, b) => b.ts - a.ts).slice(0, LIMIT);
    naiveHits = res.length;
  });
  let naiveAllHits = 0;
  const naiveAllMs = med(() => {
    const res = msgs.filter((m) => m.ts >= since);
    naiveAllHits = res.length;
  });

  console.log(`\n--- ${label}: N=${fmt(msgs.length)} messages ---`);
  console.log(`  build: minidb ${(buildMs / 1000).toFixed(2)}s  |  heap ${(heap / 1024 / 1024).toFixed(0)} MiB`);
  console.log(
    `  top-${LIMIT} recent:  minidb dtRange ${indexMs.toFixed(3)} ms (${indexHits})  vs  naive filter+sort ${naiveMs.toFixed(3)} ms (${naiveHits})  ->  ${(naiveMs / indexMs).toFixed(1)}x`,
  );
  console.log(
    `  ALL matches:        minidb dtRange ${indexAllMs.toFixed(3)} ms (${fmt(allHits)})  vs  naive filter ${naiveAllMs.toFixed(3)} ms (${fmt(naiveAllHits)})  ->  ${(naiveAllMs / indexAllMs).toFixed(1)}x`,
  );
}

async function main() {
  const real = loadRealMessages();
  console.log(`loaded ${fmt(real.length)} real user messages`);
  const sizes = [real.length, 100_000, 1_000_000];
  for (const n of sizes) {
    const msgs = n === real.length ? real : scaleTo(real, n);
    await runCase(n === real.length ? 'real data' : `scaled`, msgs);
  }
  console.log('\ndone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
