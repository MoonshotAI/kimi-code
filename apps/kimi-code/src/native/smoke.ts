import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { MiniDb } from '@moonshot-ai/minidb';
import { getSearchWorkerRuntimeState } from '@moonshot-ai/kap-server/search-worker-runtime';

import {
  getEmbeddedNativeAssetManifest,
  getNativeCacheBase,
  getNativePackageRoot,
} from './native-assets';

const smokePackages = ['@mariozechner/clipboard', '@moonshot-ai/pi-tui'];

function smokePiTuiNativeLoad(): void {
  const platform = process.platform;
  const arch = process.arch;
  let rel: string | undefined;
  if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
    rel = join('native', 'darwin', 'prebuilds', `darwin-${arch}`, 'darwin-modifiers.node');
  } else if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) {
    rel = join('native', 'win32', 'prebuilds', `win32-${arch}`, 'win32-console-mode.node');
  }
  if (rel === undefined) return;

  const req = createRequire(import.meta.url);
  const helper = req(join(dirname(process.execPath), rel)) as {
    isModifierPressed?: unknown;
    enableVirtualTerminalInput?: unknown;
  };
  if (
    typeof helper.isModifierPressed !== 'function' &&
    typeof helper.enableVirtualTerminalInput !== 'function'
  ) {
    throw new TypeError(`pi-tui native helper exports are unexpected: ${rel}`);
  }
}

async function smokeMinidbWorker(): Promise<void> {
  const cacheBase = getNativeCacheBase();
  mkdirSync(cacheBase, { recursive: true });
  const dir = mkdtempSync(join(cacheBase, 'sea-minidb-smoke-'));
  let db: MiniDb<Record<string, unknown>> | null = null;
  try {
    db = await MiniDb.open<Record<string, unknown>>({ dir, valueCodec: 'json' });
    const total = 4_200;
    for (let base = 0; base < total; base += 500) {
      await db.batch(
        Array.from({ length: Math.min(500, total - base) }, (_, offset) => {
          const id = base + offset;
          return {
            op: 'set' as const,
            key: `doc-${id}`,
            value: { text: `sea worker searchable document ${id}` },
          };
        }),
      );
    }
    await db.createTextIndex('smoke', { fields: ['text'] });
    if (db.stats.textWorkerBuilds < 1) {
      throw new Error(`MiniDb worker did not run: ${JSON.stringify(db.stats)}`);
    }
    if (db.stats.textWorkerFallbacks !== 0) {
      throw new Error(
        `MiniDb worker unexpectedly fell back: ${db.stats.lastTextWorkerFallback ?? 'unknown'}`,
      );
    }
    if (!db.search('smoke', 'searchable').some((hit) => hit.key === 'doc-0')) {
      throw new Error('MiniDb worker-built text index returned an incorrect search result');
    }
  } finally {
    await db?.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

async function smokeSearchWorker(): Promise<void> {
  // The SEA-extracted global-search worker entry must boot from disk and
  // complete the versioned ready handshake.
  const runtime = getSearchWorkerRuntimeState();
  if (!runtime.configured) {
    throw new Error('search worker runtime was not configured');
  }
  const cacheBase = getNativeCacheBase();
  mkdirSync(cacheBase, { recursive: true });
  const dir = mkdtempSync(join(cacheBase, 'sea-search-worker-'));
  const worker = new Worker(runtime.path, {
    workerData: { dir, bootSalt: 'sea-smoke' },
  });
  try {
    const ready = once(worker, 'message', {
      signal: AbortSignal.timeout(15_000),
    }) as Promise<unknown[]>;
    const [event] = await ready;
    const v = (event as { type?: string; v?: number }).v;
    if ((event as { type?: string }).type !== 'ready' || typeof v !== 'number') {
      throw new Error(`search worker handshake is unexpected: ${JSON.stringify(event)}`);
    }
  } finally {
    await worker.terminate().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runSmoke(): Promise<void> {
  const manifest = getEmbeddedNativeAssetManifest();
  if (manifest === null) throw new Error('Native asset manifest is not available.');
  for (const packageName of smokePackages) {
    if (getNativePackageRoot(packageName, { manifest }) === null) {
      throw new Error(`Native package is not available: ${packageName}`);
    }
  }
  smokePiTuiNativeLoad();
  await smokeMinidbWorker();
  await smokeSearchWorker();
  process.stdout.write(
    `Native asset smoke passed: ${manifest.target}; MiniDb worker build passed; search worker ready\n`,
  );
}

export function runNativeAssetSmokeIfRequested(): boolean {
  if (process.env['KIMI_CODE_NATIVE_ASSET_SMOKE'] !== '1') return false;
  void runSmoke().then(
    () => process.exit(0),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Native asset smoke failed: ${message}\n`);
      process.exit(1);
    },
  );
  return true;
}
