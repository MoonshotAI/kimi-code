/**
 * Subprocess-mode dual-instance boot: each server runs in its own OS process
 * (`node --import tsx serverProcessMain.ts`), so signal-sensitive cases
 * (SIGSTOP, SIGCONT, SIGKILL, kill -9 takeover) get real, distinct pids —
 * in-process `startServerPair` cannot model those.
 *
 * Spawn incantation:
 *   node --import <tsx loader href> --import <raw-text loader href> <entry>
 *   - `tsx` compiles the workspace's TypeScript module graph. It is attached
 *     as a `--import` loader — NOT via the tsx CLI, which is a hub/spoke
 *     wrapper: the CLI would fork the server as a GRANDCHILD, so
 *     `child.pid` (and every signal sent to it) would miss the actual
 *     server process. With the direct import the child IS the server, which
 *     the child additionally proves by reporting its own pid in the ready
 *     line. `tsx` is resolved through `createRequire` from the repo root's
 *     devDependencies — this package deliberately does not redeclare it.
 *   - `TSX_TSCONFIG_PATH` replaces the CLI's `--tsconfig` flag and points at
 *     `tsconfig.dev.json`, whose `include` covers every package's `src` —
 *     that is what tsx's per-file tsconfig mapping needs to apply
 *     `experimentalDecorators` for DI parameter decorators in the
 *     agent-core graph (mirrors `apps/kimi-code/tsconfig.dev.json`).
 *   - `build/register-raw-text-loader.mjs` makes `*.md?raw` prompt-template
 *     imports (kap-server → agent-core-v2) resolvable outside a bundler;
 *     plain `node` fails on those imports without it.
 *
 * Readiness is the child's `{type:'ready'}` stdout line (printed after
 * `startServer` resolved, i.e. the port is already listening). When driving
 * an externally spawned server without that line, poll
 * `waitForServerHealthy` instead — `/api/v1/healthz` is auth-exempt.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sleep } from '../wait.js';
import {
  SPAWN_SERVER_HOME_ENV,
  type SpawnServerMessage,
  type SpawnServerReadyMessage,
} from './spawnContract.js';

const TESTING_DIR = dirname(fileURLToPath(import.meta.url));
// testing/ → harness/ → e2e/ → test/ → packages/klient
const PACKAGE_ROOT = resolve(TESTING_DIR, '../../../..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');
const ENTRY_PATH = join(TESTING_DIR, 'serverProcessMain.ts');
const STOP_GRACE_MS = 10_000;
const STDERR_TAIL_LIMIT = 8_192;
// `recursive` rm can hit ENOTEMPTY on macOS while the closing server is still
// flushing/unlinking its own files — retry briefly.
export const RM_HOME_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

export interface SpawnServerProcessOptions {
  /** Home directory for the child server. Created via `mkdtemp` when omitted. */
  readonly home?: string;
  /** Extra env for the child process, merged over `process.env`. */
  readonly env?: Record<string, string>;
  /** Working directory of the child process. Defaults to the parent's cwd. */
  readonly cwd?: string;
  /** How long to wait for the child's ready line. Default 30s. */
  readonly startupTimeoutMs?: number;
}

export interface SpawnedServer {
  /** Pid of the child process — the handle signals are delivered to. */
  readonly pid: number;
  readonly port: number;
  readonly baseUrl: string;
  readonly home: string;
  /**
   * Graceful stop: SIGTERM, await exit, escalate to SIGKILL after ~10s.
   * Idempotent. Removes `home` when this helper created it.
   */
  stop(): Promise<void>;
  /** Deliver an arbitrary signal to the child (e.g. SIGSTOP / SIGKILL). */
  kill(signal: NodeJS.Signals): void;
  /** Captured stderr tail so far — child boot/close failures land here. */
  stderr(): string;
}

export interface SpawnedServerPair {
  readonly a: SpawnedServer;
  readonly b: SpawnedServer;
  readonly home: string;
  /** Stop both children (idempotent, best-effort) and remove `home` if owned. */
  dispose(): Promise<void>;
}

export async function spawnServerProcess(
  options: SpawnServerProcessOptions = {},
): Promise<SpawnedServer> {
  const home = options.home ?? (await mkdtemp(join(tmpdir(), 'kimi-e2e-spawn-')));
  const ownsHome = options.home === undefined;
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;

  const require = createRequire(import.meta.url);
  // The `.` export of the `tsx` package — attached via `--import` so the TS
  // transpiler registers in the child process itself (no CLI wrapper).
  const tsxLoaderHref = pathToFileURL(require.resolve('tsx')).href;
  const rawLoaderHref = pathToFileURL(
    join(REPO_ROOT, 'build/register-raw-text-loader.mjs'),
  ).href;

  const child = spawn(
    process.execPath,
    ['--import', tsxLoaderHref, '--import', rawLoaderHref, ENTRY_PATH],
    {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        // The CLI's `--tsconfig` flag, as a loader env var.
        TSX_TSCONFIG_PATH: join(PACKAGE_ROOT, 'tsconfig.dev.json'),
        [SPAWN_SERVER_HOME_ENV]: home,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_LIMIT);
  });
  const exited = new Promise<number | null>((resolveExit) => {
    child.once('exit', (code) => resolveExit(code));
  });

  let ready: SpawnServerReadyMessage;
  try {
    ready = await waitForReady(child, startupTimeoutMs, () => stderrTail);
  } catch (error) {
    child.kill('SIGKILL');
    if (ownsHome) {
      await rm(home, RM_HOME_OPTIONS);
    }
    throw error;
  }

  const pid = child.pid;
  if (pid === undefined) {
    child.kill('SIGKILL');
    throw new Error('spawned server child has no pid');
  }
  if (ready.pid !== pid) {
    child.kill('SIGKILL');
    if (ownsHome) {
      await rm(home, RM_HOME_OPTIONS);
    }
    throw new Error(
      `spawned server reports pid ${ready.pid} but the child handle is ${pid} — a wrapper process slipped into the launch incantation and would misdirect signals`,
    );
  }
  const baseUrl = `http://127.0.0.1:${ready.port}`;

  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGTERM');
      }
      if (!(await raceExit(exited, STOP_GRACE_MS))) {
        child.kill('SIGKILL');
        await raceExit(exited, STOP_GRACE_MS);
      }
      if (ownsHome) {
        await rm(home, RM_HOME_OPTIONS);
      }
    })();
    return stopPromise;
  };

  return {
    pid,
    port: ready.port,
    baseUrl,
    home,
    stop,
    kill: (signal) => {
      child.kill(signal);
    },
    stderr: () => stderrTail,
  };
}

/**
 * Pair of spawned children sharing one home; `options.env` is pushed into both
 * child envs — process-level patching like `startServerPair` does would not
 * reach them.
 */
export async function spawnServerProcessPair(
  options: SpawnServerProcessOptions = {},
): Promise<SpawnedServerPair> {
  const home = options.home ?? (await mkdtemp(join(tmpdir(), 'kimi-e2e-spawn-pair-')));
  const ownsHome = options.home === undefined;
  const childOptions: SpawnServerProcessOptions = {
    ...options,
    home,
  };
  try {
    const a = await spawnServerProcess(childOptions);
    let b: SpawnedServer;
    try {
      b = await spawnServerProcess(childOptions);
    } catch (error) {
      await a.stop();
      throw error;
    }
    let disposed = false;
    return {
      a,
      b,
      home,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        const results = await Promise.allSettled([a.stop(), b.stop()]);
        for (const [label, result] of [
          ['a', results[0]],
          ['b', results[1]],
        ] as const) {
          if (result?.status === 'rejected') {
            process.stderr.write(
              `[server-e2e] spawnServerProcessPair dispose: child ${label} stop failed: ${String(result.reason)}\n`,
            );
          }
        }
        if (ownsHome) {
          await rm(home, RM_HOME_OPTIONS);
        }
      },
    };
  } catch (error) {
    if (ownsHome) {
      await rm(home, RM_HOME_OPTIONS);
    }
    throw error;
  }
}

/** Poll the auth-exempt health route until the server responds with 200. */
export async function waitForServerHealthy(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/v1/healthz`);
      if (res.status === 200) return;
      lastError = new Error(`healthz returned HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`server at ${baseUrl} did not become healthy within ${timeoutMs}ms`, {
    cause: lastError,
  });
}

function waitForReady(
  child: ChildProcess,
  timeoutMs: number,
  stderrTail: () => string,
): Promise<SpawnServerReadyMessage> {
  return new Promise((resolvePromise, rejectPromise) => {
    const rl = createInterface({ input: child.stdout! });
    const timer = setTimeout(() => {
      fail(new Error('timed out waiting for the ready line'));
    }, timeoutMs);
    timer.unref();

    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      rejectPromise(withStderr(error, stderrTail()));
    };
    rl.once('line', (line) => {
      let message: SpawnServerMessage;
      try {
        message = JSON.parse(line) as SpawnServerMessage;
      } catch {
        fail(new Error(`unparseable first stdout line: ${line.slice(0, 200)}`));
        return;
      }
      if (message.type === 'error') {
        fail(new Error(`child failed to boot: ${message.message}`));
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      resolvePromise(message);
    });
    child.once('exit', (code, signal) => {
      fail(new Error(`child exited before ready (code ${code ?? 'null'}, signal ${signal ?? 'null'})`));
    });
    child.once('error', (error) => {
      fail(error);
    });
  });
}

function withStderr(error: Error, stderrTail: string): Error {
  if (stderrTail.length === 0) return error;
  return new Error(`${error.message}\nchild stderr (tail):\n${stderrTail}`, { cause: error });
}

function raceExit(exited: Promise<number | null>, timeoutMs: number): Promise<boolean> {
  return Promise.race([exited.then(() => true), sleep(timeoutMs).then(() => false)]);
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True once `pid` is fully gone (ESRCH — zombies reaped), false on timeout. */
export async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(50);
  }
  return !pidAlive(pid);
}
