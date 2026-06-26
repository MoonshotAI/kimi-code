/**
 * Tests for `kimi server run` and `kimi web` Commander wiring.
 *
 * These tests don't actually start the server — they verify the parsed shape
 * (option flags, --open default) and that the `web` alias defers to the same
 * underlying handler with `defaultOpen` flipped to true.
 *
 * Foreground startup behavior is exercised end-to-end in `server-e2e/`.
 */

import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import chalk, { Chalk } from 'chalk';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerServerCommand } from '#/cli/sub/server';
import { addLifecycleCommands } from '#/cli/sub/server/lifecycle';
import type { KillCommandDeps } from '#/cli/sub/server/kill';
import { darkColors } from '#/tui/theme/colors';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function makeProgram(): Command {
  // `commander` exitOverride avoids killing the test runner when --help/error fires.
  const program = new Command('kimi').exitOverride();
  registerServerCommand(program);
  return program;
}

describe('kimi server', () => {
  it('registers the expected `server` subcommands while lifecycle commands are hidden', () => {
    const program = makeProgram();
    const server = program.commands.find((c) => c.name() === 'server');
    expect(server).toBeDefined();
    const subs = server?.commands.map((c) => c.name()).toSorted();
    expect(subs).toEqual(['kill', 'ps', 'rotate-token', 'run']);
  });

  it('`server run` exposes local-only foreground options', () => {
    const program = makeProgram();
    const run = program.commands
      .find((c) => c.name() === 'server')
      ?.commands.find((c) => c.name() === 'run');
    expect(run).toBeDefined();
    const longs = run!.options.map((o) => o.long).filter(Boolean);
    expect(longs).toContain('--host');
    expect(longs).toContain('--port');
    expect(longs).toContain('--log-level');
    expect(longs).toContain('--debug-endpoints');
    expect(longs).toContain('--insecure-no-tls');
    expect(longs).toContain('--allow-remote-shutdown');
    expect(longs).toContain('--allow-remote-terminals');
    expect(longs).toContain('--foreground');
    // run defaults to NOT opening the browser → option is the positive --open
    expect(longs).toContain('--open');
  });

  it('`server install` exposes local-only service options', () => {
    // Lifecycle commands are no longer registered via `registerServerCommand`,
    // but the builder still lives in `./lifecycle` — exercise it directly.
    const server = new Command('server');
    addLifecycleCommands(server);
    const install = server.commands.find((c) => c.name() === 'install');
    expect(install).toBeDefined();
    const longs = install!.options.map((o) => o.long).filter(Boolean);
    expect(longs).not.toContain('--host');
    expect(longs).toContain('--port');
    expect(longs).toContain('--log-level');
    expect(longs).toContain('--force');
    expect(longs).toContain('--no-open');
    expect(longs).toContain('--json');
  });

  it('the top-level `kimi web` alias is registered and defaults to opening the browser', () => {
    const program = makeProgram();
    const web = program.commands.find((c) => c.name() === 'web');
    expect(web).toBeDefined();
    const longs = web!.options.map((o) => o.long).filter(Boolean);
    // web defaults to opening → the option is the negative form --no-open
    expect(longs).toContain('--no-open');
    expect(longs).toContain('--host');
    expect(longs).toContain('--port');
  });
});

describe('`kimi server` lifecycle exits with ESERVICE_UNSUPPORTED on unsupported platforms', () => {
  it('the dispatcher returns a friendly error manager for unknown platforms', async () => {
    // darwin / linux / win32 have real backends (launchd / systemd / schtasks).
    // The remaining platforms fall through to the stub that throws
    // `ServiceUnsupportedError` — pin that contract so a future addition
    // (freebsd, etc.) needs a deliberate decision instead of silently working.
    const { resolveServiceManager, ServiceUnsupportedError } = await import('@moonshot-ai/server');
    const mgr = resolveServiceManager('freebsd');
    await expect(
      mgr.install({ host: '127.0.0.1', port: 58627, logLevel: 'info' }),
    ).rejects.toBeInstanceOf(ServiceUnsupportedError);
    await expect(mgr.status()).rejects.toBeInstanceOf(ServiceUnsupportedError);
  });
});

describe('`kimi server` lifecycle handles unavailable service managers', () => {
  it('prints a friendly JSON error and exits 2', async () => {
    const { ServiceUnavailableError } = await import('@moonshot-ai/server');
    const program = new Command('kimi').exitOverride();
    const server = program.command('server');
    let stdout = '';
    let stderr = '';
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${String(code)})`);
    }) as typeof process.exit);

    addLifecycleCommands(server, {
      resolveManager: () => ({
        install: async () => {
          throw new ServiceUnavailableError(
            'linux',
            'systemd --user is not available in this environment.',
          );
        },
        uninstall: async () => ({ ok: true, message: 'unused' }),
        start: async () => ({ ok: true, message: 'unused' }),
        stop: async () => ({ ok: true, message: 'unused' }),
        restart: async () => ({ ok: true, message: 'unused' }),
        status: async () => ({ platform: 'linux', installed: false, running: false }),
      }),
      openUrl: vi.fn(),
      stdout: {
        write(chunk: string | Uint8Array) {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write(chunk: string | Uint8Array) {
          stderr += String(chunk);
          return true;
        },
      },
    });

    await expect(
      program.parseAsync(['node', 'kimi', 'server', 'install', '--json']),
    ).rejects.toThrow('process.exit(2)');

    exit.mockRestore();
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toMatchObject({
      ok: false,
      action: 'unavailable',
      platform: 'linux',
      message: expect.stringContaining('server run --port <port>'),
    });
  });
});

describe('`kimi server` lifecycle output', () => {
  it('install passes --force/--port, prints the URL, and opens it when running', async () => {
    const program = new Command('kimi').exitOverride();
    const server = program.command('server');
    let stdout = '';
    let stderr = '';
    let installArgs: unknown;
    const openUrl = vi.fn();

    addLifecycleCommands(server, {
      resolveManager: () => ({
        install: async (args) => {
          installArgs = args;
          return {
            status: 'replaced',
            message: 'Kimi server LaunchAgent replaced at /tmp/kimi.plist (port 9999).',
            plistPath: '/tmp/kimi.plist',
          };
        },
        uninstall: async () => ({ ok: true, message: 'unused' }),
        start: async () => ({ ok: true, message: 'unused' }),
        stop: async () => ({ ok: true, message: 'unused' }),
        restart: async () => ({ ok: true, message: 'unused' }),
        status: async () => ({
          platform: 'darwin',
          installed: true,
          running: true,
          host: '127.0.0.1',
          port: 9999,
          logPath: '/tmp/server.log',
          label: 'ai.moonshot.kimi-server',
        }),
      }),
      openUrl,
      stdout: {
        write(chunk: string | Uint8Array) {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write(chunk: string | Uint8Array) {
          stderr += String(chunk);
          return true;
        },
      },
    });

    await program.parseAsync([
      'node',
      'kimi',
      'server',
      'install',
      '--force',
      '--port',
      '9999',
    ]);

    expect(stderr).toBe('');
    expect(installArgs).toMatchObject({ port: 9999, force: true });
    expect(stdout).toContain('URL: http://127.0.0.1:9999');
    expect(stdout).toContain('Status: running');
    expect(stdout).toContain('Log: /tmp/server.log');
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:9999');
  });

  it('start prints URL and diagnostics when launchd did not keep the service running', async () => {
    const program = new Command('kimi').exitOverride();
    const server = program.command('server');
    let stdout = '';
    const openUrl = vi.fn();

    addLifecycleCommands(server, {
      resolveManager: () => ({
        install: async () => ({ status: 'installed', message: 'unused' }),
        uninstall: async () => ({ ok: true, message: 'unused' }),
        start: async () => ({ ok: true, message: 'Kimi server started (ai.moonshot.kimi-server).' }),
        stop: async () => ({ ok: true, message: 'unused' }),
        restart: async () => ({ ok: true, message: 'unused' }),
        status: async () => ({
          platform: 'darwin',
          installed: true,
          running: false,
          host: '127.0.0.1',
          port: 58627,
          logPath: '/tmp/server.log',
          label: 'ai.moonshot.kimi-server',
          notes: ['launchd state: spawn scheduled', 'last exit code: 78 EX_CONFIG'],
        }),
      }),
      openUrl,
      stdout: {
        write(chunk: string | Uint8Array) {
          stdout += String(chunk);
          return true;
        },
      },
      stderr: {
        write() {
          return true;
        },
      },
    });

    await program.parseAsync(['node', 'kimi', 'server', 'start']);

    expect(stdout).toContain('URL: http://127.0.0.1:58627');
    expect(stdout).toContain('Status: not running');
    expect(stdout).toContain('launchd state: spawn scheduled');
    expect(stdout).toContain('last exit code: 78 EX_CONFIG');
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe('`kimi server run` background start', () => {
  it('defaults the daemon log level to silent', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let parsed: unknown;

    await handleRunCommand(
      { port: '58627' },
      {
        startServerBackground: async (options) => {
          parsed = options;
          return { origin: 'http://127.0.0.1:58627' };
        },
        openUrl: vi.fn(),
        stdout: {
          write() {
            return true;
          },
        },
        stderr: {
          write() {
            return true;
          },
        },
      },
    );

    expect(parsed).toMatchObject({ logLevel: 'silent' });
  });

  it('passes --log-level through to the background daemon', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let parsed: unknown;

    await handleRunCommand(
      { port: '58627', logLevel: 'debug' },
      {
        startServerBackground: async (options) => {
          parsed = options;
          return { origin: 'http://127.0.0.1:58627' };
        },
        openUrl: vi.fn(),
        stdout: {
          write() {
            return true;
          },
        },
        stderr: {
          write() {
            return true;
          },
        },
      },
    );

    expect(parsed).toMatchObject({ logLevel: 'debug' });
  });

  it('warns and uses the running server host when a daemon is reused', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let stdout = '';

    // The user asks for a public bind, but a loopback daemon is already up.
    await handleRunCommand(
      { port: '58627', host: '0.0.0.0' },
      {
        startServerBackground: async () => ({
          origin: 'http://127.0.0.1:58627',
          reused: true,
          host: '127.0.0.1',
          port: 58627,
        }),
        resolveToken: () => 'tok',
        openUrl: vi.fn(),
        stdout: {
          write(chunk: string | Uint8Array) {
            stdout += String(chunk);
            return true;
          },
        },
        stderr: { write: () => true },
      },
    );

    const plain = stripAnsi(stdout);
    // A clear notice that a server was already running and options were ignored.
    expect(plain).toContain('A server is already running');
    expect(plain).toContain('kimi server kill');
    // The banner uses the *actual* host (loopback), not the requested 0.0.0.0 —
    // so it shows a Local URL plus the "network disabled" hint, NOT real
    // Network addresses (which would be misleading since nothing binds them).
    expect(plain).toContain('http://127.0.0.1:58627/#token=tok');
    expect(plain).toContain('use --host to enable');
    expect(plain).not.toContain('Network:  http');
  });

  it('prints a TUI-style ready panel once the daemon is up', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let stdout = '';

    await handleRunCommand(
      { port: '58627', host: '127.0.0.1' },
      {
        startServerBackground: async () => ({ origin: 'http://127.0.0.1:58627' }),
        openUrl: vi.fn(),
        stdout: {
          write(chunk: string | Uint8Array) {
            stdout += String(chunk);
            return true;
          },
        },
        stderr: {
          write() {
            return true;
          },
        },
      },
    );

    const plain = stripAnsi(stdout);
    expect(plain).toContain('Kimi server ready');
    expect(plain).toContain('Local:');
    expect(plain).toContain('http://127.0.0.1:58627/');
    // Loopback bind shows a Network hint for enabling network access.
    expect(plain).toContain('Network:');
    expect(plain).toContain('use --host to enable');
    expect(plain).toContain('Logs:');
    expect(plain).toContain('off');
    expect(plain).toContain('Stop:');
    expect(plain).toContain('kimi server kill');
    // Version sits on the title line; no separate Ready:/Version: rows and no
    // startup-time metric.
    expect(plain).not.toContain('Ready:');
    expect(plain).not.toContain('Version:');
    expect(plain).not.toContain(' ms');
    // No bordered panel (the token URL must print in full for copying), but
    // the Kimi sprite stays next to the title.
    expect(plain).not.toContain('╭');
    expect(plain).not.toContain('╰');
    expect(plain).toContain('▐█▛█▛█▌');
    expect(plain).toContain('▐█████▌');
    expect(plain).not.toContain('➜');
    expect(plain).not.toContain('Kimi server:');

    // Title is above the URLs; Logs/Stop are at the bottom.
    expect(plain.indexOf('Kimi server ready')).toBeLessThan(plain.indexOf('Local:'));
    expect(plain.indexOf('Logs:')).toBeLessThan(plain.indexOf('Stop:'));
  });

  it('uses the TUI dark palette for the ready banner', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let stdout = '';
    const previousChalkLevel = chalk.level;
    chalk.level = 3;

    try {
      await handleRunCommand(
        { port: '58627', host: '127.0.0.1' },
        {
          startServerBackground: async () => ({ origin: 'http://127.0.0.1:58627' }),
          openUrl: vi.fn(),
          stdout: {
            write(chunk: string | Uint8Array) {
              stdout += String(chunk);
              return true;
            },
          },
          stderr: {
            write() {
              return true;
            },
          },
        },
      );
    } finally {
      chalk.level = previousChalkLevel;
    }

    const color = new Chalk({ level: 3 });
    expect(stdout).toContain(color.hex(darkColors.primary)('▐█▛█▛█▌'));
    expect(stdout).toContain(color.bold.hex(darkColors.primary)('Kimi server ready'));
    expect(stdout).toContain(color.hex(darkColors.accent)('http://127.0.0.1:58627/'));
    expect(stdout).toContain(color.bold.hex(darkColors.textDim)('Local:    '));
    expect(stdout).toContain(color.hex(darkColors.textMuted)('off'));
  });
});

describe('`kimi server run --foreground`', () => {
  it('runs the server in-process instead of spawning a background daemon', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let foregroundOptions: unknown;
    let backgroundCalled = false;

    await handleRunCommand(
      { port: '58627', foreground: true },
      {
        startServerBackground: async () => {
          backgroundCalled = true;
          return { origin: 'http://127.0.0.1:58627' };
        },
        startServerForeground: async (options) => {
          foregroundOptions = options;
          return undefined as unknown as never;
        },
        openUrl: vi.fn(),
        stdout: {
          write() {
            return true;
          },
        },
        stderr: {
          write() {
            return true;
          },
        },
      },
    );

    expect(backgroundCalled).toBe(false);
    expect(foregroundOptions).toMatchObject({ port: 58627, logLevel: 'silent' });
  });

  it('prints the ready banner and opens the browser once listening', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let stdout = '';
    const openUrl = vi.fn();

    await handleRunCommand(
      { port: '58627', host: '127.0.0.1', foreground: true, open: true },
      {
        startServerBackground: async () => ({ origin: 'http://127.0.0.1:58627' }),
        startServerForeground: async (options, hooks) => {
          void options;
          hooks?.onReady?.('http://127.0.0.1:58627');
          return undefined as unknown as never;
        },
        openUrl,
        stdout: {
          write(chunk: string | Uint8Array) {
            stdout += String(chunk);
            return true;
          },
        },
        stderr: {
          write() {
            return true;
          },
        },
      },
    );

    const plain = stripAnsi(stdout);
    expect(plain).toContain('Kimi server ready');
    expect(plain).toContain('http://127.0.0.1:58627/');
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:58627');
  });
});

describe('`kimi server` does not register a legacy `daemon` command', () => {
  it('hard-deletes the old name', () => {
    const program = makeProgram();
    const daemon = program.commands.find((c) => c.name() === 'daemon');
    expect(daemon).toBeUndefined();
  });
});

describe('shared parsers stay strict', () => {
  it('rejects out-of-range --port', async () => {
    const { parsePort } = await import('#/cli/sub/server/shared');
    expect(() => parsePort('99999', '--port', 58627)).toThrow(/invalid --port/);
    expect(() => parsePort('-1', '--port', 58627)).toThrow(/invalid --port/);
    expect(parsePort(undefined, '--port', 58627)).toBe(58627);
    expect(parsePort('8080', '--port', 58627)).toBe(8080);
  });

  it('rejects unknown --log-level values', async () => {
    const { parseLogLevel } = await import('#/cli/sub/server/shared');
    expect(() => parseLogLevel('shout')).toThrow(/invalid --log-level/);
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('debug')).toBe('debug');
  });
});

describe('server web asset directory resolution', () => {
  it('uses extracted SEA web assets when available', async () => {
    const { resolveServerWebAssetsDir } = await import('#/cli/sub/server/run');
    expect(resolveServerWebAssetsDir('/cache/kimi/dist-web')).toBe('/cache/kimi/dist-web');
  });

  it('falls back to package dist-web outside SEA mode', async () => {
    const { resolveServerWebAssetsDir } = await import('#/cli/sub/server/run');
    expect(resolveServerWebAssetsDir(null)).toMatch(/[/\\]dist-web$/);
  });
});

function listenOnce(host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host, port }, () => {
      resolve(server);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function allocateFreePort(host = '127.0.0.1'): Promise<number> {
  const server = await listenOnce(host, 0);
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await closeServer(server);
  return port;
}

/**
 * Find the start of a run of `count` consecutive free ports
 * (`start`, `start + 1`, …, `start + count - 1` all bindable).
 */
async function allocateAdjacentFreeRun(count: number, host = '127.0.0.1'): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const start = await allocateFreePort(host);
    if (start <= 0 || start + count - 1 > 65535) continue;
    const held: Server[] = [];
    let ok = true;
    for (let offset = 1; offset < count; offset++) {
      const probe = await listenOnce(host, start + offset).catch(() => null);
      if (probe === null) {
        ok = false;
        break;
      }
      held.push(probe);
    }
    for (const server of held) await closeServer(server);
    if (ok) return start;
  }
  throw new Error('could not allocate a run of adjacent free ports');
}

describe('--host threading (M6.2)', () => {
  it('passes --host through to the background daemon', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let parsed: unknown;

    await handleRunCommand(
      { port: '58627', host: '0.0.0.0' },
      {
        startServerBackground: async (options) => {
          parsed = options;
          return { origin: 'http://0.0.0.0:58627' };
        },
        openUrl: vi.fn(),
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
    );

    expect(parsed).toMatchObject({ host: '0.0.0.0', port: 58627 });
  });

  it('passes --host through to the foreground runner', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let foregroundOptions: unknown;

    await handleRunCommand(
      { port: '58627', host: '0.0.0.0', foreground: true },
      {
        startServerBackground: async () => ({ origin: 'http://0.0.0.0:58627' }),
        startServerForeground: async (options) => {
          foregroundOptions = options;
          return undefined as unknown as never;
        },
        openUrl: vi.fn(),
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
    );

    expect(foregroundOptions).toMatchObject({ host: '0.0.0.0' });
  });
});

describe('default bind (M6.3)', () => {
  it('defaults host to 127.0.0.1 and insecureNoTls to true when no flags are passed', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let parsed: unknown;

    await handleRunCommand(
      { port: '58627' },
      {
        startServerBackground: async (options) => {
          parsed = options;
          return { origin: 'http://127.0.0.1:58627' };
        },
        openUrl: vi.fn(),
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
    );

    expect(parsed).toMatchObject({ host: '127.0.0.1', insecureNoTls: true });
  });

  it('treats a bare --host as the default LAN host', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let parsed: unknown;

    await handleRunCommand(
      { port: '58627', host: true },
      {
        startServerBackground: async (options) => {
          parsed = options;
          return { origin: 'http://0.0.0.0:58627' };
        },
        openUrl: vi.fn(),
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
    );

    expect(parsed).toMatchObject({ host: '0.0.0.0', insecureNoTls: true });
  });
});

describe('--allowed-host threading', () => {
  it('parses comma-separated --allowed-host values', async () => {
    const { parseAllowedHostArgs } = await import('#/cli/sub/server/shared');
    expect(parseAllowedHostArgs(['.example.com, app.example.com'])).toEqual([
      '.example.com',
      'app.example.com',
    ]);
  });

  it('threads --allowed-host to the background daemon options', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let parsed: unknown;

    await handleRunCommand(
      { port: '58627', allowedHost: ['.example.com'] },
      {
        startServerBackground: async (options) => {
          parsed = options;
          return { origin: 'http://127.0.0.1:58627' };
        },
        openUrl: vi.fn(),
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
    );

    expect(parsed).toMatchObject({ allowedHosts: ['.example.com'] });
  });
});

describe('lockConnectHost (M6.2 connect side)', () => {
  it('maps a 0.0.0.0 bind to 127.0.0.1 so the CLI connects over loopback', async () => {
    const { lockConnectHost } = await import('#/cli/sub/server/daemon');
    // The daemon binds 0.0.0.0 (all interfaces), but the local CLI must
    // connect over loopback — 0.0.0.0 is not a connectable address. The token
    // then rides on that loopback connection (covered by the M5.4 kill/ps
    // Authorization tests).
    expect(lockConnectHost({ pid: 1, started_at: '', port: 58627, host: '0.0.0.0' })).toBe(
      '127.0.0.1',
    );
  });

  it('preserves a loopback / concrete bind host', async () => {
    const { lockConnectHost } = await import('#/cli/sub/server/daemon');
    expect(lockConnectHost({ pid: 1, started_at: '', port: 58627, host: '127.0.0.1' })).toBe(
      '127.0.0.1',
    );
    expect(lockConnectHost({ pid: 1, started_at: '', port: 58627, host: '192.168.1.5' })).toBe(
      '192.168.1.5',
    );
  });

  it('falls back to 127.0.0.1 when the lock has no host', async () => {
    const { lockConnectHost } = await import('#/cli/sub/server/daemon');
    expect(lockConnectHost({ pid: 1, started_at: '', port: 58627 })).toBe('127.0.0.1');
  });
});

describe('--insecure-no-tls threading (M6.3)', () => {
  it('threads --insecure-no-tls to the foreground runner', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let foregroundOptions: unknown;

    await handleRunCommand(
      { host: '0.0.0.0', insecureNoTls: true, foreground: true },
      {
        startServerBackground: async () => ({ origin: 'http://0.0.0.0:58627' }),
        startServerForeground: async (options) => {
          foregroundOptions = options;
          return undefined as unknown as never;
        },
        openUrl: vi.fn(),
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
    );

    expect(foregroundOptions).toMatchObject({ host: '0.0.0.0', insecureNoTls: true });
  });

  it('threads --insecure-no-tls to the background daemon', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let parsed: unknown;

    await handleRunCommand(
      { host: '0.0.0.0', insecureNoTls: true },
      {
        startServerBackground: async (options) => {
          parsed = options;
          return { origin: 'http://0.0.0.0:58627' };
        },
        openUrl: vi.fn(),
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
    );

    expect(parsed).toMatchObject({ insecureNoTls: true });
  });
});

describe('ready banner reflects the bind class (M6.3)', () => {
  it('lists Local + Network addresses for a 0.0.0.0 bind (Vite-style)', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let stdout = '';

    await handleRunCommand(
      { host: '0.0.0.0', insecureNoTls: true },
      {
        startServerBackground: async () => ({ origin: 'http://0.0.0.0:58627' }),
        resolveToken: () => 'tok-xyz',
        networkAddresses: [
          { address: '192.168.98.66', family: 'IPv4' },
          { address: '10.8.12.216', family: 'IPv4' },
        ],
        openUrl: vi.fn(),
        stdout: {
          write(chunk: string | Uint8Array) {
            stdout += String(chunk);
            return true;
          },
        },
        stderr: { write: () => true },
      },
    );

    const raw = stripAnsi(stdout);
    expect(raw).toContain('Kimi server ready');
    expect(raw).toContain('Local:');
    expect(raw).toContain('Network:');
    // Full token-bearing URLs are printed plainly (no box, no truncation) so
    // they are easy to copy.
    expect(raw).toContain('http://localhost:58627/#token=tok-xyz');
    expect(raw).toContain('http://192.168.98.66:58627/#token=tok-xyz');
    expect(raw).toContain('http://10.8.12.216:58627/#token=tok-xyz');
    expect(raw).toContain('Token:');
    expect(raw).toContain('tok-xyz');
    expect(raw).not.toContain('╭');
  });

  it('prints the Local URL and token for a 127.0.0.1 bind', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let stdout = '';

    await handleRunCommand(
      { host: '127.0.0.1' },
      {
        startServerBackground: async () => ({ origin: 'http://127.0.0.1:58627' }),
        resolveToken: () => 'tok-loop',
        openUrl: vi.fn(),
        stdout: {
          write(chunk: string | Uint8Array) {
            stdout += String(chunk);
            return true;
          },
        },
        stderr: { write: () => true },
      },
    );

    const raw = stripAnsi(stdout);
    expect(raw).toContain('Kimi server ready');
    expect(raw).toContain('Local:');
    // Full token-bearing URL, printed plainly for copying.
    expect(raw).toContain('http://127.0.0.1:58627/#token=tok-loop');
    expect(raw).toContain('Token:');
    expect(raw).toContain('tok-loop');
    expect(raw).not.toContain('╭');
  });
});

describe('resolveDaemonPort', () => {
  it('returns the preferred port when it is free', async () => {
    const { resolveDaemonPort } = await import('#/cli/sub/server/daemon');
    const free = await allocateFreePort();
    await expect(resolveDaemonPort('127.0.0.1', free)).resolves.toBe(free);
  });

  it('falls back to a different free port when the preferred port is busy', async () => {
    const { resolveDaemonPort } = await import('#/cli/sub/server/daemon');
    const busy = await allocateFreePort();
    const holder = await listenOnce('127.0.0.1', busy);
    try {
      const port = await resolveDaemonPort('127.0.0.1', busy);
      expect(port).not.toBe(busy);
      expect(port).toBeGreaterThan(0);
    } finally {
      await closeServer(holder);
    }
  });

  it('walks to preferred+1 when only the preferred port is busy', async () => {
    const { resolveDaemonPort } = await import('#/cli/sub/server/daemon');
    const start = await allocateAdjacentFreeRun(2);
    const holder = await listenOnce('127.0.0.1', start);
    try {
      const port = await resolveDaemonPort('127.0.0.1', start);
      expect(port).toBe(start + 1);
    } finally {
      await closeServer(holder);
    }
  });

  it('skips past a run of busy ports to the first free one', async () => {
    const { resolveDaemonPort } = await import('#/cli/sub/server/daemon');
    const start = await allocateAdjacentFreeRun(3);
    // Hold both `start` and `start+1`; the resolver should land on `start+2`.
    const holderA = await listenOnce('127.0.0.1', start);
    const holderB = await listenOnce('127.0.0.1', start + 1);
    try {
      const port = await resolveDaemonPort('127.0.0.1', start);
      expect(port).toBe(start + 2);
    } finally {
      await closeServer(holderA);
      await closeServer(holderB);
    }
  });
});

describe('resolveDaemonProgram', () => {
  it('uses the absolute script path outside SEA mode', async () => {
    const { resolveDaemonProgram } = await import('#/cli/sub/server/daemon');
    expect(resolveDaemonProgram(['node', '/opt/kimi/dist/cli.mjs'], '/tmp', '/usr/bin/node', false)).toBe('/opt/kimi/dist/cli.mjs');
  });

  it('normalizes a relative executable path against cwd outside SEA mode', async () => {
    const { resolveDaemonProgram } = await import('#/cli/sub/server/daemon');
    expect(resolveDaemonProgram(['node', './kimi'], '/tmp/kimi-bin', '/usr/bin/node', false)).toBe('/tmp/kimi-bin/kimi');
  });

  it('returns execPath in SEA mode when argv[1] is a bare command name', async () => {
    // Reproduces `kimi web` from the shell: argv[1] is the invoked command
    // name (`kimi`), not a path. Resolving it against cwd produced `<cwd>/kimi`
    // and crashed the spawn with ENOENT.
    const { resolveDaemonProgram } = await import('#/cli/sub/server/daemon');
    expect(resolveDaemonProgram(['/Users/x/.kimi-code/bin/kimi', 'kimi', 'web'], '/Users/x', '/Users/x/.kimi-code/bin/kimi', true)).toBe('/Users/x/.kimi-code/bin/kimi');
  });

  it('returns execPath in SEA mode for a spawned `server` child', async () => {
    const { resolveDaemonProgram } = await import('#/cli/sub/server/daemon');
    expect(resolveDaemonProgram(['/Users/x/.kimi-code/bin/kimi', 'server', 'run'], '/Users/x', '/Users/x/.kimi-code/bin/kimi', true)).toBe('/Users/x/.kimi-code/bin/kimi');
  });
});

describe('spawnDaemonChild', () => {
  let workDir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'kimi-daemon-cwd-'));
    prevHome = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = workDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env['KIMI_CODE_HOME'];
    } else {
      process.env['KIMI_CODE_HOME'] = prevHome;
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it('spawns the daemon with cwd set to the server log directory', async () => {
    const { spawn } = await import('node:child_process');
    const spawnMock = vi.mocked(spawn);
    spawnMock.mockClear();
    spawnMock.mockReturnValue({ unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess);

    const { spawnDaemonChild, daemonLogPath } = await import('#/cli/sub/server/daemon');
    spawnDaemonChild({ port: 58627, logLevel: 'info' });

    expect(spawnMock).toHaveBeenCalledOnce();
    const [program, args, options] = spawnMock.mock.calls[0]!;
    expect(program).toBeTruthy();
    expect(args).toEqual(expect.arrayContaining(['server', 'run', '--daemon']));
    expect(options).toMatchObject({ detached: true, cwd: dirname(daemonLogPath()) });
    expect(options?.cwd).not.toBe(process.cwd());
  });

  it('passes --host through to the daemon child args (M6.2)', async () => {
    const { spawn } = await import('node:child_process');
    const spawnMock = vi.mocked(spawn);
    spawnMock.mockClear();
    spawnMock.mockReturnValue({ unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess);

    const { spawnDaemonChild } = await import('#/cli/sub/server/daemon');
    spawnDaemonChild({ host: '0.0.0.0', port: 58627, logLevel: 'info' });

    const [, args] = spawnMock.mock.calls[0]!;
    expect(args).toEqual(expect.arrayContaining(['--host', '0.0.0.0']));
  });

  it('passes --insecure-no-tls through to the daemon child args (M6.3)', async () => {
    const { spawn } = await import('node:child_process');
    const spawnMock = vi.mocked(spawn);
    spawnMock.mockClear();
    spawnMock.mockReturnValue({ unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess);

    const { spawnDaemonChild } = await import('#/cli/sub/server/daemon');
    spawnDaemonChild({ host: '0.0.0.0', port: 58627, logLevel: 'info', insecureNoTls: true });

    const [, args] = spawnMock.mock.calls[0]!;
    expect(args).toEqual(expect.arrayContaining(['--insecure-no-tls']));
  });

  it('passes --allowed-host through to the daemon child args', async () => {
    const { spawn } = await import('node:child_process');
    const spawnMock = vi.mocked(spawn);
    spawnMock.mockClear();
    spawnMock.mockReturnValue({ unref: vi.fn(), once: vi.fn() } as unknown as ChildProcess);

    const { spawnDaemonChild } = await import('#/cli/sub/server/daemon');
    spawnDaemonChild({ port: 58627, logLevel: 'info', allowedHosts: ['.example.com'] });

    const [, args] = spawnMock.mock.calls[0]!;
    expect(args).toEqual(expect.arrayContaining(['--allowed-host', '.example.com']));
  });
});

describe('ensureDaemon surfaces boot failures via early exit', () => {
  let workDir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'kimi-ensure-exit-'));
    prevHome = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = workDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env['KIMI_CODE_HOME'];
    } else {
      process.env['KIMI_CODE_HOME'] = prevHome;
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it('rejects fast with the exit reason and a log tail when the daemon exits early', async () => {
    const { spawn } = await import('node:child_process');
    const spawnMock = vi.mocked(spawn);
    const { mkdirSync, writeFileSync: writeSync } = await import('node:fs');
    const { daemonLogPath, ensureDaemon } = await import('#/cli/sub/server/daemon');

    // Seed the daemon log with the kind of line a failing boot writes, so we
    // can assert it is surfaced to the user instead of a generic timeout.
    mkdirSync(dirname(daemonLogPath()), { recursive: true });
    writeSync(daemonLogPath(), 'fatal: Refusing to bind a non-loopback host without TLS.\n');

    // Fake child that exits with code 1 shortly after the 'exit' listener is
    // attached — simulating a daemon that fails during boot.
    const fakeChild = {
      unref: vi.fn(),
      once: vi.fn((event: string, cb: (...a: unknown[]) => void) => {
        if (event === 'exit') {
          setTimeout(() => {
            cb(1, null);
          }, 5);
        }
        return fakeChild;
      }),
    };
    spawnMock.mockReturnValueOnce(fakeChild as unknown as ChildProcess);

    const start = Date.now();
    let caught: unknown;
    try {
      await ensureDaemon({ port: 0 });
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - start;

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toMatch(/exited with code 1/);
    expect(message).toContain('Refusing to bind');
    // Must fail fast — nowhere near the 20s spawn timeout.
    expect(elapsed).toBeLessThan(5000);
  });
});

describe('createIdleShutdownHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not arm before any client connects', async () => {
    const { createIdleShutdownHandler } = await import('#/cli/sub/server/run');
    const onIdle = vi.fn();
    const handler = createIdleShutdownHandler({ graceMs: 1000, onIdle });
    handler.onConnectionCountChange(0);
    vi.advanceTimersByTime(2000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('fires onIdle after the grace once the last client leaves', async () => {
    const { createIdleShutdownHandler } = await import('#/cli/sub/server/run');
    const onIdle = vi.fn();
    const handler = createIdleShutdownHandler({ graceMs: 1000, onIdle });
    handler.onConnectionCountChange(1);
    handler.onConnectionCountChange(0);
    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending exit when a client reconnects during the grace', async () => {
    const { createIdleShutdownHandler } = await import('#/cli/sub/server/run');
    const onIdle = vi.fn();
    const handler = createIdleShutdownHandler({ graceMs: 1000, onIdle });
    handler.onConnectionCountChange(1);
    handler.onConnectionCountChange(0);
    vi.advanceTimersByTime(500);
    handler.onConnectionCountChange(1); // reconnect
    vi.advanceTimersByTime(2000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('only the final drop to zero arms the timer with multiple clients', async () => {
    const { createIdleShutdownHandler } = await import('#/cli/sub/server/run');
    const onIdle = vi.fn();
    const handler = createIdleShutdownHandler({ graceMs: 500, onIdle });
    handler.onConnectionCountChange(1);
    handler.onConnectionCountChange(2);
    handler.onConnectionCountChange(1); // still one connected
    vi.advanceTimersByTime(1000);
    expect(onIdle).not.toHaveBeenCalled();
    handler.onConnectionCountChange(0); // now none
    vi.advanceTimersByTime(500);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });
});

describe('kimi web (shares `server run` call stack)', () => {
  it('prints the ready banner and opens the browser by default', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let stdout = '';
    const openUrl = vi.fn();

    await handleRunCommand(
      { port: '58627', open: true },
      {
        startServerBackground: async () => ({ origin: 'http://127.0.0.1:58627' }),
        openUrl,
        stdout: {
          write(chunk: string | Uint8Array) {
            stdout += String(chunk);
            return true;
          },
        },
        stderr: {
          write() {
            return true;
          },
        },
      },
    );

    expect(stripAnsi(stdout)).toContain('Kimi server ready');
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:58627');
  });

  it('does not open the browser when open is false', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    const openUrl = vi.fn();
    await handleRunCommand(
      { port: '58627' },
      {
        startServerBackground: async () => ({ origin: 'http://127.0.0.1:9000' }),
        openUrl,
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
    );
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('rejects an invalid --log-level before touching the daemon', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    const startServerBackground = vi.fn();
    await expect(
      handleRunCommand(
        { logLevel: 'shout' },
        {
          startServerBackground,
          openUrl: vi.fn(),
          stdout: { write: () => true },
          stderr: { write: () => true },
        },
      ),
    ).rejects.toThrow(/invalid --log-level/);
    expect(startServerBackground).not.toHaveBeenCalled();
  });
});

function makeKillDeps(overrides: Partial<KillCommandDeps> = {}): {
  deps: KillCommandDeps;
  writes: string[];
  signals: Array<{ pid: number; signal: NodeJS.Signals }>;
  state: { shutdownCalls: number };
  clock: { t: number };
} {
  const writes: string[] = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const state = { shutdownCalls: 0 };
  const clock = { t: 0 };
  const deps: KillCommandDeps = {
    getLiveLock: () => undefined,
    requestShutdown: async () => {
      state.shutdownCalls += 1;
    },
    resolveToken: () => undefined,
    signalPid: (pid, signal) => {
      signals.push({ pid, signal });
      return true;
    },
    pidAlive: () => false,
    sleep: async (ms) => {
      clock.t += ms;
    },
    stdout: {
      write(chunk: string | Uint8Array) {
        writes.push(String(chunk));
        return true;
      },
    },
    now: () => clock.t,
    ...overrides,
  };
  return { deps, writes, signals, state, clock };
}

describe('`kimi server kill`', () => {
  const liveLock = { pid: 1234, started_at: '2026-06-17T00:00:00.000Z', port: 58627 };

  it('prints "No running Kimi server." and sends no signal when no live lock exists', async () => {
    const { handleKillCommand } = await import('#/cli/sub/server/kill');
    const { deps, writes, signals } = makeKillDeps({ getLiveLock: () => undefined });

    await handleKillCommand(deps);

    expect(writes.join('')).toContain('No running Kimi server.');
    expect(signals).toEqual([]);
  });

  it('attempts the API shutdown, then stops after SIGTERM when the pid exits promptly', async () => {
    const { handleKillCommand } = await import('#/cli/sub/server/kill');
    const { deps, writes, signals, state, clock } = makeKillDeps({
      getLiveLock: () => liveLock,
      pidAlive: () => clock.t < 50,
    });

    await handleKillCommand(deps);

    expect(state.shutdownCalls).toBe(1);
    expect(signals).toEqual([{ pid: 1234, signal: 'SIGTERM' }]);
    expect(writes.join('')).toContain('pid 1234');
    expect(writes.join('')).toContain('stopped.');
  });

  it('escalates to SIGKILL when the pid survives SIGTERM', async () => {
    const { handleKillCommand } = await import('#/cli/sub/server/kill');
    const { deps, writes, signals, clock } = makeKillDeps({
      getLiveLock: () => ({ ...liveLock, pid: 5678 }),
      // Survives the 3s SIGTERM grace, dies during the 2s SIGKILL grace.
      pidAlive: () => clock.t < 3100,
    });

    await handleKillCommand(deps);

    expect(signals.map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(writes.join('')).toContain('pid 5678');
    expect(writes.join('')).toContain('killed.');
  });

  it('throws a permissions error when the pid survives SIGKILL', async () => {
    const { handleKillCommand } = await import('#/cli/sub/server/kill');
    const { deps } = makeKillDeps({
      getLiveLock: () => ({ ...liveLock, pid: 9999 }),
      pidAlive: () => true,
    });

    await expect(handleKillCommand(deps)).rejects.toThrow(/insufficient permissions/);
  });
});

describe('resolveServerToken', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-server-token-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the token from <homeDir>/server.token', async () => {
    const { resolveServerToken } = await import('#/cli/sub/server/shared');
    writeFileSync(join(dir, 'server.token'), 'secret-token\n');
    expect(resolveServerToken(dir)).toBe('secret-token');
  });

  it('trims surrounding whitespace', async () => {
    const { resolveServerToken } = await import('#/cli/sub/server/shared');
    writeFileSync(join(dir, 'server.token'), '  tok  \n');
    expect(resolveServerToken(dir)).toBe('tok');
  });

  it('throws a clear error when the token file is missing', async () => {
    const { resolveServerToken } = await import('#/cli/sub/server/shared');
    expect(() => resolveServerToken(dir)).toThrow(/unable to read server token/);
  });
});

describe('authHeaders', () => {
  it('builds a Bearer Authorization header', async () => {
    const { authHeaders } = await import('#/cli/sub/server/shared');
    expect(authHeaders('abc')).toEqual({ Authorization: 'Bearer abc' });
  });
});

describe('`kimi server kill` carries the bearer token', () => {
  const liveLock = { pid: 1234, started_at: '2026-06-17T00:00:00.000Z', port: 58627 };

  it('passes the resolved token to requestShutdown', async () => {
    const { handleKillCommand } = await import('#/cli/sub/server/kill');
    let seenToken: string | undefined = 'unset';
    const { deps } = makeKillDeps({
      getLiveLock: () => liveLock,
      resolveToken: () => 'tok-123',
      requestShutdown: async (_origin, token) => {
        seenToken = token;
      },
      pidAlive: () => false,
    });

    await handleKillCommand(deps);

    expect(seenToken).toBe('tok-123');
  });

  it('passes undefined when the token cannot be read (best-effort)', async () => {
    const { handleKillCommand } = await import('#/cli/sub/server/kill');
    let seenToken: string | undefined = 'unset';
    const { deps } = makeKillDeps({
      getLiveLock: () => liveLock,
      resolveToken: () => undefined,
      requestShutdown: async (_origin, token) => {
        seenToken = token;
      },
      pidAlive: () => false,
    });

    await handleKillCommand(deps);

    expect(seenToken).toBeUndefined();
  });
});

describe('buildWebUrl', () => {
  it('carries the token in the URL fragment (not path or query)', async () => {
    const { buildWebUrl } = await import('#/cli/sub/server/run');
    const url = buildWebUrl('http://127.0.0.1:58627', 'abc123');
    expect(url).toBe('http://127.0.0.1:58627/#token=abc123');
    const parsed = new URL(url);
    expect(parsed.hash).toBe('#token=abc123');
    // The token is client-side only: it must NOT appear in the path or query
    // (which WOULD be sent to the server and logged).
    expect(parsed.pathname).not.toContain('abc123');
    expect(parsed.search).not.toContain('abc123');
  });

  it('normalizes a trailing slash', async () => {
    const { buildWebUrl } = await import('#/cli/sub/server/run');
    expect(buildWebUrl('http://127.0.0.1:58627/', 't')).toBe(
      'http://127.0.0.1:58627/#token=t',
    );
  });
});

describe('accessUrlLines', () => {
  it('returns Local + Network lines for a wildcard bind', async () => {
    const { accessUrlLines } = await import('#/cli/sub/server/access-urls');
    const lines = accessUrlLines('0.0.0.0', 58627, 'tok', [
      { address: '192.168.1.5', family: 'IPv4' },
    ]);
    expect(lines).toEqual([
      { label: 'Local:    ', url: 'http://localhost:58627/#token=tok' },
      { label: 'Network:  ', url: 'http://192.168.1.5:58627/#token=tok' },
    ]);
  });

  it('returns a single Local line for a loopback bind', async () => {
    const { accessUrlLines } = await import('#/cli/sub/server/access-urls');
    const lines = accessUrlLines('127.0.0.1', 58627, 'tok');
    expect(lines).toEqual([
      { label: 'Local:    ', url: 'http://127.0.0.1:58627/#token=tok' },
    ]);
  });

  it('returns a single URL line for a specific host (no token)', async () => {
    const { accessUrlLines } = await import('#/cli/sub/server/access-urls');
    const lines = accessUrlLines('192.168.1.5', 58627, undefined);
    expect(lines).toEqual([{ label: 'URL:      ', url: 'http://192.168.1.5:58627/' }]);
  });

  it('splitTokenFragment splits off the #token= fragment', async () => {
    const { splitTokenFragment } = await import('#/cli/sub/server/access-urls');
    expect(splitTokenFragment('http://h:1/#token=abc')).toEqual(['http://h:1/', '#token=abc']);
    expect(splitTokenFragment('http://h:1/')).toEqual(['http://h:1/', '']);
  });
});

describe('`kimi web` / `server run --open` token fragment (M5.5)', () => {
  it('opens the Web UI URL with the token fragment when a token is resolvable', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    const openUrl = vi.fn();
    await handleRunCommand(
      { port: '58627', open: true },
      {
        startServerBackground: async () => ({ origin: 'http://127.0.0.1:58627' }),
        resolveToken: () => 'tok-xyz',
        openUrl,
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
    );
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:58627/#token=tok-xyz');
  });

  it('opens the plain origin when no token is resolvable', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    const openUrl = vi.fn();
    await handleRunCommand(
      { port: '58627', open: true },
      {
        startServerBackground: async () => ({ origin: 'http://127.0.0.1:58627' }),
        resolveToken: () => undefined,
        openUrl,
        stdout: { write: () => true },
        stderr: { write: () => true },
      },
    );
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:58627');
  });
});

describe('`kimi server rotate-token`', () => {
  let dir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-rotate-'));
    prevHome = process.env['KIMI_CODE_HOME'];
    process.env['KIMI_CODE_HOME'] = dir;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env['KIMI_CODE_HOME'];
    } else {
      process.env['KIMI_CODE_HOME'] = prevHome;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a new token to server.token and prints it', async () => {
    const { registerServerCommand } = await import('#/cli/sub/server');
    const program = new Command('kimi').exitOverride();
    registerServerCommand(program);
    let stdout = '';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });

    await program.parseAsync(['node', 'kimi', 'server', 'rotate-token']);
    writeSpy.mockRestore();

    const token = readFileSync(join(dir, 'server.token'), 'utf8').trim();
    expect(token.length).toBeGreaterThan(20);
    expect(stdout).toContain('New server token');
    expect(stdout).toContain(token);
  });

  it('re-prints the access links with the new token when a server is running', async () => {
    const { registerServerCommand } = await import('#/cli/sub/server');
    const { mkdirSync, writeFileSync: writeSync } = await import('node:fs');
    // Fake a live lock pointing at this (alive) process so getLiveLock() finds
    // the running server and the command can re-print its links.
    mkdirSync(join(dir, 'server'), { recursive: true });
    writeSync(
      join(dir, 'server', 'lock'),
      JSON.stringify({
        pid: process.pid,
        started_at: new Date().toISOString(),
        port: 58627,
        host: '127.0.0.1',
      }),
    );

    const program = new Command('kimi').exitOverride();
    registerServerCommand(program);
    let stdout = '';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });

    await program.parseAsync(['node', 'kimi', 'server', 'rotate-token']);
    writeSpy.mockRestore();

    const token = readFileSync(join(dir, 'server.token'), 'utf8').trim();
    expect(stdout).toContain('New server token');
    expect(stdout).toContain(`http://127.0.0.1:58627/#token=${token}`);
    // Token line sits between the note and the links.
    expect(stdout.indexOf('picks up the new token')).toBeLessThan(
      stdout.indexOf('New server token'),
    );
    expect(stdout.indexOf('New server token')).toBeLessThan(
      stdout.indexOf(`http://127.0.0.1:58627/#token=${token}`),
    );
  });
});

describe('formatHostForUrl', () => {
  it('bracket-wraps IPv6 and leaves IPv4 as-is', async () => {
    const { formatHostForUrl } = await import('#/cli/sub/server/networks');
    expect(formatHostForUrl('192.168.1.5', 'IPv4')).toBe('192.168.1.5');
    expect(formatHostForUrl('fe80::1', 'IPv6')).toBe('[fe80::1]');
  });
});

describe('filterDisplayAddresses', () => {
  it('drops IPv6 link-local, de-duplicates, and orders IPv4 before IPv6', async () => {
    const { filterDisplayAddresses } = await import('#/cli/sub/server/networks');
    const out = filterDisplayAddresses([
      { address: 'fe80::ecf3:c2ff:fe9c:11c3', family: 'IPv6' },
      { address: '192.168.1.5', family: 'IPv4' },
      { address: 'fe80::ecf3:c2ff:fe9c:11c3', family: 'IPv6' },
      { address: '10.0.0.1', family: 'IPv4' },
      { address: 'fe80::1', family: 'IPv6' },
      { address: '2001:db8::1', family: 'IPv6' },
    ]);
    expect(out).toEqual([
      { address: '192.168.1.5', family: 'IPv4' },
      { address: '10.0.0.1', family: 'IPv4' },
      { address: '2001:db8::1', family: 'IPv6' },
    ]);
  });
});

// Silence vi import for cases where the file is built before tests reference vi.
void vi;
