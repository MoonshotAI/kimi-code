/**
 * Host-exposure hardening (ROADMAP M6.3–M6.7).
 *
 * End-to-end coverage of the §3.5 public-bind hardening stack on a
 * `host: '0.0.0.0'` + `KIMI_CODE_PASSWORD` + `insecureNoTls: true` server:
 *   - M6.3 public-bind gate (no `--insecure-no-tls` → refuse; token-only
 *     (no password) + `insecureNoTls` → boot + token-only warning logged;
 *     password + `insecureNoTls` → boot + warn logged).
 *   - Real password auth path (`Authorization: Bearer <password>` → 200 via
 *     `verifyPassword`; wrong/missing credentials → 401).
 *   - M6.4 auth-failure rate limit (N bad tokens → 429 on the (N+1)th).
 *   - M6.5 dangerous-endpoint downgrade (shutdown/terminals 404 by default;
 *     200 with the allow flags; loopback mounts shutdown by default).
 *   - Host allowlist (spoofed Host → 403; bound host → 200).
 *   - M6.6 security response headers present on a non-loopback response.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { pino, type Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IServerShutdownService, startServer, type RunningServer, type ServerStartOptions } from '../src';
import { authHeaders, fixedTokenAuth } from './helpers/serverHarness';

const createdDirs: string[] = [];
const running: RunningServer[] = [];
let prevPassword: string | undefined;

function tmpPaths(): { lockPath: string; homeDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-host-exposure-'));
  const home = mkdtempSync(join(tmpdir(), 'kimi-host-exposure-home-'));
  createdDirs.push(dir, home);
  return { lockPath: join(dir, 'lock'), homeDir: home };
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

describe('non-loopback bind gate (M6.3)', () => {
  it('boots 0.0.0.0 without a password (token-only) and logs the token-only warning', async () => {
    delete process.env['KIMI_CODE_PASSWORD'];
    const { lockPath, homeDir } = tmpPaths();
    const { logger, lines } = capturingLogger();

    const server = await startServer({
      serviceOverrides: [fixedTokenAuth()],
      host: '0.0.0.0',
      port: 0,
      lockPath,
      insecureNoTls: true,
      logger,
      coreProcessOptions: { homeDir },
    });
    running.push(server);

    // The server is up with token-only auth: a gated route answers 200.
    const res = await fetch(`${server.address}/api/v1/healthz`, { headers: authHeaders() });
    expect(res.status).toBe(200);

    // The token-only warning was logged so the operator knows the bearer token
    // is the only credential protecting the exposed server.
    expect(lines.join('')).toContain('token-only auth');
  });

  it('refuses to bind 0.0.0.0 with a password but without --insecure-no-tls', async () => {
    process.env['KIMI_CODE_PASSWORD'] = 'test-pw';
    const { lockPath, homeDir } = tmpPaths();

    await expect(
      startServer({
        serviceOverrides: [fixedTokenAuth()],
        host: '0.0.0.0',
        port: 0,
        lockPath,
        logger: pino({ level: 'silent' }),
        coreProcessOptions: { homeDir },
      }),
    ).rejects.toThrow(/without TLS/);
  });

  it('boots 0.0.0.0 with a password + insecureNoTls and logs the public warning', async () => {
    process.env['KIMI_CODE_PASSWORD'] = 'test-pw';
    const { lockPath, homeDir } = tmpPaths();
    const { logger, lines } = capturingLogger();

    const server = await startServer({
      serviceOverrides: [fixedTokenAuth()],
      host: '0.0.0.0',
      port: 0,
      lockPath,
      insecureNoTls: true,
      logger,
      coreProcessOptions: { homeDir },
    });
    running.push(server);

    // The server is up: a gated route answers 200 with a valid token.
    const res = await fetch(`${server.address}/api/v1/healthz`, { headers: authHeaders() });
    expect(res.status).toBe(200);

    // The public-bind warning was logged so the operator knows TLS is off.
    const combined = lines.join('');
    expect(combined).toContain('binding non-loopback host without TLS');
  });
});

describe('dangerous-endpoint downgrade on a public bind (M6.5)', () => {
  interface BootExposureOpts {
    host?: string;
    allowRemoteShutdown?: boolean;
    allowRemoteTerminals?: boolean;
  }

  async function bootExposure(opts: BootExposureOpts = {}): Promise<{
    server: RunningServer;
    shutdownCalls: string[];
  }> {
    process.env['KIMI_CODE_PASSWORD'] = 'test-pw';
    const { lockPath, homeDir } = tmpPaths();
    const shutdownCalls: string[] = [];
    // Capture shutdown requests instead of exiting the process.
    const noopShutdown = [
      IServerShutdownService,
      {
        _serviceBrand: undefined,
        requestShutdown: async (reason: string) => {
          shutdownCalls.push(reason);
        },
      },
    ] as const;
    const serviceOverrides: ServerStartOptions['serviceOverrides'] = [
      fixedTokenAuth(),
      noopShutdown,
    ];
    const server = await startServer({
      serviceOverrides,
      host: opts.host ?? '0.0.0.0',
      port: 0,
      lockPath,
      insecureNoTls: true,
      allowRemoteShutdown: opts.allowRemoteShutdown,
      allowRemoteTerminals: opts.allowRemoteTerminals,
      logger: pino({ level: 'silent' }),
      coreProcessOptions: { homeDir },
    });
    running.push(server);
    return { server, shutdownCalls };
  }

  const terminalsUrl = (server: RunningServer): string =>
    `${server.address}/api/v1/sessions/some-session/terminals`;

  it('returns 404 for shutdown and terminals on a public bind without the allow flags', async () => {
    const { server } = await bootExposure();

    const shutdown = await fetch(`${server.address}/api/v1/shutdown`, {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(shutdown.status).toBe(404);

    const terminals = await fetch(terminalsUrl(server), { headers: authHeaders() });
    expect(terminals.status).toBe(404);
  });

  it('returns 200 for shutdown on a public bind when allowRemoteShutdown is set', async () => {
    const { server, shutdownCalls } = await bootExposure({ allowRemoteShutdown: true });

    const shutdown = await fetch(`${server.address}/api/v1/shutdown`, {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(shutdown.status).toBe(200);
    // The handler replies before triggering shutdown (setImmediate); the noop
    // override captures it so the process does not exit.
    await vi.waitFor(() => expect(shutdownCalls).toContain('api'));
  });

  it('mounts shutdown on a loopback bind by default', async () => {
    const { server, shutdownCalls } = await bootExposure({ host: '127.0.0.1' });

    const shutdown = await fetch(`${server.address}/api/v1/shutdown`, {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(shutdown.status).toBe(200);
    await vi.waitFor(() => expect(shutdownCalls).toContain('api'));
  });
});

/**
 * Raw HTTP GET that lets us set an arbitrary `Host` header. Node's `fetch`
 * (undici) treats `Host` as a forbidden header and silently replaces it with
 * the URL host, so the Host-allowlist test drives `node:http` directly.
 */
function rawHttpGet(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('public-bind §3.5 end-to-end (M6.7)', () => {
  /**
   * Boot a 0.0.0.0 server using the REAL auth impl (no fixed-token override) so
   * the password `verifyPassword` path is exercised. `KIMI_CODE_PASSWORD` is set
   * so the M6.3 gate passes and the password is itself a valid bearer.
   */
  async function bootPublicReal(): Promise<RunningServer> {
    process.env['KIMI_CODE_PASSWORD'] = 'test-pw';
    const { lockPath, homeDir } = tmpPaths();
    const server = await startServer({
      host: '0.0.0.0',
      port: 0,
      lockPath,
      insecureNoTls: true,
      logger: pino({ level: 'silent' }),
      coreProcessOptions: { homeDir },
    });
    running.push(server);
    return server;
  }

  /** Boot a 0.0.0.0 server with a deterministic fixed token. */
  async function bootPublicFixed(token = 'real-token'): Promise<RunningServer> {
    process.env['KIMI_CODE_PASSWORD'] = 'test-pw';
    const { lockPath, homeDir } = tmpPaths();
    const server = await startServer({
      serviceOverrides: [fixedTokenAuth(token)],
      host: '0.0.0.0',
      port: 0,
      lockPath,
      insecureNoTls: true,
      logger: pino({ level: 'silent' }),
      coreProcessOptions: { homeDir },
    });
    running.push(server);
    return server;
  }

  it('accepts the user password as a bearer token (verifyPassword path)', async () => {
    const server = await bootPublicReal();
    const ok = await fetch(`${server.address}/api/v1/sessions`, {
      headers: { Authorization: 'Bearer test-pw' },
    });
    expect(ok.status).toBe(200);
    // Security headers ride on every non-loopback response (M6.6).
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(ok.headers.get('content-security-policy')).toBe("default-src 'self'");
  });

  it('rejects wrong and missing credentials with 401', async () => {
    const server = await bootPublicReal();
    const wrong = await fetch(`${server.address}/api/v1/sessions`, {
      headers: { Authorization: 'Bearer wrong-password' },
    });
    expect(wrong.status).toBe(401);
    const missing = await fetch(`${server.address}/api/v1/sessions`);
    expect(missing.status).toBe(401);
  });

  it('rate-limits repeated auth failures to 429 on a real bind (M6.4)', async () => {
    const server = await bootPublicFixed('real-token');
    const url = `${server.address}/api/v1/sessions`;
    let lastStatus = 0;
    // Default threshold is 10 failures; the 11th must be 429.
    for (let i = 0; i < 11; i += 1) {
      const res = await fetch(url, { headers: { Authorization: 'Bearer wrong' } });
      lastStatus = res.status;
      if (i < 10) {
        expect(res.status).toBe(401);
      }
    }
    expect(lastStatus).toBe(429);
  });

  it('rejects a spoofed Host with 403 and accepts the bound host', async () => {
    const server = await bootPublicFixed();
    // Bound host (0.0.0.0) is a literal IP → allowed by the Host allowlist.
    const bound = await rawHttpGet(`${server.address}/api/v1/healthz`, {
      Host: `0.0.0.0:${new URL(server.address).port}`,
    });
    expect(bound.status).toBe(200);
    // A spoofed Host is rejected before auth (Host check runs first).
    const spoofed = await rawHttpGet(`${server.address}/api/v1/healthz`, {
      Host: 'evil.example.com',
    });
    expect(spoofed.status).toBe(403);
  });
});
