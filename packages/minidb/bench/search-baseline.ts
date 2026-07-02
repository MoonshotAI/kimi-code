// bench/search-baseline.ts
//
// "Without minidb" search baseline over the SAME real ~/.kimi-code sessions
// used by import-kimi-code.ts. Loads every session's extracted text into an
// in-memory array, then answers the same queries with a naive full scan
// (substring token-AND for text, linear Array.filter for secondary index / dt
// range). Paired with import-kimi-code.ts, this shows what minidb's indexes
// buy you on real data.
//
// Run:  node --import tsx bench/search-baseline.ts [--data ~/.kimi-code]

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : argv[i + 1]!;
};
const DATA = path.resolve(arg('data', path.join(os.homedir(), '.kimi-code')));
const FULL = argv.includes('--full'); // also index full tool results (matches import-kimi-code --full)

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const mib = (n: number) => (n / 1024 / 1024).toFixed(1) + ' MiB';

interface Doc {
  sessionId: string;
  title: string;
  workspaceName: string;
  text: string;
  lower: string; // lowercased text, for naive substring search
  updated: number;
  created: number;
}

const ARG_FIELDS = ['command', 'pattern', 'path', 'description', 'query', 'prompt', 'file_path'];

function extractWireText(wirePath: string, full: boolean): string {
  let raw: string;
  try {
    raw = readFileSync(wirePath, 'utf8');
  } catch {
    return '';
  }
  const parts: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'context.append_message' && o.message && o.message.content) {
      for (const c of o.message.content)
        if (c && c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    } else if (o.type === 'context.append_loop_event' && o.event && o.event.type === 'tool.call') {
      const e = o.event;
      const bits: string[] = [e.name];
      for (const k of ARG_FIELDS) {
        const v = e.args && e.args[k];
        if (typeof v === 'string' && v) bits.push(v.length > 2000 ? v.slice(0, 2000) : v);
      }
      parts.push(bits.join(' '));
    } else if (full && o.type === 'context.append_loop_event' && o.event && o.event.type === 'tool.result') {
      const r = o.event.result;
      let out = '';
      if (typeof r === 'string') out = r;
      else if (r && typeof r.output === 'string') out = r.output;
      else if (r && typeof r.content === 'string') out = r.content;
      if (out) parts.push(out.length > 5000 ? out.slice(0, 5000) : out);
    }
  }
  return parts.join('\n');
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[\s,，。.!?！?、;；:：()\[\]{}"'<>/\\|@#%^&*+=~`\-_]+/)
    .filter((t) => t.length > 0);
}

// Naive full-text: a doc matches if every query token appears as a substring
// (AND semantics). Score = total occurrences of matched tokens. Returns top N.
function naiveTextSearch(docs: Doc[], q: string, limit: number) {
  const toks = tokenize(q);
  if (toks.length === 0) return [];
  const hits: { doc: Doc; score: number }[] = [];
  for (const d of docs) {
    let score = 0;
    let ok = true;
    for (const t of toks) {
      let idx = -1;
      let cnt = 0;
      while ((idx = d.lower.indexOf(t, idx + 1)) !== -1) cnt++;
      if (cnt === 0) {
        ok = false;
        break;
      }
      score += cnt;
    }
    if (ok) hits.push({ doc: d, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

// median of N runs
function med<T>(fn: () => T, runs = 7): { value: T; ms: number } {
  const times: number[] = [];
  let value!: T;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    value = fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { value, ms: times[(runs / 2) | 0]! };
}

async function main() {
  console.log(`data: ${DATA}`);

  const wsRaw = JSON.parse(readFileSync(path.join(DATA, 'workspaces.json'), 'utf8'));
  const workspaces = wsRaw.workspaces || wsRaw;
  const lines = readFileSync(path.join(DATA, 'session_index.jsonl'), 'utf8').trim().split('\n');

  const t0 = performance.now();
  const docs: Doc[] = [];
  let totalTextBytes = 0;
  let skipped = 0;
  for (const line of lines) {
    let meta: any;
    try {
      meta = JSON.parse(line);
    } catch {
      continue;
    }
    const { sessionId, sessionDir } = meta;
    const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    if (!existsSync(wirePath)) {
      skipped++;
      continue;
    }
    let state: any = {};
    try {
      state = JSON.parse(readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
    } catch {}
    const body = extractWireText(wirePath, FULL);
    const text = (state.title ? state.title + '\n' : '') + body;
    totalTextBytes += Buffer.byteLength(text, 'utf8');
    const wsId = path.basename(path.dirname(sessionDir));
    const ws = workspaces[wsId] || {};
    docs.push({
      sessionId,
      title: state.title || '',
      workspaceName: ws.name || '',
      text,
      lower: text.toLowerCase(),
      updated: state.updatedAt ? Date.parse(state.updatedAt) : 0,
      created: state.createdAt ? Date.parse(state.createdAt) : 0,
    });
  }
  const loadMs = performance.now() - t0;
  if (global.gc) global.gc();
  console.log(`\n=== loaded (no index) ===`);
  console.log(`  sessions loaded: ${fmt(docs.length)}  (skipped ${skipped})`);
  console.log(`  text loaded    : ${mib(totalTextBytes)}`);
  console.log(`  load+parse time: ${(loadMs / 1000).toFixed(1)} s`);
  console.log(`  heap used      : ${mib(process.memoryUsage().heapUsed)}`);

  // ---- naive full-text searches ----
  const queries = ['lark-approval', 'database compaction', '北京', 'Redis 持久化', 'worktree init', 'nonexistentxyz123'];
  console.log(`\n=== naive full-text search (full scan, median of 7) ===`);
  for (const q of queries) {
    const { value: res, ms } = med(() => naiveTextSearch(docs, q, 5));
    console.log(`  "${q}"  ->  ${res.length} hits in ${ms.toFixed(2)} ms`);
    for (const r of res.slice(0, 3)) {
      console.log(`     [${r.score}] ${r.doc.workspaceName} :: ${r.doc.title.slice(0, 60)}`);
    }
  }

  // ---- naive composed query: text includes 'database', then sort ----
  {
    const { value: res, ms } = med(() => {
      const hit = docs.filter((d) => d.lower.includes('database'));
      hit.sort((a, b) => a.workspaceName.localeCompare(b.workspaceName));
      return hit.slice(0, 5);
    });
    console.log(`\n  naive composed (text "database" + sort) -> ${res.length} in ${ms.toFixed(2)} ms`);
  }

  // ---- naive dt range: updated in last 7 days ----
  {
    const week = Date.now() - 7 * 864e5;
    const { value: res, ms } = med(() => {
      const hit = docs.filter((d) => d.updated >= week);
      hit.sort((a, b) => b.updated - a.updated);
      return hit.slice(0, 10);
    });
    console.log(`  naive dt range (updated in last 7d) -> ${res.length} shown in ${ms.toFixed(2)} ms`);
  }

  // ---- naive secondary index lookup: workspaceName ----
  {
    const { value: res, ms } = med(() => docs.filter((d) => d.workspaceName === 'kimi-code-dev-1'));
    console.log(`  naive lookup (workspace=kimi-code-dev-1) -> ${res.length} in ${ms.toFixed(2)} ms`);
  }

  console.log(`\ndone.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
