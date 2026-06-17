/**
 * Tests for `kimi server run` and `kimi web` Commander wiring.
 *
 * These tests don't actually start the server — they verify the parsed shape
 * (option flags, --open default) and that the `web` alias defers to the same
 * underlying handler with `defaultOpen` flipped to true.
 *
 * Foreground startup behavior is exercised end-to-end in `server-e2e/`.
 */

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';

import chalk, { Chalk } from 'chalk';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerServerCommand } from '#/cli/sub/server';
import { addLifecycleCommands } from '#/cli/sub/server/lifecycle';
import { darkColors } from '#/tui/theme/colors';

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
  it('declares pino-pretty as a CLI runtime dependency', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf-8'),
    ) as { optionalDependencies?: Record<string, string> };

    expect(packageJson.optionalDependencies).toHaveProperty('pino-pretty');
  });

  it('registers `server` with only `run` while lifecycle commands are hidden', () => {
    const program = makeProgram();
    const server = program.commands.find((c) => c.name() === 'server');
    expect(server).toBeDefined();
    const subs = server?.commands.map((c) => c.name()).toSorted();
    expect(subs).toEqual(['run']);
  });

  it('`server run` exposes local-only foreground options', () => {
    const program = makeProgram();
    const run = program.commands
      .find((c) => c.name() === 'server')
      ?.commands.find((c) => c.name() === 'run');
    expect(run).toBeDefined();
    const longs = run!.options.map((o) => o.long).filter(Boolean);
    expect(longs).not.toContain('--host');
    expect(longs).toContain('--port');
    expect(longs).toContain('--log-level');
    expect(longs).toContain('--debug-endpoints');
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
    expect(longs).not.toContain('--host');
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
      mgr.install({ host: '127.0.0.1', port: 7878, logLevel: 'info' }),
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
          port: 7878,
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

    expect(stdout).toContain('URL: http://127.0.0.1:7878');
    expect(stdout).toContain('Status: not running');
    expect(stdout).toContain('launchd state: spawn scheduled');
    expect(stdout).toContain('last exit code: 78 EX_CONFIG');
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe('`kimi server run` already-running handling', () => {
  it('defaults foreground logs off', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let parsed: unknown;

    await handleRunCommand(
      { port: '7878' },
      {
        startServerForeground: async (options) => {
          parsed = options;
          return { origin: 'http://127.0.0.1:7878' };
        },
        getServiceStatus: async () => undefined,
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

  it('enables foreground logs only when --log-level is provided', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let parsed: unknown;

    await handleRunCommand(
      { port: '7878', logLevel: 'debug' },
      {
        startServerForeground: async (options) => {
          parsed = options;
          return { origin: 'http://127.0.0.1:7878' };
        },
        getServiceStatus: async () => undefined,
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

  it('prints a TUI-style welcome panel when foreground logs are off', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let stdout = '';

    await handleRunCommand(
      { port: '7878' },
      {
        startServerForeground: async () => ({ origin: 'http://127.0.0.1:7878' }),
        getServiceStatus: async () => undefined,
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
    expect(plain).toContain('╭');
    expect(plain).toContain('╰');
    expect(plain).toContain('▐█▛█▛█▌');
    expect(plain).toContain('▐█████▌');
    expect(plain).toContain('Kimi server ready');
    expect(plain).toContain('URL:');
    expect(plain).toContain('http://127.0.0.1:7878/');
    expect(plain).toContain('Network:');
    expect(plain).toContain('local only');
    expect(plain).toContain('Logs:');
    expect(plain).toContain('off');
    expect(plain).toContain('Stop:');
    expect(plain).toContain('Ctrl+C');
    expect(plain).not.toContain('➜');
    expect(plain).not.toContain('Kimi server:');
  });

  it('uses the TUI dark palette for the foreground ready banner', async () => {
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let stdout = '';
    const previousChalkLevel = chalk.level;
    chalk.level = 3;

    try {
      await handleRunCommand(
        { port: '7878' },
        {
          startServerForeground: async () => ({ origin: 'http://127.0.0.1:7878' }),
          getServiceStatus: async () => undefined,
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
    expect(stdout).toContain(color.hex(darkColors.accent)('http://127.0.0.1:7878/'));
    expect(stdout).toContain(color.bold.hex(darkColors.textDim)('URL:      '));
    expect(stdout).toContain(color.hex(darkColors.textMuted)('local only'));
  });

  it('reports a background service conflict, suggests server stop, and opens the existing URL', async () => {
    const { ServerLockedError } = await import('@moonshot-ai/server');
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let stdout = '';
    const openUrl = vi.fn();

    await handleRunCommand(
      { port: '7878' },
      {
        startServerForeground: async () => {
          throw new ServerLockedError('locked', {
            pid: 1234,
            started_at: '2026-06-11T00:00:00.000Z',
            host: '127.0.0.1',
            port: 9999,
          });
        },
        getServiceStatus: async () => ({
          platform: 'darwin',
          installed: true,
          running: true,
          pid: 1234,
          host: '127.0.0.1',
          port: 9999,
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
      },
    );

    expect(stdout).toContain('already running in background');
    expect(stdout).toContain('URL: http://127.0.0.1:9999');
    expect(stdout).toContain('Stop: kimi server stop');
    expect(stdout).not.toContain('pkill');
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:9999');
  });

  it('reports a foreground process conflict, suggests a pid-based stop command, and opens the existing URL', async () => {
    const { ServerLockedError } = await import('@moonshot-ai/server');
    const { handleRunCommand } = await import('#/cli/sub/server/run');
    let stdout = '';
    const openUrl = vi.fn();

    await handleRunCommand(
      { port: '7878' },
      {
        startServerForeground: async () => {
          throw new ServerLockedError('locked', {
            pid: 5678,
            started_at: '2026-06-11T00:00:00.000Z',
            port: 10001,
          });
        },
        getServiceStatus: async () => ({
          platform: 'darwin',
          installed: false,
          running: false,
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
      },
    );

    expect(stdout).toContain('already running in foreground');
    expect(stdout).toContain('URL: http://127.0.0.1:10001');
    expect(stdout).toContain('Stop: kill -TERM 5678');
    expect(stdout).not.toContain('kimi server stop');
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:10001');
  });

  it('formats foreground stop commands by platform and pid', async () => {
    const { formatForegroundStopCommand } = await import('#/cli/sub/server/run');

    expect(formatForegroundStopCommand(1234, 'darwin')).toBe('kill -TERM 1234');
    expect(formatForegroundStopCommand(1234, 'linux')).toBe('kill -TERM 1234');
    expect(formatForegroundStopCommand(1234, 'win32')).toBe('taskkill /PID 1234 /T /F');
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
    expect(() => parsePort('99999', '--port', 7878)).toThrow(/invalid --port/);
    expect(() => parsePort('-1', '--port', 7878)).toThrow(/invalid --port/);
    expect(parsePort(undefined, '--port', 7878)).toBe(7878);
    expect(parsePort('8080', '--port', 7878)).toBe(8080);
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
    server.listen({ host, port }, () => resolve(server));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function allocateFreePort(host = '127.0.0.1'): Promise<number> {
  const server = await listenOnce(host, 0);
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await closeServer(server);
  return port;
}

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

describe('kimi web (handleWebCommand)', () => {
  it('ensures the daemon, prints the origin, and opens the browser by default', async () => {
    const { handleWebCommand } = await import('#/cli/sub/server/web-alias');
    const ensureDaemon = vi.fn(async () => ({ origin: 'http://127.0.0.1:7878' }));
    const openUrl = vi.fn();
    let stdout = '';

    await handleWebCommand(
      {},
      {
        ensureDaemon,
        openUrl,
        stdout: {
          write(chunk: string | Uint8Array) {
            stdout += String(chunk);
            return true;
          },
        },
      },
    );

    expect(ensureDaemon).toHaveBeenCalledWith({ port: 7878, logLevel: undefined });
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:7878');
    expect(stdout).toContain('http://127.0.0.1:7878');
  });

  it('does not open the browser when --no-open is set', async () => {
    const { handleWebCommand } = await import('#/cli/sub/server/web-alias');
    const openUrl = vi.fn();
    await handleWebCommand(
      { open: false },
      {
        ensureDaemon: vi.fn(async () => ({ origin: 'http://127.0.0.1:9000' })),
        openUrl,
        stdout: { write: () => true },
      },
    );
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('rejects an invalid --log-level before touching the daemon', async () => {
    const { handleWebCommand } = await import('#/cli/sub/server/web-alias');
    const ensureDaemon = vi.fn();
    await expect(
      handleWebCommand(
        { logLevel: 'shout' },
        { ensureDaemon, openUrl: vi.fn(), stdout: { write: () => true } },
      ),
    ).rejects.toThrow(/invalid --log-level/);
    expect(ensureDaemon).not.toHaveBeenCalled();
  });
});

// Silence vi import for cases where the file is built before tests reference vi.
void vi;
