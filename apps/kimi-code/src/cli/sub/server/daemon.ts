/**
 * `kimi web` daemon orchestration — parent (spawner) side.
 *
 * Ensures a single background server daemon exists for this device, then
 * returns its origin so the caller can open the web UI. The flow:
 *
 *   1. Read `~/.kimi-code/server/lock`. If it names a *live* daemon, reuse it
 *      (wait for it to be healthy) — never spawn a second one.
 *   2. Otherwise pick a free port (preferred port when available, else an
 *      OS-assigned one) and spawn `kimi server run --daemon` as a detached
 *      child whose stdio is redirected to the server log.
 *   3. Poll the lock until *some* live daemon (ours, or a concurrent racer's
 *      that won the lock) is healthy, then return its origin.
 *
 * The child side (`startServerDaemon`) lives in `./run.ts` next to the
 * foreground runner so it can share the same bootstrap helpers.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { DEFAULT_LOCK_DIR, getLiveLock, type LockContents } from '@moonshot-ai/server';

import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  isServerHealthy,
  serverOrigin,
  waitForServerHealthy,
} from './shared';

const SERVER_LOG_FILENAME = 'server.log';

/** How long to wait for an already-running daemon to answer `/healthz`. */
const REUSE_HEALTH_TIMEOUT_MS = 15_000;
/** How long to wait for a freshly-spawned daemon to come up. */
const SPAWN_TIMEOUT_MS = 20_000;
/** Poll cadence while waiting for the daemon to appear in the lock + healthz. */
const POLL_INTERVAL_MS = 200;
/** Default log level for a daemon spawned without an explicit `--log-level`. */
const DEFAULT_DAEMON_LOG_LEVEL = 'info';

export interface EnsureDaemonOptions {
  /** Preferred port; on conflict a free port is chosen automatically. */
  port?: number;
  /** Pino log level for the spawned daemon (defaults to `info`). */
  logLevel?: string;
  /** Mount `/api/v1/debug/*` routes on the spawned daemon. */
  debugEndpoints?: boolean;
  /** Idle-shutdown grace in ms for the spawned daemon (daemon mode only). */
  idleGraceMs?: number;
}

export interface EnsureDaemonResult {
  readonly origin: string;
}

/** Path of the daemon log file (shared with the OS-service log location). */
export function daemonLogPath(): string {
  return join(DEFAULT_LOCK_DIR, SERVER_LOG_FILENAME);
}

export function lockConnectHost(lock: LockContents): string {
  const host = lock.host ?? DEFAULT_SERVER_HOST;
  return host === '0.0.0.0' ? DEFAULT_SERVER_HOST : host;
}

/** True when `host:port` is currently free to bind (nothing listening). */
function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const probe = createServer();
    probe.once('error', () => resolvePromise(false));
    probe.listen({ host, port }, () => {
      probe.close(() => resolvePromise(true));
    });
  });
}

/** Ask the OS for an ephemeral free port on `host`. */
function getFreePort(host: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen({ host, port: 0 }, () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('failed to allocate a free port')));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePromise(port));
    });
  });
}

/**
 * How many consecutive `preferred + n` ports to probe before giving up and
 * asking the OS for any free port. Mirrors `PORT_RETRY_LIMIT` in the server's
 * own bind retry so the spawner and the daemon agree on the policy.
 */
export const DAEMON_PORT_SCAN_LIMIT = 100;

/**
 * Pick a port for a new daemon: prefer `preferred` when it is free, otherwise
 * walk `preferred + 1`, `+ 2`, … upward and take the first free one. Only when
 * the whole scan window is saturated do we fall back to an OS-assigned free
 * port.
 *
 * Reusing an already-live daemon is handled by `ensureDaemon` before this runs,
 * so a busy port here is held by a third-party process — bumping by one (rather
 * than jumping to a random ephemeral port) keeps the URL predictable, matching
 * the server's own "port busy ⇒ +1" bind retry.
 */
export async function resolveDaemonPort(
  host: string = DEFAULT_SERVER_HOST,
  preferred: number = DEFAULT_SERVER_PORT,
): Promise<number> {
  for (
    let candidate = preferred;
    candidate < preferred + DAEMON_PORT_SCAN_LIMIT && candidate <= 65535;
    candidate++
  ) {
    if (await canBind(host, candidate)) return candidate;
  }
  return getFreePort(host);
}

interface NodeSeaModule {
  isSea(): boolean;
}

const nodeRequire = createRequire(import.meta.url);
let cachedSea: NodeSeaModule | null | undefined;

function loadSeaModule(): NodeSeaModule | null {
  if (cachedSea !== undefined) return cachedSea;
  try {
    cachedSea = nodeRequire('node:sea') as NodeSeaModule;
  } catch {
    cachedSea = null;
  }
  return cachedSea;
}

/** True when running as a compiled single-executable (SEA / native) binary. */
function detectSea(): boolean {
  const sea = loadSeaModule();
  if (sea === null) return false;
  try {
    return sea.isSea();
  } catch {
    return false;
  }
}

/**
 * Absolute path to the CLI entry that should be re-execed to run the daemon.
 * Mirrors `resolveSupervisorProgram` in `packages/server/src/svc/program.ts`:
 * when the CLI is a compiled single binary, `argv[1]` is the invoked command
 * name (e.g. `kimi`) or the first user argument — never a script path — so we
 * must re-exec `process.execPath` itself.
 */
export function resolveDaemonProgram(
  argv: readonly string[] = process.argv,
  cwd: string = process.cwd(),
  execPath: string = process.execPath,
  isSea: boolean = detectSea(),
): string {
  // In a SEA binary `argv[1]` is not a script path, so resolving it against
  // `cwd` would produce a bogus path (e.g. `<cwd>/kimi`) and crash the spawn
  // with ENOENT. Always re-exec the binary itself.
  if (isSea) return execPath;
  const candidate = argv[1] === 'server' ? execPath : (argv[1] ?? execPath);
  return isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
}

interface SpawnDaemonChildOptions {
  port: number;
  logLevel: string;
  debugEndpoints?: boolean;
  idleGraceMs?: number;
}

export function spawnDaemonChild(options: SpawnDaemonChildOptions): void {
  const program = resolveDaemonProgram();
  const logPath = daemonLogPath();
  const logDir = dirname(logPath);
  mkdirSync(logDir, { recursive: true });
  const args = [
    'server',
    'run',
    '--daemon',
    '--port',
    String(options.port),
    '--log-level',
    options.logLevel,
  ];
  if (options.debugEndpoints === true) {
    args.push('--debug-endpoints');
  }
  if (options.idleGraceMs !== undefined) {
    args.push('--idle-grace-ms', String(options.idleGraceMs));
  }
  const logFd = openSync(logPath, 'a');
  try {
    const child = spawn(program, args, {
      detached: true,
      // Run from the server log directory instead of inheriting the caller's
      // cwd, so the long-lived daemon does not pin the directory it was
      // launched from (notably blocking its deletion on Windows).
      cwd: logDir,
      stdio: ['ignore', logFd, logFd],
    });
    child.once('error', (error) => {
      // A spawn failure (e.g. ENOENT) surfaces asynchronously on the child,
      // not as a thrown error. Without a listener Node would crash the parent
      // with an unhandled 'error' event; record it instead and let the polling
      // loop in `ensureDaemon` report the timeout.
      try {
        appendFileSync(logPath, `[spawner] failed to launch daemon: ${error.message}\n`);
      } catch {
        // Best-effort; the log directory may already be gone.
      }
    });
    child.unref();
  } finally {
    // `spawn` dups the fd into the child; the parent must not keep it open.
    closeSync(logFd);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

/**
 * Ensure a daemon is running and return its origin. Non-blocking for the
 * caller beyond the short health wait — the server itself keeps running in a
 * detached process after this returns.
 */
export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<EnsureDaemonResult> {
  const preferred = options.port ?? DEFAULT_SERVER_PORT;
  const logLevel = options.logLevel ?? DEFAULT_DAEMON_LOG_LEVEL;

  // 1. Reuse an already-live daemon if one holds the lock.
  const existing = getLiveLock();
  if (existing) {
    const origin = serverOrigin(lockConnectHost(existing), existing.port);
    if (await waitForServerHealthy(origin, REUSE_HEALTH_TIMEOUT_MS)) {
      return { origin };
    }
    // Live pid but not responding (wedged or mid-boot failure). Fall through
    // and spawn: if it is truly wedged our child loses the lock race and we
    // reconnect below; if it died, stale takeover lets our child claim it.
  }

  // 2. No reusable daemon — pick a free port and spawn one detached.
  const port = await resolveDaemonPort(DEFAULT_SERVER_HOST, preferred);
  spawnDaemonChild({
    port,
    logLevel,
    debugEndpoints: options.debugEndpoints,
    idleGraceMs: options.idleGraceMs,
  });

  // 3. Wait until some live daemon (ours, or a racer that won the lock) is up.
  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const live = getLiveLock();
    if (live) {
      const origin = serverOrigin(lockConnectHost(live), live.port);
      if (await isServerHealthy(origin, 500)) {
        return { origin };
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Kimi server daemon failed to start within ${String(SPAWN_TIMEOUT_MS)}ms. ` +
      `Check the log for details: ${daemonLogPath()}`,
  );
}
