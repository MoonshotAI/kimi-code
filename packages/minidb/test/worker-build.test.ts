// test/worker-build.test.ts
//
// Stage 6: the workerized full-text generation build. Covers the build core
// (pinned-source reconstruction, segmented external merge, memory budget),
// the worker-thread orchestration (spawn/crash/cancel/OOM), and the MiniDb
// integration: ordinary get/set/search stay available during a worker build,
// a worker failure never breaks the currently published generation, and the
// inline fallback produces byte-identical artifacts.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MiniDb } from '../src/index.js';
import {
  configureTextBuildWorkerRuntime,
  getTextBuildWorkerRuntimeState,
  resetTextBuildWorkerRuntime,
} from '../src/worker-runtime.js';
import { buildTextArtifacts } from '../src/worker/text-build-core.js';
import type { TextBuildCoreSpec } from '../src/worker/text-build-core.js';
import { startWorkerTextBuild, WorkerTextBuildError, verifyFileCrcAsync } from '../src/worker/text-build.js';
import { tmpDir, rmrf, waitFor } from './helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  resetTextBuildWorkerRuntime();
  while (cleanups.length) await cleanups.pop()!();
});

async function openTmp(name: string): Promise<string> {
  const dir = await tmpDir(`minidb-wbuild-${name}-`);
  cleanups.push(() => rmrf(dir));
  return dir;
}

/** Seed docs shaped like the kap-server search corpus (varied text + CJK). */
async function seedTextDb(db: MiniDb<Record<string, unknown>>, n: number): Promise<void> {
  await db.createTextIndex('ft', { fields: ['text'] });
  await db.createTextIndex('tri', { fields: ['text'], tokenizer: 'ngram' });
  const BATCH = 500;
  for (let base = 0; base < n; base += BATCH) {
    await db.batch(
      Array.from({ length: Math.min(BATCH, n - base) }, (_, i) => {
        const k = base + i;
        return {
          op: 'set' as const,
          key: `k${k}`,
          value: { kind: `t${k % 7}`, score: k % 100, text: `hello world doc ${k} 持久化 索引 ${k % 13} token${k % 97}` },
        };
      }),
    );
  }
}

/** Seed the same corpus WITHOUT creating any text index (the data-first
 *  shape that exercises createTextIndex's full-corpus build path). */
async function seedDataOnly(db: MiniDb<Record<string, unknown>>, n: number): Promise<void> {
  const BATCH = 500;
  for (let base = 0; base < n; base += BATCH) {
    await db.batch(
      Array.from({ length: Math.min(BATCH, n - base) }, (_, i) => {
        const k = base + i;
        return {
          op: 'set' as const,
          key: `k${k}`,
          value: { kind: `t${k % 7}`, score: k % 100, text: `hello world doc ${k} 持久化 索引 ${k % 13} token${k % 97}` },
        };
      }),
    );
  }
}

/** Open + stat the pinned source of a live writer db for a core-level spec. */
async function specForLiveDb(
  db: MiniDb<Record<string, unknown>>,
  dir: string,
  tmp: string,
  overrides: Partial<TextBuildCoreSpec> = {},
): Promise<TextBuildCoreSpec> {
  await db.wal.flush();
  const walSt = fsSync.statSync(path.join(dir, 'db.wal'));
  const snapPath = path.join(dir, 'db.snapshot');
  const snapSt = fsSync.existsSync(snapPath) ? fsSync.statSync(snapPath) : null;
  return {
    snapshotPath: snapSt ? snapPath : null,
    walPath: path.join(dir, 'db.wal'),
    walOffset: walSt.size,
    walDev: walSt.dev,
    walIno: walSt.ino,
    snapshotDev: snapSt?.dev ?? 0,
    snapshotIno: snapSt?.ino ?? 0,
    indexes: [
      {
        name: 'ft',
        fields: ['text'],
        tokenizer: 'default',
        postingsPath: path.join(tmp, 'text-ft.postings'),
        dictionaryPath: path.join(tmp, 'text-ft.dictionary'),
        baseDocsPath: path.join(tmp, 'text-ft.docs.base'),
      },
      {
        name: 'tri',
        fields: ['text'],
        tokenizer: 'ngram',
        postingsPath: path.join(tmp, 'text-tri.postings'),
        dictionaryPath: path.join(tmp, 'text-tri.dictionary'),
        baseDocsPath: path.join(tmp, 'text-tri.docs.base'),
      },
    ],
    memoryBudgetBytes: 128 * 1024 * 1024,
    ...overrides,
  };
}

describe('worker orchestration (thread hosting)', () => {
  test('typed runtime configuration validates, configures once, and resets', () => {
    expect(() => configureTextBuildWorkerRuntime('relative-worker.mjs')).toThrow(/absolute path/);
    const source = new URL('../src/worker/text-build-worker.ts', import.meta.url);
    expect(configureTextBuildWorkerRuntime(source)).toMatchObject({
      configured: true,
      entry: { kind: 'source' },
    });
    expect(configureTextBuildWorkerRuntime(source)).toEqual(getTextBuildWorkerRuntimeState());
    expect(() => configureTextBuildWorkerRuntime(new URL('../src/worker/text-build-core.ts', import.meta.url))).toThrow(
      /already configured/,
    );
    resetTextBuildWorkerRuntime();
    expect(getTextBuildWorkerRuntimeState()).toEqual({ configured: false });
  });

  test('worker thread and inline fallback produce identical artifacts', async () => {
    const dir = await openTmp('parity');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedTextDb(db, 1500);
    const tmpA = await openTmp('parity-a');
    const tmpB = await openTmp('parity-b');
    const specA = await specForLiveDb(db, dir, tmpA);
    const specB = await specForLiveDb(db, dir, tmpB);

    const workerHandle = startWorkerTextBuild(specA);
    expect(workerHandle.inline).toBe(false);
    let workerExited = false;
    workerHandle.worker!.once('exit', () => {
      workerExited = true;
    });
    const [ra, rb] = await Promise.all([workerHandle.promise, buildTextArtifacts(specB)]);
    expect(workerExited).toBe(true);
    expect(workerHandle.worker).toBeNull();
    expect(ra.scannedLiveKeys).toBe(1500);
    expect(rb.scannedLiveKeys).toBe(1500);
    for (let i = 0; i < ra.indexes.length; i++) {
      const a = ra.indexes[i]!;
      const b = rb.indexes[i]!;
      expect(a.name).toBe(b.name);
      expect(a.liveCount).toBe(b.liveCount);
      expect(a.dictTerms).toBe(b.dictTerms);
      expect(a.postingsInfo).toEqual(b.postingsInfo);
      expect(a.dictionaryInfo).toEqual(b.dictionaryInfo);
      expect(a.baseDocsInfo).toEqual(b.baseDocsInfo);
      await verifyFileCrcAsync(specA.indexes[i]!.postingsPath, a.postingsInfo);
      await verifyFileCrcAsync(specB.indexes[i]!.postingsPath, b.postingsInfo);
    }
    await fs.rm(tmpA, { recursive: true });
    expect(fsSync.existsSync(tmpA)).toBe(false);
    await db.close();
  });

  test('constructor failure falls back inline for the current task', async () => {
    const dir = await openTmp('constructor-fallback');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedTextDb(db, 100);
    const tmp = await openTmp('constructor-fallback-tmp');
    const reasons: string[] = [];
    const handle = startWorkerTextBuild(await specForLiveDb(db, dir, tmp), {
      workerFactory: () => {
        throw new Error('constructor failed');
      },
      onFallback: (reason) => reasons.push(reason),
    });
    await expect(handle.promise).resolves.toMatchObject({ scannedLiveKeys: 100 });
    expect(handle.inline).toBe(true);
    expect(handle.worker).toBeNull();
    expect(handle.fallbackReason).toBe('constructor-failure');
    expect(reasons).toEqual(['constructor-failure']);
    await db.close();
  });

  test('failure before ready falls back inline for the current task', async () => {
    const dir = await openTmp('bootstrap-fallback');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedTextDb(db, 100);
    const tmp = await openTmp('bootstrap-fallback-tmp');
    const reasons: string[] = [];
    let failedWorkerExited = false;
    const handle = startWorkerTextBuild(await specForLiveDb(db, dir, tmp), {
      workerFactory: () => {
        const worker = new Worker(new URL('./missing-worker.mjs', import.meta.url));
        worker.once('exit', () => {
          failedWorkerExited = true;
        });
        return worker;
      },
      onFallback: (reason) => reasons.push(reason),
    });
    await expect(handle.promise).resolves.toMatchObject({ scannedLiveKeys: 100 });
    expect(failedWorkerExited).toBe(true);
    expect(handle.worker).toBeNull();
    expect(handle.inline).toBe(true);
    expect(handle.fallbackReason).toBe('bootstrap-failure');
    expect(reasons).toEqual(['bootstrap-failure']);
    await db.close();
  });

  test('protocol mismatch waits for delayed worker exit before inline fallback writes', async () => {
    const dir = await openTmp('protocol-fallback');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedTextDb(db, 100);
    const tmp = await openTmp('protocol-fallback-tmp');
    const spec = await specForLiveDb(db, dir, tmp);
    let workerExited = false;
    let fallbackSawExited = false;
    const handle = startWorkerTextBuild(spec, {
      workerFactory: (workerSpec) => {
        const worker = new Worker(
          `const fs = require('node:fs');
           const { parentPort, workerData } = require('node:worker_threads');
           parentPort.postMessage({ type: 'ready', version: 999 });
           setInterval(() => fs.writeFileSync(workerData.indexes[0].postingsPath, 'worker-active'), 5);`,
          { eval: true, workerData: workerSpec },
        );
        worker.once('exit', () => {
          workerExited = true;
        });
        const terminate = worker.terminate.bind(worker);
        worker.terminate = async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return terminate();
        };
        return worker;
      },
      onFallback: () => {
        fallbackSawExited = workerExited;
      },
    });

    await expect(handle.promise).resolves.toMatchObject({ scannedLiveKeys: 100 });
    expect(workerExited).toBe(true);
    expect(fallbackSawExited).toBe(true);
    expect(handle.inline).toBe(true);
    expect(handle.fallbackReason).toBe('protocol-mismatch');
    await fs.rm(tmp, { recursive: true });
    expect(fsSync.existsSync(tmp)).toBe(false);
    await db.close();
  });

  test('cancel during delayed protocol fallback prevents the inline build', async () => {
    const dir = await openTmp('protocol-cancel');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedTextDb(db, 100);
    const tmp = await openTmp('protocol-cancel-tmp');
    const spec = await specForLiveDb(db, dir, tmp);
    let signalTerminate!: () => void;
    const terminateStarted = new Promise<void>((resolve) => {
      signalTerminate = resolve;
    });
    let workerExited = false;
    const reasons: string[] = [];
    const handle = startWorkerTextBuild(spec, {
      workerFactory: (workerSpec) => {
        const worker = new Worker(
          `const fs = require('node:fs');
           const { parentPort, workerData } = require('node:worker_threads');
           parentPort.postMessage({ type: 'ready', version: 999 });
           setInterval(() => fs.writeFileSync(workerData.indexes[0].postingsPath, 'worker-active'), 5);`,
          { eval: true, workerData: workerSpec },
        );
        worker.once('exit', () => {
          workerExited = true;
        });
        const terminate = worker.terminate.bind(worker);
        worker.terminate = async () => {
          signalTerminate();
          await new Promise((resolve) => setTimeout(resolve, 150));
          return terminate();
        };
        return worker;
      },
      onFallback: (reason) => reasons.push(reason),
    });

    await terminateStarted;
    await handle.cancel();
    await expect(handle.promise).rejects.toMatchObject({ aborted: true });
    expect(workerExited).toBe(true);
    expect(handle.worker).toBeNull();
    expect(handle.inline).toBe(false);
    expect(handle.fallbackReason).toBeNull();
    expect(reasons).toEqual([]);
    await fs.rm(tmp, { recursive: true });
    expect(fsSync.existsSync(tmp)).toBe(false);
    await db.close();
  });

  test('worker crash after ready rejects with WorkerTextBuildError', async () => {
    const dir = await openTmp('crash');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedTextDb(db, 100);
    const tmp = await openTmp('crash-tmp');
    const spec = await specForLiveDb(db, dir, tmp);
    let workerExited = false;
    const handle = startWorkerTextBuild(spec, {
      workerFactory: () => {
        const worker = new Worker(
          "const { parentPort } = require('node:worker_threads'); parentPort.postMessage({ type: 'ready', version: 1 }); setImmediate(() => process.exit(3));",
          { eval: true },
        );
        worker.once('exit', () => {
          workerExited = true;
        });
        return worker;
      },
    });
    await expect(handle.promise).rejects.toThrow(WorkerTextBuildError);
    expect(workerExited).toBe(true);
    expect(handle.worker).toBeNull();
    expect(handle.inline).toBe(false);
    expect(handle.fallbackReason).toBeNull();
    expect(fsSync.existsSync(path.join(dir, 'CURRENT'))).toBe(false);
    await fs.rm(tmp, { recursive: true });
    expect(fsSync.existsSync(tmp)).toBe(false);
    await db.close();
  });

  test('worker failed message settles only after termination and permits immediate cleanup', async () => {
    const dir = await openTmp('failed-message');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedTextDb(db, 100);
    const tmp = await openTmp('failed-message-tmp');
    const spec = await specForLiveDb(db, dir, tmp);
    let workerExited = false;
    const handle = startWorkerTextBuild(spec, {
      workerFactory: () => {
        const worker = new Worker(
          `const { parentPort } = require('node:worker_threads');
           parentPort.postMessage({ type: 'ready', version: 1 });
           parentPort.postMessage({ type: 'failed', error: 'injected failure', aborted: false });
           setInterval(() => {}, 1000);`,
          { eval: true },
        );
        worker.once('exit', () => {
          workerExited = true;
        });
        return worker;
      },
    });

    await expect(handle.promise).rejects.toThrow('injected failure');
    expect(workerExited).toBe(true);
    expect(handle.worker).toBeNull();
    await fs.rm(tmp, { recursive: true });
    expect(fsSync.existsSync(tmp)).toBe(false);
    await db.close();
  });

  test('worker OOM is contained by resourceLimits: the host keeps serving', async () => {
    const dir = await openTmp('oom');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedTextDb(db, 30000);
    const tmp = await openTmp('oom-tmp');
    const spec = await specForLiveDb(db, dir, tmp);
    const handle = startWorkerTextBuild(spec, { workerMaxOldSpaceMb: 48 });
    // A 48 MiB old-space cap cannot hold the reconstructed corpus: the worker
    // dies; the host process (this test) is unaffected and keeps serving.
    await expect(handle.promise).rejects.toThrow();
    expect(db.get('k42')).toMatchObject({ score: 42 });
    expect(db.search('ft', 'hello').length).toBeGreaterThan(0);
    await db.close();
  }, 60000);

  test('cancel() aborts a running worker promptly', async () => {
    const dir = await openTmp('cancel');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedTextDb(db, 20000);
    const tmp = await openTmp('cancel-tmp');
    const spec = await specForLiveDb(db, dir, tmp);
    const handle = startWorkerTextBuild(spec);
    let workerExited = false;
    handle.worker!.once('exit', () => {
      workerExited = true;
    });
    const t0 = performance.now();
    await handle.cancel();
    await expect(handle.promise).rejects.toMatchObject({ aborted: true });
    expect(workerExited).toBe(true);
    expect(handle.worker).toBeNull();
    expect(performance.now() - t0).toBeLessThan(5000);
    await fs.rm(tmp, { recursive: true });
    expect(fsSync.existsSync(tmp)).toBe(false);
    await db.close();
  }, 30000);
});

describe('build core (segmented external merge)', () => {
  test('tiny memory budget forces segments; merged output equals the unsegmented build', { timeout: 120_000 }, async () => {
    const dir = await openTmp('segments');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedTextDb(db, 3000);
    const tmpBig = await openTmp('seg-big');
    const tmpSmall = await openTmp('seg-small');
    const big = await buildTextArtifacts(await specForLiveDb(db, dir, tmpBig, { memoryBudgetBytes: 512 * 1024 * 1024 }));
    const small = await buildTextArtifacts(await specForLiveDb(db, dir, tmpSmall, { memoryBudgetBytes: 16 * 1024 }));
    // The small-budget build flushed many segments but must arrive at the
    // exact same postings/dictionary content.
    const segs = small.indexes.map((r) => r.segmentsFlushed);
    expect(Math.max(...segs)).toBeGreaterThan(0);
    for (let i = 0; i < big.indexes.length; i++) {
      expect(small.indexes[i]!.postingsInfo).toEqual(big.indexes[i]!.postingsInfo);
      expect(small.indexes[i]!.dictionaryInfo).toEqual(big.indexes[i]!.dictionaryInfo);
      expect(small.indexes[i]!.baseDocsInfo).toEqual(big.indexes[i]!.baseDocsInfo);
    }
    // Segment files were cleaned up after the merge.
    expect((await fs.readdir(tmpSmall)).filter((f) => f.includes('.seg-'))).toEqual([]);
    await db.close();
  });

  test('pinned WAL prefix: appends past the checkpoint are invisible to the build', async () => {
    const dir = await openTmp('pin');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedTextDb(db, 500);
    const tmp = await openTmp('pin-tmp');
    const spec = await specForLiveDb(db, dir, tmp); // checkpoint pinned HERE
    for (let i = 500; i < 800; i++) {
      await db.set(`k${i}`, { kind: 'new', score: i, text: `post checkpoint doc ${i}` });
    }
    const r = await buildTextArtifacts(spec);
    expect(r.scannedLiveKeys).toBe(500);
    expect(r.docsIndexed).toBe(500);
    await db.close();
  });

  test('anchor mismatch fails the build instead of reading a rotated file', async () => {
    const dir = await openTmp('anchor');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedTextDb(db, 100);
    const tmp = await openTmp('anchor-tmp');
    const spec = await specForLiveDb(db, dir, tmp);
    spec.walIno += 1;
    await expect(buildTextArtifacts(spec)).rejects.toThrow('anchor mismatch');
    await db.close();
  });

  test('expired documents are dropped exactly like recovery drops them', async () => {
    const dir = await openTmp('expiry');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await db.createTextIndex('ft', { fields: ['text'] });
    for (let i = 0; i < 100; i++) await db.set(`live${i}`, { text: `live doc ${i}` });
    for (let i = 0; i < 50; i++) await db.set(`dead${i}`, { text: `dead doc ${i}` }, { ttl: 1 });
    await new Promise((r) => setTimeout(r, 20));
    const tmp = await openTmp('expiry-tmp');
    const spec = await specForLiveDb(db, dir, tmp, {
      indexes: [
        {
          name: 'ft',
          fields: ['text'],
          tokenizer: 'default',
          postingsPath: path.join(tmp, 'text-ft.postings'),
          dictionaryPath: path.join(tmp, 'text-ft.dictionary'),
          baseDocsPath: path.join(tmp, 'text-ft.docs.base'),
        },
      ],
    });
    const r = await buildTextArtifacts(spec);
    expect(r.scannedLiveKeys).toBe(100);
    expect(r.expiredSkipped).toBeGreaterThan(0);
    await db.close();
  });
});

describe('MiniDb worker build integration', () => {
  test('worker build publishes; get/set/search stay available throughout', async () => {
    const dir = await openTmp('e2e');
    let db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedTextDb(db, 5000);
    expect(db.maintenanceStatus()).toEqual([]);

    let settled = false;
    const buildP = db.rebuildGeneration().finally(() => {
      settled = true;
    });
    // Ordinary traffic during the build: reads, writes, and searches keep
    // working off the OLD base + live delta.
    let ops = 0;
    while (!settled && ops < 400) {
      await db.set(`c${ops}`, { kind: 'concurrent', score: ops, text: `concurrent write ${ops} 并发` });
      expect(db.get('k42')).toMatchObject({ score: 42 });
      expect(db.search('ft', 'hello').length).toBeGreaterThan(0);
      ops++;
    }
    await buildP;
    expect(ops).toBeGreaterThan(0);
    expect(db.stats.textWorkerBuilds).toBeGreaterThanOrEqual(1);
    expect(db.stats.generationBuildErrors).toBe(0);
    const gen = db.getIndexGeneration();
    expect(gen).not.toBeNull();
    // Writes that landed mid-build are searchable (the rebase replay).
    expect(db.search('ft', 'concurrent').length).toBeGreaterThan(0);
    expect(db.search('tri', 'concurrent write').length).toBeGreaterThan(0);
    // The scheduler surfaced the finished task.
    expect(db.maintenanceStatus().some((t) => t.kind === 'generation-build' && t.state === 'complete')).toBe(true);
    await db.close();

    // Reopen: the worker-built generation loads with zero rebuilds.
    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    expect(db.stats.generationLoads).toBe(1);
    expect(db.stats.generationIndexRebuilds).toBe(0);
    expect(db.size).toBe(5000 + ops);
    expect(db.search('ft', 'hello').length).toBeGreaterThan(0);
    expect(db.search('ft', 'concurrent').length).toBe(ops > 50 ? 50 : ops);
    expect(db.search('tri', 'hello world').length).toBeGreaterThan(0);
    await db.close();
  }, 60000);

  test('builtin ngram tokenizer is worker-eligible (not misclassified as custom)', async () => {
    const dir = await openTmp('ngram-worker');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    // ngram-ONLY corpus: the registry injects the builtin ngram tokenizer as
    // functions, which must NOT count as a custom tokenizer — otherwise the
    // index always falls back to the in-thread staged build and this
    // assertion stays 0.
    await db.createTextIndex('tri', { fields: ['text'], tokenizer: 'ngram' });
    const BATCH = 500;
    for (let base = 0; base < 5000; base += BATCH) {
      await db.batch(
        Array.from({ length: BATCH }, (_, i) => {
          const k = base + i;
          return { op: 'set' as const, key: `k${k}`, value: { text: `hello world doc ${k} 持久化 索引` } };
        }),
      );
    }
    await db.rebuildGeneration();
    expect(db.stats.textWorkerBuilds).toBe(1);
    expect(db.stats.generationBuildErrors).toBe(0);
    expect(db.search('tri', 'hello world').length).toBeGreaterThan(0);
    await db.close();
  }, 60000);

  test('worker build in disk valueMode', async () => {
    const dir = await openTmp('e2e-disk');
    let db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', valueMode: 'disk' });
    await seedTextDb(db, 5000);
    await db.rebuildGeneration();
    expect(db.stats.textWorkerBuilds).toBeGreaterThanOrEqual(1);
    expect(db.search('ft', '持久化').length).toBeGreaterThan(0);
    expect(await db.getAsync('k42')).toMatchObject({ score: 42 });
    await db.close();
    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', valueMode: 'disk' });
    expect(db.stats.generationLoads).toBe(1);
    expect(db.search('ft', 'hello').length).toBeGreaterThan(0);
    await db.close();
  }, 60000);

  test('close() during a worker build cancels it safely; reopen is consistent', async () => {
    const dir = await openTmp('close-mid');
    let db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedTextDb(db, 30000);
    const buildP = db.rebuildGeneration().catch(() => {});
    // Give the build a beat to actually start (scheduler picks it up), then
    // close: the unpublished build must be cancelled, the shutdown must
    // complete, and the data must survive untouched.
    await new Promise((r) => setTimeout(r, 50));
    await db.close();
    await buildP;
    expect(db.stats.textWorkerErrors).toBe(0);
    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    expect(db.size).toBe(30000);
    // The cancelled build left no generation behind, so this reopen took the
    // no-generation fallback path and DEFERRED the text base build: searches
    // raise the typed building signal until the background build commits,
    // then serve fully.
    expect(db.textIndexBuilding('ft')).toBe(true);
    expect(() => db.search('ft', 'hello')).toThrowError(/still building/);
    await waitFor(() => !db.textIndexBuilding('ft'), 'deferred text build');
    expect(db.search('ft', 'hello').length).toBeGreaterThan(0);
    await db.close();
  }, 60000);

  test('owner cancellation of an ordinary bounded build is not a worker error', async () => {
    const dir = await openTmp('cancel-bounded');
    let db = await MiniDb.open<Record<string, unknown>>({
      dir,
      valueCodec: 'json',
      indexGenerations: false,
    });
    await seedTextDb(db, 10000);
    await db.close();

    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await waitFor(
      () => db.maintenanceStatus().some((task) => task.kind === 'text-build' && task.state === 'running'),
      'ordinary bounded worker start',
    );
    await db.close();
    expect(db.stats.textWorkerErrors).toBe(0);
  }, 60000);

  test('fallback reopen defers the text base build (writer): building → committed', async () => {
    const dir = await openTmp('defer-writer');
    // Write the corpus with generations DISABLED so no generation ever gets
    // published — the reopen below is forced down the no-generation fallback
    // recovery path.
    let db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', indexGenerations: false });
    await seedTextDb(db, 5000);
    await db.close();

    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    // open() returned WITHOUT awaiting the corpus-scale rebuild: both text
    // indexes are in the building state, KV reads are unaffected, and the
    // generation kick has not published yet.
    expect(db.textIndexBuilding('ft')).toBe(true);
    expect(db.textIndexBuilding('tri')).toBe(true);
    expect(db.getIndexGeneration()).toBeNull();
    expect(db.get('k42')).toMatchObject({ score: 42 });
    expect(() => db.search('ft', 'hello')).toThrowError(/still building/);
    await expect(db.searchBoundedAsync('ft', 'hello')).rejects.toThrowError(/still building/);

    // The background maintenance task commits the bases; searches then serve
    // the full corpus again. Wait for BOTH indexes AND the task's completion
    // (the task builds the indexes sequentially) before sampling stats.
    await waitFor(() => !db.textIndexBuilding('ft') && !db.textIndexBuilding('tri'), 'deferred text builds');
    await waitFor(() => db.maintenanceStatus().every((t) => t.kind !== 'text-build' || (t.state !== 'running' && t.state !== 'queued')), 'text-build task completion');
    expect(db.search('ft', 'hello').length).toBe(50);
    expect(db.search('tri', 'hello world').length).toBeGreaterThan(0);
    expect(db.stats.textDeferredBuilds).toBe(2);
    expect(db.stats.textDeferredBuildErrors).toBe(0);
    expect(db.maintenanceStatus().some((t) => t.kind === 'text-build' && t.state === 'complete')).toBe(true);
    await db.close();
  }, 60000);

  test('fallback reopen defers the text base build (read-only): scratch dir outside the db dir', async () => {
    const dir = await openTmp('defer-readonly');
    // The writer holds the lock with generations DISABLED, so the read-only
    // peer below takes the no-generation fallback path and must never write
    // into the writer's directory.
    const writer = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', indexGenerations: false });
    await seedTextDb(writer, 5000);
    const filesBefore = (await fs.readdir(dir)).sort();

    const reader = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', onLockFail: 'readonly' });
    expect(reader.readOnly).toBe(true);
    expect(reader.textIndexBuilding('ft')).toBe(true);
    expect(() => reader.search('ft', 'hello')).toThrowError(/still building/);

    // A write landing while the reader's base is building is captured by the
    // rebase queue (via WAL catch-up) and replayed at commit.
    await writer.set('mid', { kind: 't1', score: 1, text: 'mid build write 中途' });
    const walEnd = (await fs.stat(path.join(dir, 'db.wal'))).size;
    expect(await reader.catchUpFromWal(reader.recoveryInfo!.walScanEnd)).not.toBeNull();
    expect(walEnd).toBeGreaterThan(reader.recoveryInfo!.walScanEnd);

    await waitFor(() => !reader.textIndexBuilding('ft') && !reader.textIndexBuilding('tri'), 'read-only deferred builds');
    expect(reader.search('ft', 'hello').length).toBe(50);
    expect(reader.search('tri', 'hello world').length).toBeGreaterThan(0);
    // The queued mid-build write is searchable on the committed base.
    expect(reader.search('ft', '中途').map((h) => h.key)).toEqual(['mid']);
    // The writer's directory is untouched: the reader's base postings live in
    // its private scratch dir NEXT TO the db dir.
    expect((await fs.readdir(dir)).sort()).toEqual(filesBefore);
    const scratchRoot = `${dir}.ro-scratch`;
    const scratchEntries = await fs.readdir(scratchRoot);
    expect(scratchEntries.length).toBe(1);
    const postings = await fs.readdir(path.join(scratchRoot, scratchEntries[0]!));
    expect(postings.some((f) => f.startsWith('db.text-ft') && f.endsWith('.postings'))).toBe(true);
    // close() drops the scratch dir (handles released first).
    await reader.close();
    expect(fsSync.existsSync(scratchRoot) ? (await fs.readdir(scratchRoot)).length : 0).toBe(0);
    await writer.close();
  }, 60000);

  test('small corpus keeps the staged inline rebuild (no deferral window)', async () => {
    const dir = await openTmp('defer-small');
    let db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', indexGenerations: false });
    await seedTextDb(db, 1000); // below TEXT_BUILD_WORKER_MIN_DOCS
    await db.close();
    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    expect(db.textIndexBuilding('ft')).toBe(false);
    expect(db.search('ft', 'hello').length).toBe(50);
    expect(db.maintenanceStatus().some((t) => t.kind === 'text-build')).toBe(false);
    await db.close();
  }, 60000);

  test('deferOpenTextBuilds: false restores the awaited staged rebuild (rollback switch)', async () => {
    const dir = await openTmp('defer-off');
    let db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', indexGenerations: false });
    await seedTextDb(db, 5000);
    await db.close();
    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', deferOpenTextBuilds: false });
    // open() awaited the full staged rebuild: no building window at all.
    expect(db.textIndexBuilding('ft')).toBe(false);
    expect(db.search('ft', 'hello').length).toBe(50);
    expect(db.maintenanceStatus().some((t) => t.kind === 'text-build')).toBe(false);
    await db.close();
  }, 60000);

  test('a failed worker keeps the current generation and the live index intact', async () => {
    const dir = await openTmp('worker-fail');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedTextDb(db, 5000);
    await db.rebuildGeneration();
    const genBefore = db.getIndexGeneration()!.id;
    const currentBefore = await fs.readFile(path.join(dir, 'CURRENT'), 'utf8');

    // Point the build at a postings path that does not survive: corrupt the
    // worker's tmp output between production and verification by injecting a
    // write failure into every tmp-dir fs open (the worker is a separate
    // thread, so instead fail the MAIN thread's verification read — the
    // outcome class is identical: worker output rejected pre-publish).
    // Simpler deterministic route: shrink the textBuildMemoryBytes to 1 to
    // force the segmented path AND inject a rename failure for the publish —
    // no. The direct one: make the publish rename fail.
    const original = fs.rename;
    (fs as unknown as Record<string, unknown>).rename = (src: string, dst: string) =>
      String(src).includes('.tmp-') ? Promise.reject(new Error('injected publish failure')) : original(src, dst);
    cleanups.push(() => {
      (fs as unknown as Record<string, unknown>).rename = original;
    });
    await expect(db.rebuildGeneration()).rejects.toThrow('injected publish failure');
    (fs as unknown as Record<string, unknown>).rename = original;

    // The failure is accounted; the live index keeps serving identically.
    expect(db.stats.generationBuildErrors).toBeGreaterThanOrEqual(1);
    expect(db.getIndexGeneration()!.id).toBe(genBefore);
    expect(await fs.readFile(path.join(dir, 'CURRENT'), 'utf8')).toBe(currentBefore);
    expect(db.search('ft', 'hello').length).toBe(50);
    expect(db.get('k7')).toMatchObject({ score: 7 });
    // And a later build succeeds (the failure is not sticky).
    await db.rebuildGeneration();
    expect(db.getIndexGeneration()!.id).not.toBe(genBefore);
    await db.close();
  }, 60000);

  test('small corpus stays on the staged path (no worker spawn)', async () => {
    const dir = await openTmp('small');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedTextDb(db, 500);
    await db.rebuildGeneration();
    expect(db.stats.textWorkerBuilds).toBe(0);
    expect(db.search('ft', 'hello').length).toBeGreaterThan(0);
    await db.close();
  });

  test('textBuildWorker: false forces the staged path (rollback switch)', async () => {
    const dir = await openTmp('switch');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', textBuildWorker: false });
    await seedTextDb(db, 5000);
    await db.rebuildGeneration();
    expect(db.stats.textWorkerBuilds).toBe(0);
    expect(db.stats.generationBuildErrors).toBe(0);
    expect(db.search('ft', 'hello').length).toBeGreaterThan(0);
    await db.close();
  }, 60000);
});

describe('maintenance scheduler behavior (via MiniDb)', () => {
  test('compact and generation-build serialize; status exposes states', async () => {
    const dir = await openTmp('sched');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', compactThresholdBytes: 64 * 1024 });
    await seedTextDb(db, 5000);
    // Drive a compaction AND a generation build: they must never overlap
    // (one heavy task at a time). The build lands inside the compaction's
    // own publish hook or right after it — both complete without deadlock.
    const c = db.compact();
    const g = db.rebuildGeneration().catch(() => {});
    await Promise.all([c, g]);
    const states = db.maintenanceStatus();
    expect(states.some((t) => t.kind === 'compact')).toBe(true);
    for (const t of states) expect(['complete', 'failed']).toContain(t.state);
    expect(db.stats.generationBuilds).toBeGreaterThanOrEqual(1);
    expect(db.search('ft', 'hello').length).toBeGreaterThan(0);
    await db.close();
  }, 60000);
});

describe('bounded createTextIndex (data-first corpus)', () => {
  test('large existing corpus builds via the worker; concurrent writes replay on commit', async () => {
    const dir = await openTmp('cti-worker');
    // Open EMPTY first: the open-time background generation build only fires
    // when the db has data at open, so this keeps the stats deterministic.
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedDataOnly(db, 5000);

    let settled = false;
    const createP = db.createTextIndex('ft', { fields: ['text'] }).finally(() => {
      settled = true;
    });
    // Traffic during the build: the rebase queue must fold these into the
    // new base at commit time.
    let ops = 0;
    while (!settled && ops < 200) {
      await db.set(`c${ops}`, { kind: 'concurrent', text: `concurrent write ${ops} 并发 hello` });
      ops++;
    }
    await createP;
    await db.createTextIndex('tri', { fields: ['text'], tokenizer: 'ngram' });

    expect(db.stats.textWorkerBuilds).toBe(2);
    expect(db.stats.textWorkerFallbacks).toBe(0);
    expect(db.search('ft', 'hello').length).toBeGreaterThan(0);
    expect(db.search('ft', '持久化').length).toBeGreaterThan(0);
    expect(db.search('tri', 'hello world').length).toBeGreaterThan(0);
    if (ops > 0) expect(db.search('ft', 'concurrent').length).toBeGreaterThan(0);
    await db.close();
  }, 60000);

  test('small corpus stays on the staged path (no worker spawn)', async () => {
    const dir = await openTmp('cti-small');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedDataOnly(db, 500);
    await db.createTextIndex('ft', { fields: ['text'] });
    expect(db.stats.textWorkerBuilds).toBe(0);
    expect(db.search('ft', 'hello').length).toBeGreaterThan(0);
    await db.close();
  });

  test('textBuildWorker: false forces the staged path (rollback switch)', async () => {
    const dir = await openTmp('cti-switch');
    const db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json', textBuildWorker: false });
    await seedDataOnly(db, 5000);
    await db.createTextIndex('ft', { fields: ['text'] });
    expect(db.stats.textWorkerBuilds).toBe(0);
    expect(db.search('ft', 'hello').length).toBeGreaterThan(0);
    await db.close();
  }, 60000);
});

describe('bounded open-time rebuild (generation loader)', () => {
  test('a missing text image rebuilds via the bounded worker build at open', async () => {
    const dir = await openTmp('loader-rebuild');
    let db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    await seedTextDb(db, 5000);
    await db.rebuildGeneration();
    const genId = db.getIndexGeneration()!.id;
    await db.close();

    // Invalidate ONE index's dictionary image: the loader cannot attach the
    // 'ft' base and must rebuild it — at this corpus size the rebuild goes
    // through the bounded worker build, not the staged in-thread one.
    await fs.rm(path.join(dir, 'generations', genId, 'text-ft.dictionary'));

    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    expect(db.stats.generationIndexRebuilds).toBe(1);
    expect(db.stats.textWorkerBuilds).toBe(1);
    // The rebuilt index and the attached one both serve correctly.
    expect(db.search('ft', 'hello').length).toBeGreaterThan(0);
    expect(db.search('ft', '持久化').length).toBeGreaterThan(0);
    expect(db.search('tri', 'hello world').length).toBeGreaterThan(0);
    await db.close();
  }, 60000);
});

describe('single-file deployment (worker entry absent)', () => {
  test('bounded builds still run — hosted inline, never the unbounded staged path', async () => {
    vi.doMock('../src/worker/text-build.js', async (importOriginal) => {
      const orig = await importOriginal<typeof import('../src/worker/text-build.js')>();
      return { ...orig, textBuildWorkerAvailable: () => false };
    });
    vi.resetModules();
    try {
      const { MiniDb: SeaMiniDb } = await import('../src/index.js');
      const dir = await openTmp('sea-inline');
      // Open EMPTY first (see the deterministic-stats note above).
      const db = await SeaMiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
      await seedDataOnly(db as unknown as MiniDb<Record<string, unknown>>, 5000);

      await db.createTextIndex('ft', { fields: ['text'] });
      await db.createTextIndex('tri', { fields: ['text'], tokenizer: 'ngram' });
      expect(db.stats.textWorkerBuilds).toBe(0);
      // Both bounded builds were hosted inline (worker file "absent").
      expect(db.stats.textWorkerFallbacks).toBe(2);
      expect(db.stats.lastTextWorkerFallback).toBe('runtime-unavailable');
      expect(db.search('ft', 'hello').length).toBeGreaterThan(0);

      // The maintenance path (generation rebuild) takes the same inline
      // bounded engine instead of the old staged aggregation.
      await db.set('dirty-1', { text: 'walrus 持久化' });
      await db.rebuildGeneration();
      expect(db.stats.generationBuildErrors).toBe(0);
      expect(db.stats.textWorkerBuilds).toBe(0);
      expect(db.stats.textWorkerFallbacks).toBe(3);
      expect(db.search('tri', 'hello world').length).toBeGreaterThan(0);
      await db.close();
    } finally {
      vi.doUnmock('../src/worker/text-build.js');
      vi.resetModules();
    }
  }, 120000);
});
