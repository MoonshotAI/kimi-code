/**
 * OAuthManager cross-process refresh lock.
 *
 * Spawns N Node worker processes that each call `ensureFresh(force=true)`
 * on the same OAuth provider. With the `proper-lockfile`-backed
 * cross-process mutex around `doEnsureFresh`, only one worker actually
 * hits the refresh endpoint (`refreshImpl`); the others re-read storage
 * and see the rotated token produced by the winner.
 *
 * Workers run as inline `.mjs` scripts via `spawnInlineWorkers`. Each
 * worker:
 *   1. Dynamically imports `OAuthManager` from the current package source.
 *   2. Constructs it with a file-backed TokenStorage pointing at
 *      `{shareDir}/token.json` and a `refreshTokenImpl` that increments
 *      `{shareDir}/refresh-count.txt` atomically before returning a
 *      rotated token (refreshToken changes every refresh).
 *   3. Calls `ensureFresh({force:true})` and exits.
 *
 * Oracle: after all workers exit, `refresh-count.txt` contains exactly
 * `1` (when the lock is in place); `N` (when it is not).
 *
 * **Platform**: macOS / Linux only. Windows path quirks for
 * `proper-lockfile` are bypassed via the `KIMI_DISABLE_OAUTH_LOCK=1`
 * env-var escape hatch; this test skips on `process.platform === 'win32'`.
 */

import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempWorkDir, spawnInlineWorkers, type TempDirHandle } from './helpers';

const skipOnWindows = process.platform === 'win32';
const OAUTH_ENTRY_URL = new URL('../src/index.ts', import.meta.url).href;

// ─────────────────────────────────────────────────────────────────────
// Worker body — dedicated inline .mjs script.
// ─────────────────────────────────────────────────────────────────────
//
// One worker = one ensureFresh(force=true) invocation. All workers race
// against the same on-disk lock file and the same refresh-count.txt.
//
// `refresh-count.txt` starts empty (or missing). Workers atomically
// append a single byte per observed refresh using O_APPEND semantics;
// the final byte count equals the number of refreshes that took place.

const WORKER_SCRIPT = `
  import { readFile, writeFile, appendFile, mkdir, stat } from 'node:fs/promises';
  import { join } from 'node:path';
  const { OAuthManager } = await import(process.env.KIMI_OAUTH_ENTRY);

  const shareDir = process.env.KIMI_CODE_HOME;
  const tokenPath = join(shareDir, 'token.json');
  const counterPath = join(shareDir, 'refresh-count.txt');
  const readyPath = join(shareDir, 'first-load-ready.txt');
  const lockDir = join(shareDir, 'oauth');
  await mkdir(lockDir, { recursive: true });

  async function waitForFirstLoadBarrier() {
    if (process.env.KIMI_SYNC_FIRST_LOAD !== '1') return;
    await appendFile(readyPath, '.');
    const expected = Number(process.env.KIMI_WORKER_COUNT || '1');
    const deadline = Date.now() + 10_000;
    while (true) {
      let ready = 0;
      try {
        ready = (await stat(readyPath)).size;
      } catch {}
      if (ready >= expected) return;
      if (Date.now() >= deadline) {
        throw new Error('first-load barrier timed out');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const config = {
    name: 'test-provider',
    oauthHost: 'https://unused.test',
    clientId: 'test',
  };

  /** File-backed TokenStorage keyed on the single provider 'test-provider'. */
  let firstLoad = true;
  const storage = {
    async load(name) {
      try {
        const raw = await readFile(tokenPath, 'utf8');
        if (firstLoad) {
          firstLoad = false;
          await waitForFirstLoadBarrier();
        }
        const parsed = JSON.parse(raw);
        return parsed[name];
      } catch {
        return undefined;
      }
    },
    async save(name, token) {
      // Read-modify-write. Good enough for the test oracle; the real
      // cross-process correctness comes from the lock, not the storage.
      let bag = {};
      try {
        bag = JSON.parse(await readFile(tokenPath, 'utf8'));
      } catch {
        bag = {};
      }
      bag[name] = token;
      await writeFile(tokenPath, JSON.stringify(bag), 'utf8');
    },
    async remove(name) {},
    async list() { return ['test-provider']; },
  };

  /** refreshImpl increments the oracle file and hands back a rotated token. */
  const refreshImpl = async () => {
    // One byte per observed refresh; O_APPEND is atomic on POSIX.
    await appendFile(counterPath, '.');
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      accessToken: 'at-refreshed-' + String(nowSec),
      refreshToken: 'rt-rotated-' + String(nowSec),
      expiresAt: nowSec + 3600,
      scope: '',
      tokenType: 'Bearer',
      expiresIn: 3600,
    };
  };

  const manager = new OAuthManager({
    config,
    storage,
    refreshTokenImpl: refreshImpl,
    // minimal stubs — unused on ensureFresh
    requestDeviceImpl: async () => { throw new Error('unused'); },
    pollDeviceImpl: async () => { throw new Error('unused'); },
    now: () => Math.floor(Date.now() / 1000),
  });

  // Every worker attempts a forced refresh. With a cross-process lock
  // in place, only one worker's refreshImpl runs; the others read the
  // rotated storage and return its accessToken without calling
  // refreshImpl.
  try {
    const token = await manager.ensureFresh({ force: true });
    process.stdout.write('ok:' + token + '\\n');
  } catch (err) {
    process.stdout.write('err:' + (err && err.message ? err.message : String(err)) + '\\n');
  }
  // Debug trace so the test oracle can diagnose mis-locking.
  if (process.env.DEBUG_OAUTH_WORKER === '1') {
    process.stderr.write('[worker ' + process.env.KIMI_WORKER_ID + '] done\\n');
  }
`;

async function seedInitialToken(shareDir: string): Promise<void> {
  const tokenPath = join(shareDir, 'token.json');
  const nowSec = Math.floor(Date.now() / 1000);
  const token = {
    'test-provider': {
      accessToken: 'at-initial',
      refreshToken: 'rt-initial',
      expiresAt: nowSec + 60, // inside refresh threshold → force refresh hits
      scope: '',
      tokenType: 'Bearer',
      expiresIn: 3600,
    },
  };
  const { writeFile } = await import('node:fs/promises');
  await writeFile(tokenPath, JSON.stringify(token), 'utf8');
}

async function readRefreshCount(shareDir: string): Promise<number> {
  const counterPath = join(shareDir, 'refresh-count.txt');
  try {
    const s = await stat(counterPath);
    return s.size;
  } catch {
    return 0;
  }
}

const tmpHandles: TempDirHandle[] = [];

afterEach(async () => {
  while (tmpHandles.length > 0) {
    await tmpHandles.pop()!.cleanup();
  }
});

describe.skipIf(skipOnWindows)('OAuthManager cross-process refresh lock', () => {
  it('2 workers concurrently force-refresh → exactly one refreshImpl fires', async () => {
    const dir = await createTempWorkDir();
    tmpHandles.push(dir);
    await seedInitialToken(dir.path);

    const workers = await spawnInlineWorkers({
      count: 2,
      inlineScript: WORKER_SCRIPT,
      tmpDir: dir.path,
      shareDir: dir.path,
      timeoutMs: 30_000,
      env: {
        KIMI_OAUTH_ENTRY: OAUTH_ENTRY_URL,
        KIMI_SYNC_FIRST_LOAD: '1',
        KIMI_WORKER_COUNT: '2',
      },
    });

    // All workers exit cleanly.
    for (const w of workers) {
      expect(w.exitCode, `worker ${String(w.id)} stderr: ${w.stderr}`).toBe(0);
      expect(w.stdout.startsWith('ok:')).toBe(true);
    }

    // Refresh count = 1 → exactly one refresh happened across the 5
    // processes. Without the lock the count equals N (or any value > 1).
    const count = await readRefreshCount(dir.path);
    expect(count).toBe(1);
  }, 45_000);

  it('stale lock (held by a killed worker) is reclaimed after stale timeout', async () => {
    // Scenario: worker A takes the lock and crashes without releasing
    // (SIGKILL). Worker B arrives 6+ seconds later and must reclaim
    // the stale lock via `proper-lockfile`'s `stale: 5_000ms` policy.
    //
    // BLK-2 fix: proper-lockfile represents the lock as a DIRECTORY
    // at `{target}.lock/`. The staleness probe is `stat().mtimeMs`
    // on that directory, so we must `mkdir` + `utimes` (not
    // `writeFile`, which would put a regular file where a dir is
    // expected — `proper-lockfile` would then blow up or
    // mis-interpret it).
    const dir = await createTempWorkDir();
    tmpHandles.push(dir);
    await seedInitialToken(dir.path);
    await mkdir(join(dir.path, 'oauth'), { recursive: true });

    const { utimes } = await import('node:fs/promises');
    const lockDir = join(dir.path, 'oauth', 'test-provider.lock');
    await mkdir(lockDir, { recursive: true });
    // 10 seconds ago — past the 5 s stale threshold.
    const tenSecondsAgo = (Date.now() - 10_000) / 1000;
    await utimes(lockDir, tenSecondsAgo, tenSecondsAgo);

    const workers = await spawnInlineWorkers({
      count: 1,
      inlineScript: WORKER_SCRIPT,
      tmpDir: dir.path,
      shareDir: dir.path,
      timeoutMs: 20_000,
      env: {
        KIMI_OAUTH_ENTRY: OAUTH_ENTRY_URL,
      },
    });

    expect(workers[0]?.exitCode).toBe(0);
    expect(workers[0]?.stdout.startsWith('ok:')).toBe(true);
  }, 30_000);
});

// Prevent "no tests in file" when running on Windows.
describe.skipIf(!skipOnWindows)('OAuthManager cross-process refresh lock (Windows skip)', () => {
  it('skipped on Windows — covered by KIMI_DISABLE_OAUTH_LOCK=1 env escape hatch', () => {
    expect(skipOnWindows).toBe(true);
  });
});

