// bench/session-children.ts
//
// Benchmark for nested session "children" lookups.
//
// Scenario
// --------
//   Sessions form a tree (root -> child -> grandchild -> ...). Each session
//   stores its OWN id as the key (`sess:<long-id>`) and the parent link in the
//   value (`value.metadata.parent_session_id`). The relationship is NOT encoded
//   in the key, because session ids are long and a materialized path would blow
//   the 128-char key cap and duplicate the whole ancestor chain on every leaf.
//
//   We compare two ways to answer "list the direct children of session X":
//
//   1. indexed  — compound index { groupBy: 'metadata.parent_session_id',
//                  orderBy: 'updatedAt' } + db.compoundRange('byParent', X, ...)
//                  -> O(log N + fanout)
//
//   2. scan     — the legacy approach: db.scan() everything, filter by
//                 metadata.parent_session_id === X, sort by updatedAt desc.
//                 -> O(N log N)
//
// Run
// ---
//   node --import tsx bench/session-children.ts
//
// Knobs (env):
//   TOTAL      total sessions            (default 1_000)
//   FANOUT     children per parent       (default 30)
//   MAX_DEPTH  deepest generation, root=0 (default 3)
//   ITERS      query iterations to avg   (default 500)
//
// With TOTAL=1000, FANOUT=30, MAX_DEPTH=3 the tree is exactly:
//   depth0: 1, depth1: 30, depth2: 900, depth3: 69   (1000 total)

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const ops = (n: number, ms: number) => `${fmt((n / ms) * 1000)} ops/s`;

const TOTAL = Number(process.env.TOTAL || 1_000);
const FANOUT = Number(process.env.FANOUT || 30);
const MAX_DEPTH = Number(process.env.MAX_DEPTH || 3);
const ITERS = Number(process.env.ITERS || 500);

interface Node {
  id: string;
  parentId: string | null;
  depth: number;
  updatedAt: number;
}

// Long-ish session ids: `sess_` + 40 hex chars (45 chars total).
const makeId = (i: number) => `sess_${i.toString(16).padStart(40, '0')}`;

function buildTree(total: number, fanout: number, maxDepth: number): Node[] {
  const nodes: Node[] = [];
  const base = Date.parse('2024-01-01');
  let counter = 0;
  const root: Node = { id: makeId(counter++), parentId: null, depth: 0, updatedAt: base + counter };
  nodes.push(root);
  const queue: Node[] = [root];
  while (queue.length && nodes.length < total) {
    const parent = queue.shift()!;
    if (parent.depth >= maxDepth) continue;
    for (let i = 0; i < fanout && nodes.length < total; i++) {
      const child: Node = {
        id: makeId(counter++),
        parentId: parent.id,
        depth: parent.depth + 1,
        updatedAt: base + counter,
      };
      nodes.push(child);
      queue.push(child);
    }
  }
  return nodes;
}

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-children-'));
}

async function timeIt<T>(fn: () => T | Promise<T>, iters: number): Promise<{ ms: number; last: T }> {
  let last!: T;
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) last = await fn();
  return { ms: performance.now() - t0, last };
}

async function main() {
  console.log(
    `\nminidb session-children benchmark  (TOTAL=${fmt(TOTAL)}, FANOUT=${FANOUT}, MAX_DEPTH=${MAX_DEPTH}, ITERS=${ITERS}, node ${process.version})\n`,
  );

  // ---- build the tree -----------------------------------------------------
  const nodes = buildTree(TOTAL, FANOUT, MAX_DEPTH);
  const byDepth = new Map<number, number>();
  const childrenOf = new Map<string | null, string[]>();
  for (const n of nodes) {
    byDepth.set(n.depth, (byDepth.get(n.depth) ?? 0) + 1);
    const arr = childrenOf.get(n.parentId) ?? [];
    arr.push(n.id);
    childrenOf.set(n.parentId, arr);
  }
  const maxDepth = Math.max(...byDepth.keys());
  console.log(`  tree: ${fmt(nodes.length)} sessions, max depth ${maxDepth}`);
  for (const [d, c] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`    depth ${d}: ${fmt(c)} sessions`);
  }

  // Pick a parent at each depth that actually has children, for depth
  // coverage in the query benchmark.
  const parentAtDepth = new Map<number, Node>();
  for (const n of nodes) {
    if (!parentAtDepth.has(n.depth) && (childrenOf.get(n.id)?.length ?? 0) > 0) parentAtDepth.set(n.depth, n);
  }

  // ---- open + ingest ------------------------------------------------------
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });

  const tIngest = performance.now();
  const CHUNK = 500;
  for (let i = 0; i < nodes.length; i += CHUNK) {
    const slice = nodes.slice(i, i + CHUNK);
    await db.batch(
      slice.map((n) => ({
        op: 'set' as const,
        key: n.id,
        value: {
          title: `session ${n.id}`,
          workspaceId: 'ws_bench',
          // Only real children carry parent_session_id (+ kind). Roots do
            // not, so they stay out of the byParent index entirely.
            metadata: n.parentId
              ? { parent_session_id: n.parentId, child_session_kind: 'child' }
              : {},
        },
        dt: { updatedAt: n.updatedAt },
      })),
    );
  }
  const ingestMs = performance.now() - tIngest;
  console.log(`\n  ingest ${fmt(nodes.length)} sessions (batch)`.padEnd(46), `${ingestMs.toFixed(1).padStart(8)} ms`, `-> ${ops(nodes.length, ingestMs)}`);

  // ---- index build (the thing that makes children fast) -------------------
  const tIdx = performance.now();
  await db.createCompoundIndex('byParent', {
    groupBy: 'metadata.parent_session_id',
    orderBy: 'updatedAt',
  });
  const idxMs = performance.now() - tIdx;
  console.log(`  createCompoundIndex('byParent') + rebuild`.padEnd(46), `${idxMs.toFixed(1).padStart(8)} ms`);

  // ---- query benchmarks ---------------------------------------------------
  const PAGE = 20;
  console.log(`\n  listChildren(parent)  page_size=${PAGE}, averaged over ${ITERS} iters:\n`);

  for (const [depth, parent] of [...parentAtDepth.entries()].sort((a, b) => a[0] - b[0])) {
    const fanout = childrenOf.get(parent.id)!.length;

    // indexed: O(log N + fanout)
    const idx = await timeIt(
      () => db.compoundRange('byParent', parent.id, { reverse: true, limit: PAGE }),
      ITERS,
    );
    // scan (legacy): O(N log N)
    const scan = await timeIt(() => {
      const all = db.scan();
      const filtered = all.filter(
        (r) =>
          (r.value as { metadata?: Record<string, unknown> })?.metadata?.['parent_session_id'] === parent.id &&
          (r.value as { metadata?: Record<string, unknown> })?.metadata?.['child_session_kind'] === 'child',
      );
      filtered.sort((a, b) => (b.dt?.updatedAt ?? 0) - (a.dt?.updatedAt ?? 0));
      return filtered.slice(0, PAGE);
    }, ITERS);

    const idxAvg = idx.ms / ITERS;
    const scanAvg = scan.ms / ITERS;
    console.log(
      `    depth ${depth} parent (fanout=${fmt(fanout)}):`.padEnd(38),
      `indexed ${idxAvg.toFixed(3)} ms/op`.padEnd(22),
      `scan ${scanAvg.toFixed(3)} ms/op`.padEnd(20),
      `speedup x${(scanAvg / idxAvg).toFixed(1)}`,
    );
  }

  // ---- correctness spot-check ---------------------------------------------
  const root = nodes[0]!;
  const idxChildren = db.compoundRange('byParent', root.id, { reverse: true, limit: 10_000 }).map((r) => r.key);
  const expected = new Set(childrenOf.get(root.id)!);
  const ok = idxChildren.length === expected.size && idxChildren.every((k) => expected.has(k));
  console.log(`\n  correctness: indexed children of root == expected  ${ok ? 'OK' : 'MISMATCH'} (${idxChildren.length}/${expected.size})`);

  // ---- storage snapshot ---------------------------------------------------
  await db.compact();
  const snap = await fs.stat(path.join(dir, 'db.snapshot'));
  const heapMiB = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  console.log(`  storage: ${(snap.size / 1024 / 1024).toFixed(2)} MiB snapshot, heap ${heapMiB} MiB`);

  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
  console.log('\ndone.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
