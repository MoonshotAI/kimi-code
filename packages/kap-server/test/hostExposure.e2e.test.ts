/**
 * Public-bind hardening end-to-end (port of v1 `host-exposure.e2e.test.ts`).
 *
 * Covers the parts not already exercised by `securityExposure.test.ts`:
 *   - public-bind gate (refuse without `--insecure-no-tls`; token-only warning
 *     logged on a non-loopback boot without a password);
 *   - real password path (`Authorization: Bearer <password>` → 200 via
 *     `verifyPassword`; wrong / missing credentials → 401);
 *   - auth-failure rate limit (10 bad tokens → 429 on the 11th) on a real bind;
 *   - security response headers on a non-loopback response.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { pino, type Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';

const createdDirs: string[] = [];
const running: RunningServer[] = [];
let prevPassword: string | undefined;

async function tmpHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-v2-host-exposure-'));
  createdDirs.push(dir);
  return dir;
}

function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { logger: pino({ level: 'info' }, dest), lines };
}

beforeEach(() => {
  prevPassword = process.env['KIMI_CODE_PASSWORD'];
});

afterEach(async () => {
  for (const r of running.splice(0)) {
    try {
      await r.close();
    } catch {
      // best-effort
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

describe('public-bind gate', () => {
  it('refuses to bind 0.0.0.0 without --insecure-no-tls', async () => {
    const home = await tmpHome();
    await expect(
      startServer({ host: '0.0.0.0', port: 0, homeDir: home, logLevel: 'silent' }),
    ).rejects.toThrow(/without TLS/);
  });

  it('boots 0.0.0.0 token-only and logs the token-only warning', async () => {
    delete process.env['KIMI_CODE_PASSWORD'];
    const home = await tmpHome();
    const { logger, lines } = capturingLogger();
    const server = await startServer({
      host: '0.0.0.0',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      insecureNoTls: true,
      logger,
    });
    running.push(server);
    const token = server.authTokenService.getToken();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/healthz`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(lines.join('')).toContain('token-only auth');
  });
});

describe('real password path (verifyPassword)', () => {
  async function bootPublic(): Promise<RunningServer> {
    process.env['KIMI_CODE_PASSWORD'] = 'test-pw';
    const home = await tmpHome();
    const server = await startServer({
      host: '0.0.0.0',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      insecureNoTls: true,
    });
    running.push(server);
    return server;
  }

  it('accepts the password as a bearer token and sets security headers', async () => {
    const server = await bootPublic();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/sessions`, {
      headers: { authorization: 'Bearer test-pw' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'self'");
  });

  it('accepts the persistent token on a public bind', async () => {
    const server = await bootPublic();
    const token = server.authTokenService.getToken();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/sessions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects wrong and missing credentials with 401', async () => {
    const server = await bootPublic();
    const wrong = await fetch(`http://127.0.0.1:${server.port}/api/v1/sessions`, {
      headers: { authorization: 'Bearer wrong-password' },
    });
    expect(wrong.status).toBe(401);
    const missing = await fetch(`http://127.0.0.1:${server.port}/api/v1/sessions`);
    expect(missing.status).toBe(401);
  });
});

describe('auth-failure rate limit on a real bind', () => {
  it('returns 429 on the 11th bad token', async () => {
    const home = await tmpHome();
    // Inject a fast token-only auth service: this test exercises the rate
    // limiter, not bcrypt — 12 sequential cost-12 compares would take seconds.
    const server = await startServer({
      host: '0.0.0.0',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      insecureNoTls: true,
      authTokenService: {
        _serviceBrand: undefined,
        getToken: () => 'persistent-token',
        isValid: async (candidate) => candidate === 'persistent-token',
      },
    });
    running.push(server);
    const url = `http://127.0.0.1:${server.port}/api/v1/sessions`;
    let lastStatus = 0;
    for (let i = 0; i < 11; i += 1) {
      const res = await fetch(url, { headers: { authorization: 'Bearer wrong' } });
      lastStatus = res.status;
      if (i < 10) {
        expect(res.status).toBe(401);
      }
    }
    expect(lastStatus).toBe(429);
    const body = (await (await fetch(url, { headers: { authorization: 'Bearer wrong' } })).json()) as {
      code: number;
    };
    expect(body.code).toBe(42901);
  });
});
