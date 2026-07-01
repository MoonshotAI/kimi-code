/**
 * Debug-route suppression (port of v1 `debug-nonloopback.e2e.test.ts`).
 *
 * Security property: `/api/v1/debug/*` introspection/mutation endpoints must
 * NOT be reachable on a non-loopback bind. server-v2 does not register the
 * debug routes at all (the `debugEndpoints` option is currently a no-op), so
 * the property holds trivially — the routes are 404 on every bind. This test
 * pins that guarantee on a public bind and documents the current (not-yet-
 * implemented) loopback behavior.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';

let prevPassword: string | undefined;
const createdDirs: string[] = [];
const running: RunningServer[] = [];

beforeEach(() => {
  prevPassword = process.env['KIMI_CODE_PASSWORD'];
});

afterEach(async () => {
  for (const r of running.splice(0)) {
    try {
      await r.close();
    } catch {
      // ignore
    }
  }
  for (const dir of createdDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  if (prevPassword === undefined) {
    delete process.env['KIMI_CODE_PASSWORD'];
  } else {
    process.env['KIMI_CODE_PASSWORD'] = prevPassword;
  }
});

async function tmpHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-v2-debug-loopback-'));
  createdDirs.push(dir);
  return dir;
}

async function probeDebug(server: RunningServer): Promise<number> {
  const token = server.authTokenService.getToken();
  const res = await fetch(
    `http://127.0.0.1:${server.port}/api/v1/debug/prompts/some-session/state`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  return res.status;
}

describe('debug endpoints are not exposed on a non-loopback bind', () => {
  it('returns 404 for /api/v1/debug/* on a 0.0.0.0 bind even when requested', async () => {
    process.env['KIMI_CODE_PASSWORD'] = 'test-pw';
    const home = await tmpHome();
    const server = await startServer({
      host: '0.0.0.0',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      insecureNoTls: true,
      debugEndpoints: true,
    });
    running.push(server);
    // Route suppressed → 404 (a missing route with a valid token is 404, not 401).
    expect(await probeDebug(server)).toBe(404);
  });

  it('is not mounted on loopback either (server-v2 does not implement debug routes yet)', async () => {
    const home = await tmpHome();
    const server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      debugEndpoints: true,
    });
    running.push(server);
    expect(await probeDebug(server)).toBe(404);
  });
});
