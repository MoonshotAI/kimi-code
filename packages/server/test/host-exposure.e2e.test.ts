/**
 * Host-exposure hardening (ROADMAP M6.3–M6.7).
 *
 * Covers the public-bind gate added in M6.3 (force password + TLS opt-out)
 * and, as later steps land, the full §3.5 public hardening stack: rate limit,
 * dangerous-endpoint downgrade, security headers, and Host allowlist.
 *
 * M6.3 scope here: the three gate outcomes on a `0.0.0.0` bind:
 *   1. no password → refuse (password message);
 *   2. password but no `--insecure-no-tls` → refuse (TLS message);
 *   3. password + `insecureNoTls: true` → boot and log the public-bind warning.
 */

import { mkdtempSync, rmSync } from 'node:fs';
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
  it('refuses to bind 0.0.0.0 without a password', async () => {
    delete process.env['KIMI_CODE_PASSWORD'];
    const { lockPath, homeDir } = tmpPaths();

    await expect(
      startServer({
        serviceOverrides: [fixedTokenAuth()],
        host: '0.0.0.0',
        port: 0,
        lockPath,
        insecureNoTls: true,
        logger: pino({ level: 'silent' }),
        coreProcessOptions: { homeDir },
      }),
    ).rejects.toThrow(/without a password/);
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
