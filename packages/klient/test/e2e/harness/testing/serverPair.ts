/**
 * In-process dual-instance boot: two `kap-server` instances sharing ONE home
 * directory inside the current (test) process.
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
// flushing/unlinking its own files — retry briefly.
const RM_HOME_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

export interface ServerPair {
  readonly a: RunningServer;
  readonly b: RunningServer;
  readonly home: string;
  /**
   * The shared workspace cwd for sessions created against the pair (always
   * the pair home). "Same cwd" is a session-level concept — pass this as
   * `metadata.cwd` in `createSession` on both instances.
   */
  readonly cwd: string;
  /** Base URL of instance `a` (`http://host:port`). */
  readonly urlA: string;
  /** Base URL of instance `b` (`http://host:port`). */
  readonly urlB: string;
  /** REST client for one instance (the pair always boots with `disableAuth`). */
  connectClient(server: RunningServer): HttpClient;
  /** Close both instances (idempotent, best-effort) and remove the home. */
  dispose(): Promise<void>;
}

export async function startServerPair(): Promise<ServerPair> {
  const home = await mkdtemp(join(tmpdir(), 'kimi-e2e-pair-'));
  try {
    const { startServer } = await import('@moonshot-ai/kap-server');
    const boot = (): Promise<RunningServer> =>
      startServer({
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logLevel: 'silent',
        disableAuth: true,
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
      cwd: home,
      urlA: baseUrl(a),
      urlB: baseUrl(b),
      connectClient: (server) =>
        new HttpClient({
          baseUrl: baseUrl(server),
          apiPrefix: '/api/v1',
          fetchImpl: fetch,
        }),
      dispose: async () => {
        if (disposed) return;
        disposed = true;
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
        await rm(home, RM_HOME_OPTIONS);
      },
    };
  } catch (error) {
    await rm(home, RM_HOME_OPTIONS);
    throw error;
  }
}
