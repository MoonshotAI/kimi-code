// bench/import-kimi-code.js
//
// Import all workspaces + sessions from ~/.kimi-code into minidb and build a
// full-text index over the session content, then measure import + search speed.
//
// Run:  node bench/import-kimi-code.js [--data ~/.kimi-code] [--out <dir>]

import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MiniDb } from '../src/index.js';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : argv[i + 1];
};
const DATA = path.resolve(arg('data', path.join(os.homedir(), '.kimi-code')));
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), 'minidb-kimi-code-' + Date.now())));
const FULL = argv.includes('--full'); // also index full tool results (stress test)

const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const mib = (n) => (n / 1024 / 1024).toFixed(1) + ' MiB';

function extractWireText(wirePath, full = false) {
  // Pull searchable text out of the wire protocol:
  //   - user + assistant message text (context.append_message)
  //   - tool-call intent: tool name + concise args (command/pattern/path/...)
  //   - (full mode) tool-result output as well (stress test; noisy)
  const ARG_FIELDS = ['command', 'pattern', 'path', 'description', 'query', 'prompt', 'file_path'];
  let raw;
  try {
    raw = readFileSync(wirePath, 'utf8');
  } catch {
    return { text: '', messages: 0 };
  }
  const parts = [];
  let messages = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'context.append_message' && o.message && o.message.content) {
      let got = false;
      for (const c of o.message.content) {
        if (c && c.type === 'text' && typeof c.text === 'string') {
          parts.push(c.text);
          got = true;
        }
      }
      if (got) messages++;
    } else if (
      o.type === 'context.append_loop_event' &&
      o.event &&
      o.event.type === 'tool.call'
    ) {
      const e = o.event;
      const bits = [e.name];
      for (const k of ARG_FIELDS) {
        const v = e.args && e.args[k];
        if (typeof v === 'string' && v) bits.push(v.length > 2000 ? v.slice(0, 2000) : v);
      }
      parts.push(bits.join(' '));
    } else if (
      full &&
      o.type === 'context.append_loop_event' &&
      o.event &&
      o.event.type === 'tool.result'
    ) {
      const r = o.event.result;
      let out = '';
      if (typeof r === 'string') out = r;
      else if (r && typeof r.output === 'string') out = r.output;
      else if (r && typeof r.content === 'string') out = r.content;
      if (out) parts.push(out.length > 5000 ? out.slice(0, 5000) : out);
    }
  }
  return { text: parts.join('\n'), messages };
}

async function dirSize(dir) {
  let total = 0;
  async function walk(d) {
    let ents;
    try {
      ents = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        try {
          total += (await fs.stat(p)).size;
        } catch {}
      }
    }
  }
  await walk(dir);
  return total;
}

async function main() {
  console.log(`data: ${DATA}`);
  console.log(`out:  ${OUT}`);
  await fs.rm(OUT, { recursive: true, force: true });

  // workspaces
  const wsRaw = JSON.parse(readFileSync(path.join(DATA, 'workspaces.json'), 'utf8'));
  const workspaces = wsRaw.workspaces || wsRaw;

  // session index
  const lines = readFileSync(path.join(DATA, 'session_index.jsonl'), 'utf8').trim().split('\n');

  const db = await MiniDb.open({
    dir: OUT,
    valueCodec: 'json',
    fsyncPolicy: 'no',
    autoCompact: false,
  });
  await db.createTextIndex('body', { fields: ['text'] });
  await db.createIndex('byWorkspace', { field: 'workspaceName' });

  const t0 = performance.now();
  let imported = 0;
  let skipped = 0;
  let totalTextBytes = 0;
  let totalMessages = 0;
  let last = performance.now();

  for (const line of lines) {
    let meta;
    try {
      meta = JSON.parse(line);
    } catch {
      continue;
    }
    const { sessionId, sessionDir, workDir } = meta;
    const wirePath = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    if (!existsSync(wirePath)) {
      skipped++;
      continue;
    }

    let state = {};
    try {
      state = JSON.parse(readFileSync(path.join(sessionDir, 'state.json'), 'utf8'));
    } catch {}

    const { text, messages } = extractWireText(wirePath, FULL);
    totalTextBytes += Buffer.byteLength(text, 'utf8');
    totalMessages += messages;

    const wsId = path.basename(path.dirname(sessionDir)); // <workspaceId>/<sessionId>
    const ws = workspaces[wsId] || {};
    const doc = {
      title: state.title || '',
      workspaceId: wsId,
      workspaceName: ws.name || '',
      workDir: workDir || '',
      text: (state.title ? state.title + '\n' : '') + text,
      messageCount: messages,
    };
    const updated = state.updatedAt ? Date.parse(state.updatedAt) : 0;
    const created = state.createdAt ? Date.parse(state.createdAt) : 0;

    await db.set(sessionId, doc, { dt: { updated, created } });
    imported++;

    const now = performance.now();
    if (now - last > 1000) {
      const rate = (imported / (now - t0)) * 1000;
      process.stdout.write(`\r  imported ${fmt(imported)}  (${fmt(rate | 0)} sess/s, ${mib(totalTextBytes)} text)`);
      last = now;
    }
  }
  const importMs = performance.now() - t0;
  process.stdout.write('\n');

  // force a compaction so the on-disk size is the compact snapshot size
  const ct0 = performance.now();
  await db.compact();
  const compactMs = performance.now() - ct0;

  const sz = await dirSize(OUT);

  console.log(`\n=== import done ===`);
  console.log(`  sessions imported: ${fmt(imported)}  (skipped ${skipped})`);
  console.log(`  messages indexed : ${fmt(totalMessages)}`);
  console.log(`  text indexed     : ${mib(totalTextBytes)}`);
  console.log(`  import time      : ${(importMs / 1000).toFixed(1)} s  (${fmt((imported / importMs) * 1000 | 0)} sess/s, ${mib(totalTextBytes / (importMs / 1000))}/s text)`);
  console.log(`  compact time     : ${compactMs.toFixed(0)} ms`);
  console.log(`  db size on disk  : ${mib(sz)}  (${(sz / totalTextBytes).toFixed(2)}x raw text)`);
  console.log(`  postings terms   : ${fmt(db.text.get('body').postings.size)}`);
  console.log(`  indexed docs     : ${db.text.get('body').N}`);
  if (global.gc) global.gc();
  console.log(`  heap used        : ${mib(process.memoryUsage().heapUsed)}`);

  // ---- sample searches ----
  const queries = ['lark-approval', 'database compaction', '北京', 'Redis 持久化', 'worktree init', 'nonexistentxyz123'];
  console.log(`\n=== sample searches ===`);
  for (const q of queries) {
    const s0 = performance.now();
    const res = db.search('body', q, { limit: 5 });
    const ms = performance.now() - s0;
    console.log(`  "${q}"  ->  ${res.length} hits in ${ms.toFixed(1)} ms`);
    for (const r of res.slice(0, 3)) {
      const title = (r.value && r.value.title) || '';
      console.log(`     [${r.score.toFixed(3)}] ${r.value.workspaceName} :: ${title.slice(0, 60)}`);
    }
  }

  // combined query: text + dt range
  const q0 = performance.now();
  const recent = db.query({
    text: { index: 'body', q: 'database' },
    sort: { 'workspaceName': 1 },
    limit: 5,
    project: ['title', 'workspaceName'],
  });
  console.log(`\n  composed query (text "database" + sort + project) -> ${recent.length} in ${(performance.now() - q0).toFixed(1)} ms`);

  // dt range: sessions updated in the last 7 days
  const week = Date.now() - 7 * 864e5;
  const d0 = performance.now();
  const recentDt = db.dtRange('updated', { gte: week, limit: 10 });
  console.log(`  dt range (updated in last 7d) -> ${recentDt.length} shown in ${(performance.now() - d0).toFixed(2)} ms`);

  // secondary index lookup by workspace
  const w0 = performance.now();
  const byWs = db.findEq('byWorkspace', 'kimi-code-dev-1');
  console.log(`  index lookup (workspace=kimi-code-dev-1) -> ${byWs.length} in ${(performance.now() - w0).toFixed(2)} ms`);

  await db.close();
  console.log(`\ndone. db at: ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
