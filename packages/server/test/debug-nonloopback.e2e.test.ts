/**
 * Debug-route loopback gating (ROADMAP M5.3).
 *
 * `/api/v1/debug/*` routes are test-only introspection/mutation endpoints.
 * They must only be mounted when the server is bound to a loopback interface;
 * on a non-loopback bind (e.g. `0.0.0.0`) they are suppressed even when the
 * caller passes `debugEndpoints: true`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../src';
import { authHeaders, fixedTokenAuth } from './helpers/serverHarness';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let prevPassword: string | undefined;
const running: RunningServer[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-debug-loopback-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-debug-loopback-home-'));
  // M6.3: a non-loopback bind (0.0.0.0) now refuses to start without a
  // password + TLS opt-out. Set a password so the 0.0.0.0 case can boot; the
  // fixed-token override still governs auth (password ≠ token).
  prevPassword = process.env['KIMI_CODE_PASSWORD'];
  process.env['KIMI_CODE_PASSWORD'] = 'test-pw';
});

afterEach(async () => {
  for (const r of running.splice(0)) {
    try {
      await r.close();
    } catch {
      // ignore
    }
  }
  if (prevPassword === undefined) {
    delete process.env['KIMI_CODE_PASSWORD'];
  } else {
    process.env['KIMI_CODE_PASSWORD'] = prevPassword;
  }
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function boot(host: string): Promise<RunningServer> {
  const r = await startServer({
    serviceOverrides: [fixedTokenAuth()],
    host,
    port: 0,
    lockPath: host === '0.0.0.0' ? join(tmpDir, `lock-${host}`) : lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
    debugEndpoints: true,
    // M6.3: acknowledge the lack of a TLS proxy so the 0.0.0.0 bind is allowed
    // (loopback ignores this — the gate only fires for non-loopback).
    insecureNoTls: true,
  });
  running.push(r);
  return r;
}

/** Probe a debug route on `127.0.0.1:<port>` regardless of the bound host. */
async function probeDebug(r: RunningServer): Promise<number> {
  const port = new URL(r.address).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/debug/prompts/some-session/state`, {
    headers: authHeaders(),
  });
  return res.status;
}

describe('debug endpoints are loopback-only (M5.3)', () => {
  it('does NOT mount /api/v1/debug/* on a non-loopback bind (0.0.0.0)', async () => {
    const r = await boot('0.0.0.0');
    // Route suppressed → Fastify 404 (the auth hook would 401 if the route
    // existed without a token, but with a token a missing route is 404).
    expect(await probeDebug(r)).toBe(404);
  });

  it('mounts /api/v1/debug/* on a loopback bind (127.0.0.1)', async () => {
    const r = await boot('127.0.0.1');
    // Route mounted + valid token → 200 (data is null for an unknown session).
    expect(await probeDebug(r)).toBe(200);
  });
});
