import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Overall budget for the bundled `kimi server run` to finish ensuring a daemon. */
const RUN_TIMEOUT_MS = 30_000;
/** How long to keep polling `/healthz` before declaring the daemon unhealthy. */
const HEALTH_TIMEOUT_MS = 20_000;
const HEALTH_POLL_MS = 200;

/** Subset of the server lock JSON we read (apps/kimi-code writes the full shape). */
interface LockContents {
  pid: number;
  host?: string;
  port: number;
}

/** `<KIMI_CODE_HOME>` or `~/.kimi-code` — must match the server's `resolveKimiHome`. */
export function kimiHome(): string {
  const override = process.env['KIMI_CODE_HOME'];
  if (override !== undefined && override.trim().length > 0) {
    return override;
  }
  return join(homedir(), '.kimi-code');
}

function lockPath(): string {
  return join(kimiHome(), 'server', 'lock');
}

/** Background daemon log written by the SEA — surfaced in the error screen / menu. */
export function serverLogPath(): string {
  return join(kimiHome(), 'server', 'server.log');
}

function readLock(): LockContents | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath(), 'utf-8')) as Partial<LockContents>;
    if (typeof parsed.port === 'number' && typeof parsed.pid === 'number') {
      return {
        pid: parsed.pid,
        port: parsed.port,
        host: typeof parsed.host === 'string' ? parsed.host : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function originFromLock(lock: LockContents): string {
  const host = lock.host !== undefined && lock.host !== '0.0.0.0' ? lock.host : '127.0.0.1';
  return `http://${host}:${lock.port}`;
}

async function isHealthy(origin: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(`${origin}/api/v1/healthz`, { signal: controller.signal });
    if (!res.ok) {
      return false;
    }
    const body = (await res.json()) as { code?: unknown };
    return body.code === 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the bundled SEA's `server run`, which reuses a live shared daemon or
 * spawns one and exits once it is healthy. All discovery / port / lock logic
 * lives in apps/kimi-code's `ensureDaemon`; we do not reimplement it.
 */
function runServerRun(seaPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      seaPath,
      ['server', 'run', '--log-level', 'error'],
      { timeout: RUN_TIMEOUT_MS },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`kimi server run failed: ${error.message}\n${stderr}`.trim()));
          return;
        }
        resolve();
      },
    );
  });
}

export interface EnsureServerResult {
  origin: string;
}

/**
 * Ensure the shared kimi-code daemon is running and return its origin.
 *
 * The desktop app participates in the same local-server ecosystem as the CLI,
 * the browser and the TUI: it reuses a running daemon or starts one that the
 * others can reuse — never a private, app-only server.
 */
export async function ensureServer(seaPath: string): Promise<EnsureServerResult> {
  await runServerRun(seaPath);

  const lock = readLock();
  if (lock === null) {
    throw new Error(`Kimi server lock not found at ${lockPath()} after starting the server.`);
  }
  const origin = originFromLock(lock);

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isHealthy(origin, 500)) {
      return { origin };
    }
    await new Promise((resolve) => {
      setTimeout(resolve, HEALTH_POLL_MS);
    });
  }
  throw new Error(`Kimi server at ${origin} did not become healthy within ${HEALTH_TIMEOUT_MS}ms.`);
}
