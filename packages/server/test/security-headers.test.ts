/**
 * Security response headers (ROADMAP M6.6).
 *
 * Verifies the `onSend` hook is registered only on a non-loopback bind and
 * that HSTS is omitted while TLS is terminated elsewhere (`tls: false`).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startServer, type RunningServer } from '../src';
import { authHeaders, fixedTokenAuth } from './helpers/serverHarness';

const createdDirs: string[] = [];
const running: RunningServer[] = [];
let prevPassword: string | undefined;

function tmpPaths(): { lockPath: string; homeDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-sec-headers-'));
  const home = mkdtempSync(join(tmpdir(), 'kimi-sec-headers-home-'));
  createdDirs.push(dir, home);
  return { lockPath: join(dir, 'lock'), homeDir: home };
}

beforeEach(() => {
  prevPassword = process.env['KIMI_CODE_PASSWORD'];
});

afterEach(async () => {
  for (const r of running.splice(0)) {
    try {
      await r.close();
    } catch {
      // ignore — best-effort teardown
    }
  }
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (prevPassword === undefined) {
    delete process.env['KIMI_CODE_PASSWORD'];
  } else {
    process.env['KIMI_CODE_PASSWORD'] = prevPassword;
  }
});

async function boot(host: string): Promise<RunningServer> {
  const { lockPath, homeDir } = tmpPaths();
  if (host !== '127.0.0.1') {
    // Non-loopback binds require a password + TLS opt-out (M6.3).
    process.env['KIMI_CODE_PASSWORD'] = 'test-pw';
  }
  const server = await startServer({
    serviceOverrides: [fixedTokenAuth()],
    host,
    port: 0,
    lockPath,
    insecureNoTls: host !== '127.0.0.1',
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir },
  });
  running.push(server);
  return server;
}

describe('security response headers (M6.6)', () => {
  it('sets nosniff / Referrer-Policy / CSP on a non-loopback bind, without HSTS', async () => {
    const server = await boot('0.0.0.0');
    const res = await fetch(`${server.address}/api/v1/sessions`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'");
    // TLS is terminated by the reverse proxy in this phase → no HSTS here.
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });

  it('does NOT set the security headers on a loopback bind', async () => {
    const server = await boot('127.0.0.1');
    const res = await fetch(`${server.address}/api/v1/sessions`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBeNull();
    expect(res.headers.get('referrer-policy')).toBeNull();
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });
});
