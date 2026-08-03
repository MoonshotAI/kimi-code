// bench/search-kimi-code.js
//
// Import ~/.kimi-code sessions (useful extraction) and full-text-search for a
// query, printing hits with context snippets.
//
// Run:  node bench/search-kimi-code.js <query>  [--full]

import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MiniDb } from '../src/index.js';

const argv = process.argv.slice(2);
const FULL = argv.includes('--full');
const query = argv.find((a) => !a.startsWith('--'));
if (!query) {
  console.error('usage: node bench/search-kimi-code.js <query> [--full]');
  process.exit(1);
}

const DATA = path.join(os.homedir(), '.kimi-code');
const ARG_FIELDS = ['command', 'pattern', 'path', 'description', 'query', 'prompt', 'file_path'];

function extractWireText(wirePath, full) {
  let raw;
  try {
    raw = readFileSync(wirePath, 'utf8');
  } catch {
    return '';
  }
  const parts = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o;
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
      const bits = [e.name];
      for (const k of ARG_FIELDS) {
        const v = e.args && e.args[k];
        if (typeof v === 'string' && v) bits.push(v.length > 2000 ? v.slice(0, 2000) : v);
      }
      parts.push(bits.join(' '));
    } else if (full && o.type === 'context.append_loop_event' && o.event && o.event.type === 'tool.result') {
      const r = o.event.result;
      const out = typeof r === 'string' ? r : r && (r.output || r.content);
      if (typeof out === 'string' && out) parts.push(out.length > 5000 ? out.slice(0, 5000) : out);
    }
  }
  return parts.join('\n');
}

function snippet(text, q, radius = 60) {
  const i = text.indexOf(q);
  if (i === -1) return text.slice(0, radius * 2).replace(/\s+/g, ' ') + '…';
  const s = Math.max(0, i - radius);
  const e = Math.min(text.length, i + q.length + radius);
  return (s > 0 ? '…' : '') + text.slice(s, e).replace(/\s+/g, ' ') + (e < text.length ? '…' : '');
}

async function main() {
  const OUT = path.join(os.tmpdir(), 'minidb-search-' + Date.now());
  await fs.rm(OUT, { recursive: true, force: true });

  const workspaces = JSON.parse(readFileSync(path.join(DATA, 'workspaces.json'), 'utf8')).workspaces || {};
  const lines = readFileSync(path.join(DATA, 'session_index.jsonl'), 'utf8').trim().split('\n');

  const db = await MiniDb.open({ dir: OUT, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  await db.createTextIndex('body', { fields: ['text'] });

  const t0 = performance.now();
  let n = 0;
  for (const line of lines) {
    let meta;
    try {
      meta = JSON.parse(line);
    } catch {
      continue;
    }
    const wirePath = path.join(meta.sessionDir, 'agents', 'main', 'wire.jsonl');
    if (!existsSync(wirePath)) continue;
    let state = {};
    try {
      state = JSON.parse(readFileSync(path.join(meta.sessionDir, 'state.json'), 'utf8'));
    } catch {}
    const wsId = path.basename(path.dirname(meta.sessionDir));
    const ws = workspaces[wsId] || {};
    const text = (state.title ? state.title + '\n' : '') + extractWireText(wirePath, FULL);
    await db.set(meta.sessionId, {
      title: state.title || '',
      workspaceName: ws.name || '',
      workDir: meta.workDir || '',
      text,
    });
    n++;
  }
  const importMs = performance.now() - t0;

  const s0 = performance.now();
  const res = db.search('body', query, { limit: 10 });
  const ms = performance.now() - s0;

  console.log(`indexed ${n} sessions in ${(importMs / 1000).toFixed(1)}s; search "${query}" -> ${res.length} hits in ${ms.toFixed(1)}ms\n`);
  for (const r of res) {
    console.log(`[${r.score.toFixed(3)}] ${r.value.workspaceName} :: ${r.value.title}`);
    console.log(`    ${snippet(r.value.text, query)}`);
    console.log(`    ${r.key}`);
    console.log();
  }
  await db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
