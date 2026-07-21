/**
 * In-process dual-instance boot: two `kap-server` instances sharing ONE home
 * directory inside the current (test) process.
 *
 * Use this by default for multi-server e2e cases; reach for
 * `spawnServerProcess` instead only when the case is signal-sensitive
 * (SIGSTOP / SIGKILL need real, distinct pids).
 *
 * One hard requirement this helper encapsulates: both instances must bind
 * `port: 0` (OS-assigned) — a fixed busy port silently walks to `port + 1`,
 * which breaks assertions on the registry.
 *
 * `@moonshot-ai/kap-server` is imported lazily *inside* the function: its
 * module graph contains `*.md?raw` imports that plain `tsx` (running without
 * the raw-text loader) cannot resolve. Static imports would make the whole
 * harness barrel unloadable there. Type-only imports are erased at compile
 * time and stay safe.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunningServer } from '@moonshot-ai/kap-server';

import { HttpClient } from '../http.js';

// `recursive` rm can hit ENOTEMPTY on macOS while the closing server is still
// flushing/unlinking its own files — retry briefly (same trick as the v2
// smoke test's home cleanup).
const RM_HOME_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

export interface ServerPairOptions {
  /** Shared home for both instances. Created via `mkdtemp` when omitted. */
  readonly home?: string;
  /**
   * Boot both servers with `disableAuth` (no bearer-token hook). Default
   * `true`; when `false`, `connectClient` attaches the per-instance token
   * from `server.authTokenService.getToken()`.
   */
  readonly disableAuth?: boolean;
  /** Extra env vars patched around both boots (restored afterwards). */
  readonly env?: Record<string, string>;
  /**
   * The shared workspace cwd for sessions created against the pair. "Same
   * cwd" is a session-level concept — pass this as `metadata.cwd` in
   * `createSession` on both instances. Defaults to the pair home.
   */
  readonly cwd?: string;
}

export interface ServerPair {
  readonly a: RunningServer;
  readonly b: RunningServer;
  readonly home: string;
  /** Shared workspace cwd — see `ServerPairOptions.cwd`. */
  readonly cwd: string;
  /** Base URL of instance `a` (`http://host:port`). */
  readonly urlA: string;
  /** Base URL of instance `b` (`http://host:port`). */
  readonly urlB: string;
  baseUrl(server: RunningServer): string;
  /**
   * Authed REST client for one instance: bearer token attached unless the
   * pair booted with `disableAuth`.
   */
  connectClient(server: RunningServer): HttpClient;
  /**
   * Close both instances (idempotent, best-effort), restore the pre-boot env,
   * and remove the home directory if this helper created it.
   */
  dispose(): Promise<void>;
}

export async function startServerPair(options: ServerPairOptions = {}): Promise<ServerPair> {
  const home = options.home ?? (await mkdtemp(join(tmpdir(), 'kimi-e2e-pair-')));
  const ownsHome = options.home === undefined;
  const disableAuth = options.disableAuth ?? true;
  const envPatch: Record<string, string> = { ...options.env };
  const savedEnv = saveEnv(envPatch);
  let envRestored = false;
  const restoreEnv = (): void => {
    if (envRestored) return;
    envRestored = true;
    restoreSavedEnv(savedEnv);
  };

  try {
    applyEnv(envPatch);
    const { startServer } = await import('@moonshot-ai/kap-server');
    const boot = (): Promise<RunningServer> =>
      startServer({
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logLevel: 'silent',
        disableAuth,
      });
    const a = await boot();
    let b: RunningServer;
    try {
      b = await boot();
    } catch (error) {
      await a.close();
      throw error;
    }

    const baseUrl = (server: RunningServer): string => `http://${server.host}:${server.port}`;
    let disposed = false;
    return {
      a,
      b,
      home,
      cwd: options.cwd ?? home,
      urlA: baseUrl(a),
      urlB: baseUrl(b),
      baseUrl,
      connectClient: (server) =>
        new HttpClient({
          baseUrl: baseUrl(server),
          apiPrefix: '/api/v1',
          fetchImpl: fetch,
          token: disableAuth ? undefined : server.authTokenService.getToken(),
        }),
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        restoreEnv();
        // Best-effort: a failed close must not mask the other instance's
        // teardown, but it also must not disappear silently.
        const results = await Promise.allSettled([a.close(), b.close()]);
        for (const [label, result] of [
          ['a', results[0]],
          ['b', results[1]],
        ] as const) {
          if (result?.status === 'rejected') {
            process.stderr.write(
              `[server-e2e] startServerPair dispose: instance ${label} close failed: ${String(result.reason)}\n`,
            );
          }
        }
        if (ownsHome) {
          await rm(home, RM_HOME_OPTIONS);
        }
      },
    };
  } catch (error) {
    restoreEnv();
    if (ownsHome) {
      await rm(home, RM_HOME_OPTIONS);
    }
    throw error;
  }
}

function saveEnv(patch: Record<string, string>): Map<string, string | undefined> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    saved.set(key, process.env[key]);
  }
  return saved;
}

function applyEnv(patch: Record<string, string>): void {
  for (const [key, value] of Object.entries(patch)) {
    process.env[key] = value;
  }
}

function restoreSavedEnv(saved: Map<string, string | undefined>): void {
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
