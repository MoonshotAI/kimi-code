// bench/message-composed.ts
//
// The exact scenario the user asked about:
//   index ALL conversational messages (user prompts + assistant text), then
//   answer: "user messages within a time window".
//
// predicate:  role === 'user' AND ts >= since (last 7 days)
//
// Three result shapes, each tells a different story:
//   A. top-50 recent (LIMIT)        — index should win (key-level intersect +
//                                     decode bounded by limit)
//   B. ALL matches (no limit)        — naive wins (minidb decodes every match)
//   C. COUNT matches                 — naive wins big (minidb has no count
//                                     path; it materializes everything then
//                                     takes .length). Motivates a count/keys
//                                     API.
//
// Run:  node --import tsx bench/message-composed.ts

import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MiniDb } from '../src/index.js';

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const LIMIT = 50;
const WINDOW_DAYS = 30;
const SINCE_DAYS = 7;

interface Msg {
  id: string;
  ts: number;
  role: 'user' | 'assistant';
  text: string;
}

function loadAllMessages(): Msg[] {
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
      const ts = typeof o.time === 'number' ? o.time : 0;
      if (o.type === 'context.append_message' && o.message) {
        let text = '';
        for (const c of o.message.content || [])
          if (c && c.type === 'text' && typeof c.text === 'string') text += c.text;
        out.push({ id: `${meta.sessionId}:u${out.length}`, ts, role: 'user', text });
      } else if (
        o.type === 'context.append_loop_event' &&
        o.event &&
        o.event.type === 'content.part' &&
        o.event.part &&
        o.event.part.type === 'text' &&
        typeof o.event.part.text === 'string'
      ) {
        out.push({ id: `${meta.sessionId}:a${out.length}`, ts, role: 'assistant', text: o.event.part.text });
      }
    }
  }
  return out;
}

function scaleTo(real: Msg[], n: number): Msg[] {
  const now = Date.now();
  const span = WINDOW_DAYS * 864e5;
  const out: Msg[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = real[i % real.length]!;
    out[i] = { id: `m${i}`, ts: now - Math.floor((i / n) * span), role: r.role, text: r.text };
  }
  return out;
}

async function buildMinidb(msgs: Msg[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minidb-mc-'));
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  await db.createIndex('byRole', { field: 'role' });
  const t0 = performance.now();
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
  const userTotal = msgs.filter((m) => m.role === 'user').length;
  const { db, buildMs, dir } = await buildMinidb(msgs);

  // A. top-50 recent user in window
  let aHits = 0;
  const aDb = med(() => {
    aHits = db.query({
      dt: { ts: { gte: since } },
      filter: { role: 'user' },
      sort: { ts: -1 },
      limit: LIMIT,
    }).length;
  });
  const aNaive = med(() => {
    aHits = msgs.filter((m) => m.role === 'user' && m.ts >= since).sort((a, b) => b.ts - a.ts).slice(0, LIMIT).length;
  });

  // B. ALL user in window (no limit)
  let bDbHits = 0;
  const bDb = med(() => {
    bDbHits = db.query({ dt: { ts: { gte: since } }, filter: { role: 'user' } }).length;
  });
  let bNaiveHits = 0;
  const bNaive = med(() => {
    bNaiveHits = msgs.filter((m) => m.role === 'user' && m.ts >= since).length;
  });

  // C. COUNT user in window (minidb has no count path -> materialize then .length)
  const cDb = med(() => {
    db.query({ dt: { ts: { gte: since } }, filter: { role: 'user' } });
  });
  let cNaive = 0;
  const cNaiveMs = med(() => {
    let c = 0;
    for (const m of msgs) if (m.role === 'user' && m.ts >= since) c++;
    cNaive = c;
  });

  if (global.gc) global.gc();
  const heap = process.memoryUsage().heapUsed;
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });

  console.log(`\n--- ${label}: N=${fmt(msgs.length)} msgs (user=${fmt(userTotal)}) ---`);
  console.log(`  build: minidb ${(buildMs / 1000).toFixed(2)}s | heap ${(heap / 1024 / 1024).toFixed(0)} MiB`);
  console.log(
    `  A top-${LIMIT}:  minidb ${aDb.toFixed(3)} ms  vs  naive ${aNaive.toFixed(3)} ms  ->  ${(aNaive / aDb).toFixed(1)}x  (hits ${aHits})`,
  );
  console.log(
    `  B ALL:     minidb ${bDb.toFixed(3)} ms  vs  naive ${bNaive.toFixed(3)} ms  ->  ${(bNaive / bDb).toFixed(2)}x  (hits ${fmt(bDbHits)}/${fmt(bNaiveHits)})`,
  );
  console.log(
    `  C COUNT:   minidb ${cDb.toFixed(3)} ms  vs  naive ${cNaiveMs.toFixed(3)} ms  ->  ${(cNaiveMs / cDb).toFixed(2)}x  (count ${fmt(cNaive)})`,
  );
}

async function main() {
  const real = loadAllMessages();
  const byRole = real.reduce((a: any, m) => ((a[m.role] = (a[m.role] || 0) + 1), a), {});
  console.log(`loaded ${fmt(real.length)} real messages: ${JSON.stringify(byRole)}`);
  for (const n of [real.length, 100_000, 1_000_000]) {
    const msgs = n === real.length ? real : scaleTo(real, n);
    await runCase(n === real.length ? 'real data' : 'scaled', msgs);
  }
  console.log('\ndone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
