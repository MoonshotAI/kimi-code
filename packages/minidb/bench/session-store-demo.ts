// bench/session-store-demo.ts
//
// Demonstrate the 4 core queries against ~/.kimi-code with timing.
// Run: node --import tsx bench/session-store-demo.ts

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from './session-store.js';

const HOME = path.join(os.homedir(), '.kimi-code');
const OUT = path.join(os.tmpdir(), 'minidb-session-store-' + Date.now());

const ms = (t: number) => t.toFixed(2) + 'ms';

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  console.log(`out: ${OUT}`);

  const store = await SessionStore.open(OUT);
  const t0 = performance.now();
  const stats = await store.ingestKimiCode(HOME);
  const importMs = performance.now() - t0;
  console.log(
    `\ningested ${stats.workspaces} workspaces, ${stats.sessions} sessions (${(stats.textBytes / 1024 / 1024).toFixed(1)} MiB text) in ${ms(importMs)}`,
  );

  // 1. list workspaces
  let t = performance.now();
  const ws = store.listWorkspaces({ limit: 10 });
  console.log(`\n[1] listWorkspaces  -> ${ws.items.length} in ${ms(performance.now() - t)}`);
  for (const w of ws.items) console.log(`    ${w.id}  ${w.name}`);

  if (ws.items.length === 0) return;
  const wsId = ws.items[0]!.id;

  // 2. list sessions in workspace (page 1 + 2)
  t = performance.now();
  const p1 = store.listSessions(wsId, { limit: 5, offset: 0 });
  const p2 = store.listSessions(wsId, { limit: 5, offset: 5 });
  console.log(`\n[2] listSessions(${wsId}) page1=${p1.items.length} page2=${p2.items.length} in ${ms(performance.now() - t)}`);
  for (const s of p1.items) console.log(`    ${new Date(s.updatedAt ?? 0).toISOString().slice(0, 10)}  ${s.title.slice(0, 50)}`);

  // 3. precise get
  if (p1.items.length) {
    const sid = p1.items[0]!.sessionId;
    t = performance.now();
    const s = store.getSession(sid);
    console.log(`\n[3] getSession(${sid}) in ${ms(performance.now() - t)}`);
    console.log(`    title     : ${s?.title}`);
    console.log(`    updatedAt : ${s?.updatedAt ? new Date(s.updatedAt).toISOString() : '-'}`);
    console.log(`    wirePath  : ${s?.wirePath}`);
    console.log(`    text chars: ${s?.text.length}`);
  }

  // 4. fuzzy search
  for (const q of ['database compaction', 'lark-approval', 'Redis 持久化']) {
    t = performance.now();
    const hits = store.search(q, { limit: 3 });
    console.log(`\n[4] search("${q}") -> ${hits.length} in ${ms(performance.now() - t)}`);
    for (const h of hits) console.log(`    [${h.score.toFixed(3)}] ${h.workspaceName} :: ${h.title.slice(0, 50)}`);
  }

  // 4b. search scoped to a workspace
  t = performance.now();
  const scoped = store.search('database', { workspaceId: wsId, limit: 3 });
  console.log(`\n[4b] search("database", workspace=${wsId}) -> ${scoped.length} in ${ms(performance.now() - t)}`);

  await store.db.close();
  console.log('\ndone.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
