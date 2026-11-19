import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { lstatSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

import chalk, { Chalk } from 'chalk';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetCapabilitiesCache, setCapabilities } from '@moonshot-ai/pi-tui';

import { DEVICE_API_LEVEL, DEVICE_PROTOCOL_VERSION, SERVER_UPGRADED_CLOSE_CODE } from '@moonshot-ai/kap-server';

import { registerWebCommand } from '#/cli/sub/web';
import {
  attachDaemon,
  DaemonBusyError,
  daemonSocketPath,
  daemonUpgradeLogPath,
  defaultEnsureDaemonDeps,
  ensureDaemon,
  kimiArgv,
  runKimiCommand,
  runLoggedCommand,
  type DaemonConnection,
  type DaemonExit,
  type DaemonLease,
  type EnsureDaemonDeps,
} from '#/cli/sub/web/ensure-daemon';
import { getVersion } from '#/cli/version';
import { KIMI_CODE_RC_UPGRADED_FROM_ENV } from '#/constant/app';
import type { LegacyKillDeps } from '#/cli/sub/web/legacy-kill';
import type {
  RemoteControlCloseReason,
  RemoteControlOptions,
  RemoteControlServer,
} from '#/cli/sub/web/remote-control';
import type { WebCommandDeps } from '#/cli/sub/web/run';
import type { ParsedServerOptions } from '#/cli/sub/web/shared';
import { darkColors } from '#/tui/theme/colors';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

function stripAnsi(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

function makeProgram(): Command {
  const program = new Command('kimi').exitOverride();
  registerWebCommand(program);
  return program;
}

type ForegroundRunner = NonNullable<WebCommandDeps['startServerForeground']>;

function makeRunner(origin = 'http://127.0.0.1:58627'): {
  runner: ForegroundRunner;
  calls: { options: ParsedServerOptions | undefined };
} {
  const calls: { options: ParsedServerOptions | undefined } = { options: undefined };
  const runner: ForegroundRunner = async (options, hooks) => {
    calls.options = options;
    await hooks?.onReady?.(origin);
    return undefined as never;
  };
  return { runner, calls };
}

function makeIo(): {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
  readStdout(): string;
} {
  let out = '';
  return {
    stdout: {
      write(chunk: string | Uint8Array) {
        out += String(chunk);
        return true;
      },
    },
    stderr: {
      write() {
        return true;
      },
    },
    readStdout: () => out,
  };
}

describe('kimi web', () => {
  it('registers the `web` command with only the rotate-token subcommand', () => {
    const program = makeProgram();
    const web = program.commands.find((c) => c.name() === 'web');
    expect(web).toBeDefined();
    const subs = web?.commands.map((c) => c.name());
    expect(subs).toEqual(['rotate-token']);
  });

  it('reports the device protocol from `kimi server ensure-daemon --probe` without starting a server', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await makeProgram().parseAsync(['node', 'kimi', 'server', 'ensure-daemon', '--probe']);
      const line = String(write.mock.calls.at(-1)?.[0]);
      expect(line.startsWith('__KIMI_ENSURE_DAEMON__')).toBe(true);
      const payload = JSON.parse(line.slice('__KIMI_ENSURE_DAEMON__'.length)) as Record<string, unknown>;
      expect(payload).toEqual({ protocol: DEVICE_PROTOCOL_VERSION, api_level: DEVICE_API_LEVEL, version: expect.any(String) });
    } finally {
      write.mockRestore();
    }
  });

  it('exposes the foreground server options on `web` itself', () => {
    const program = makeProgram();
    const web = program.commands.find((c) => c.name() === 'web');
    expect(web).toBeDefined();
    const longs = web!.options.map((o) => o.long).filter(Boolean);
    expect(longs).toContain('--port');
    expect(longs).toContain('--host');
    expect(longs).toContain('--allowed-host');
    expect(longs).toContain('--insecure-no-tls');
    expect(longs).toContain('--allow-remote-shutdown');
    expect(longs).toContain('--dangerous-bypass-auth');
    expect(longs).toContain('--log-level');
    expect(longs).toContain('--debug-endpoints');
    expect(longs).toContain('--web-title');
    const remoteControl = web!.options.find((option) => option.long === '--remote-control');
    expect(remoteControl?.short).toBe('--rc');
    expect(longs).toContain('--no-open');
    expect(longs).not.toContain('--foreground');
    expect(longs).not.toContain('--keep-alive');
    expect(longs).not.toContain('--daemon');
    expect(longs).not.toContain('--idle-grace-ms');
    expect(longs).not.toContain('--allow-remote-terminals');
  });

  it('runs a hidden `kimi server` with the same options as `kimi web` but `open: false` by default', async () => {
    const program = makeProgram();
    expect(program.helpInformation()).not.toMatch(/^\s+server\s/m);
    const server = program.commands.find((c) => c.name() === 'server');
    expect(server).toBeDefined();
    expect(server?.commands.map((c) => c.name()).toSorted()).toEqual([
      'ensure-daemon',
      'kill',
      'rotate-token',
    ]);
    let parsedOpts: Record<string, unknown> | undefined;
    server!.action((opts: Record<string, unknown>) => {
      parsedOpts = opts;
    });
    await program.parseAsync(['node', 'kimi', 'server', '--port', '59000']);
    expect(parsedOpts).toMatchObject({ port: '59000', open: false });

    await program.parseAsync(['node', 'kimi', 'server', '--open']);
    expect(parsedOpts).toMatchObject({ open: true });
  });
});

describe('`kimi web` ready banner', () => {
  it('prints the TUI-style ready panel once listening', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://127.0.0.1:58628');
    const { stdout, stderr, readStdout } = makeIo();

    await handleWebCommand(
      { port: '58627', open: false },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok',
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );

    const plain = stripAnsi(readStdout());
    expect(plain).toContain('Kimi server ready');
    expect(plain).toContain('Local:');
    expect(plain).toContain('http://127.0.0.1:58628/#token=tok');
    expect(plain).toContain('Token:');
    expect(plain).toContain('Network:');
    expect(plain).toContain('use --host to enable');
    expect(plain).toContain('Logs:');
    expect(plain).toContain('off');
    expect(plain).toContain('Stop:');
    expect(plain).toContain('Ctrl+C');
    expect(plain).not.toContain('╭');
    expect(plain).not.toContain('╰');
    expect(plain).toContain('▐█▛█▛█▌');
    expect(plain).toContain('▐█████▌');
    expect(plain).not.toContain('Kimi server:');

    expect(plain.indexOf('Kimi server ready')).toBeLessThan(plain.indexOf('Local:'));
    expect(plain.indexOf('Logs:')).toBeLessThan(plain.indexOf('Stop:'));
  });

  it('uses the TUI dark palette for the ready banner', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr, readStdout } = makeIo();
    const previousChalkLevel = chalk.level;
    chalk.level = 3;

    try {
      await handleWebCommand(
        { port: '58627', host: '127.0.0.1', open: false },
        { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
      );
    } finally {
      chalk.level = previousChalkLevel;
    }

    const out = readStdout();
    const color = new Chalk({ level: 3 });
    expect(out).toContain(color.hex(darkColors.primary)('▐█▛█▛█▌'));
    expect(out).toContain(color.bold.hex(darkColors.primary)('Kimi server ready'));
    expect(out).toContain(color.hex(darkColors.accent)('http://127.0.0.1:58627/'));
    expect(out).toContain(color.bold.hex(darkColors.textDim)('Local:    '));
    expect(out).toContain(color.hex(darkColors.textMuted)('off'));
  });

  it('renders the bypass danger notice in the error color', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr, readStdout } = makeIo();
    const previousChalkLevel = chalk.level;
    chalk.level = 3;

    try {
      await handleWebCommand(
        { port: '58627', dangerousBypassAuth: true, open: false },
        { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
      );
    } finally {
      chalk.level = previousChalkLevel;
    }

    const color = new Chalk({ level: 3 });
    expect(readStdout()).toContain(
      color.bold.hex(darkColors.error)(
        '⚠ DANGER: authentication is DISABLED (--dangerous-bypass-auth).',
      ),
    );
  });

  it('prints the danger notice and suppresses the token when auth is bypassed', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr, readStdout } = makeIo();
    const openUrl = vi.fn();

    await handleWebCommand(
      { port: '58627', host: '127.0.0.1', dangerousBypassAuth: true, open: true },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok',
        openUrl,
        stdout,
        stderr,
      },
    );

    const plain = stripAnsi(readStdout());
    expect(plain).toContain('DANGER: authentication is DISABLED');
    expect(plain).toContain('--dangerous-bypass-auth');
    expect(plain).toContain('Ctrl+C');
    expect(plain).not.toContain('tok');
    expect(plain).not.toContain('#token=');
    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:58627');
  });
});

describe('ready banner reflects the bind class', () => {
  it('lists Local + Network addresses for a 0.0.0.0 bind (Vite-style)', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://0.0.0.0:58627');
    const { stdout, stderr, readStdout } = makeIo();

    await handleWebCommand(
      { host: '0.0.0.0', open: false },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok-xyz',
        networkAddresses: [
          { address: '192.0.2.66', family: 'IPv4' },
          { address: '198.51.100.216', family: 'IPv4' },
        ],
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );

    const raw = stripAnsi(readStdout());
    expect(raw).toContain('Kimi server ready');
    expect(raw).toContain('Local:');
    expect(raw).toContain('Network:');
    expect(raw).toContain('http://localhost:58627/#token=tok-xyz');
    expect(raw).toContain('http://192.0.2.66:58627/#token=tok-xyz');
    expect(raw).toContain('http://198.51.100.216:58627/#token=tok-xyz');
    expect(raw).toContain('Token:');
    expect(raw).toContain('tok-xyz');
    expect(raw).not.toContain('╭');
  });

  it('lists only the Local URL for a 127.0.0.1 bind', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://127.0.0.1:58627');
    const { stdout, stderr, readStdout } = makeIo();

    await handleWebCommand(
      { host: '127.0.0.1', open: false },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok-loop',
        networkAddresses: [{ address: '192.0.2.66', family: 'IPv4' }],
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );

    const raw = stripAnsi(readStdout());
    expect(raw).toContain('Kimi server ready');
    expect(raw).toContain('Local:');
    expect(raw).toContain('http://127.0.0.1:58627/#token=tok-loop');
    expect(raw).toContain('Token:');
    expect(raw).toContain('tok-loop');
    expect(raw).toContain('use --host to enable');
    expect(raw).not.toContain('Network:  http');
    expect(raw).not.toContain('192.0.2.66');
    expect(raw).not.toContain('╭');
  });
});

describe('`kimi web` opens the browser', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetCapabilitiesCache();
  });

  it('opens the Web UI URL with the #token= fragment by default', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr } = makeIo();
    const openUrl = vi.fn();

    await handleWebCommand(
      { port: '58627', open: true },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok-xyz',
        openUrl,
        stdout,
        stderr,
      },
    );

    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:58627/#token=tok-xyz');
  });

  it('opens the plain origin when no token is resolvable', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr } = makeIo();
    const openUrl = vi.fn();

    await handleWebCommand(
      { port: '58627', open: true },
      {
        startServerForeground: runner,
        resolveToken: () => undefined,
        openUrl,
        stdout,
        stderr,
      },
    );

    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:58627');
  });

  it('opens localhost rather than the wildcard bind address', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://0.0.0.0:58627');
    const { stdout, stderr } = makeIo();
    const openUrl = vi.fn();

    await handleWebCommand(
      { host: '0.0.0.0', open: true },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok-xyz',
        openUrl,
        stdout,
        stderr,
      },
    );

    expect(openUrl).toHaveBeenCalledWith('http://localhost:58627/#token=tok-xyz');
  });

  it('opens localhost for a wildcard IPv6 bind', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://:::58627');
    const { stdout, stderr } = makeIo();
    const openUrl = vi.fn();

    await handleWebCommand(
      { host: '::', open: true },
      {
        startServerForeground: runner,
        resolveToken: () => undefined,
        openUrl,
        stdout,
        stderr,
      },
    );

    expect(openUrl).toHaveBeenCalledWith('http://localhost:58627');
  });

  it('does not open the browser when open is false', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner('http://127.0.0.1:9000');
    const { stdout, stderr } = makeIo();
    const openUrl = vi.fn();

    await handleWebCommand(
      { port: '58627', open: false },
      { startServerForeground: runner, openUrl, stdout, stderr },
    );

    expect(openUrl).not.toHaveBeenCalled();
  });

  it('maps --remote-control and --rc to the same option', () => {
    for (const flag of ['--remote-control', '--rc']) {
      const program = makeProgram();
      const web = program.commands.find((command) => command.name() === 'web')!;
      web.parseOptions([flag]);
      expect(web.opts()).toMatchObject({ remoteControl: true });
    }
  });

  it('shows --remote-control in help', () => {
    const remoteControlOption = makeProgram()
      .commands.find((command) => command.name() === 'web')!
      .options.find((option) => option.long === '--remote-control');
    expect(remoteControlOption?.hidden).toBeFalsy();
  });
});

describe('kimi rc', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('registers `rc` with the `remote` alias and the web server options, without a --remote-control flag', () => {
    const program = makeProgram();
    const rc = program.commands.find((c) => c.name() === 'rc');
    expect(rc).toBeDefined();
    expect(rc!.alias()).toBe('remote');
    const longs = rc!.options.map((o) => o.long).filter(Boolean);
    expect(longs).toContain('--port');
    expect(longs).toContain('--host');
    expect(longs).toContain('--no-open');
    expect(longs).not.toContain('--remote-control');
  });

  it('shows `rc` in help', () => {
    expect(makeProgram().helpInformation()).toContain('rc|remote');
  });

  it('forces Remote Control for both `rc` and `remote`', async () => {
    for (const name of ['rc', 'remote']) {
      const program = makeProgram();
      let stderr = '';
      const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
        stderr += String(chunk);
        return true;
      });
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);
      try {
        await program.parseAsync(['node', 'kimi', name, '--dangerous-bypass-auth']);
        expect(exitSpy).toHaveBeenCalledWith(1);
      } finally {
        errSpy.mockRestore();
        exitSpy.mockRestore();
      }
      expect(stderr).toContain('--remote-control cannot be combined with --dangerous-bypass-auth.');
    }
  });
});

describe('Remote Control server modes', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kimi-web-rc-'));
    vi.stubEnv('KIMI_CODE_HOME', home);
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function makeRemoteControl(): {
    deps: WebCommandDeps;
    lease: DaemonLease & { close: ReturnType<typeof vi.fn> };
    ownServer: RemoteControlServer & { close: ReturnType<typeof vi.fn> };
    startRemoteControlServer: ReturnType<typeof vi.fn>;
    startServerForeground: ReturnType<typeof vi.fn>;
    startRemoteControl: ReturnType<typeof vi.fn>;
    tunnelClose: ReturnType<typeof vi.fn>;
    terminate(): void;
    serverExits(exit: DaemonExit): void;
    readStdout(): string;
  } {
    const { stdout, stderr, readStdout } = makeIo();
    let markClosed!: (exit: DaemonExit) => void;
    const lease = {
      closed: new Promise<DaemonExit>((resolve) => {
        markClosed = resolve;
      }),
      close: vi.fn(() => markClosed('stopped')),
    };
    let endTunnel!: (reason: RemoteControlCloseReason) => void;
    const tunnelClose = vi.fn(async () => endTunnel('local_close'));
    const startRemoteControl = vi.fn(async (_options: RemoteControlOptions) => ({
      deviceId: 'device-1',
      deviceName: 'example-device',
      url: 'https://example.test/devices/device-1/?rc=1&from=kimi_code_cli',
      relayOrigin: 'https://example.test',
      closed: new Promise<RemoteControlCloseReason>((resolve) => {
        endTunnel = resolve;
      }),
      close: tunnelClose,
    }));
    let terminate: (() => void) | undefined;
    const startServerForeground = vi.fn(async () => undefined as never);
    const ownServer = {
      localOrigin: 'http://127.0.0.1:58627',
      localServerToken: () => 'local-token',
      localUrl: 'http://127.0.0.1:58627/#token=local-token',
      background: false,
      closed: new Promise<never>(() => {}),
      close: vi.fn(async () => {}),
    };
    const startRemoteControlServer = vi.fn(async (_options: ParsedServerOptions) => ownServer);
    return {
      deps: {
        startServerForeground,
        startRemoteControlServer,
        attachDaemon: async () => ({
          socketPath: daemonSocketPath(home),
          logPath: join(home, 'server', 'ensure-daemon.log'),
          lease,
        }),
        platform: 'linux',
        startRemoteControl,
        onTerminate: (listener) => {
          terminate = listener;
          return () => {};
        },
        wait: async () => {},
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
      lease,
      ownServer,
      startRemoteControlServer,
      startServerForeground,
      startRemoteControl,
      tunnelClose,
      terminate: () => terminate?.(),
      serverExits: (exit) => markClosed(exit),
      readStdout: () => stripAnsi(readStdout()),
    };
  }

  it('runs `kimi rc` on its own server by default, with the local UI and its flags, and stops it on Ctrl+C', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const rc = makeRemoteControl();
    const attachDaemon = vi.fn(rc.deps.attachDaemon!);

    const running = handleWebCommand({ remoteControl: true, port: '59000', open: false }, { ...rc.deps, attachDaemon });
    await vi.waitFor(() => expect(rc.startRemoteControl).toHaveBeenCalledOnce());
    expect(attachDaemon).not.toHaveBeenCalled();
    expect(rc.startRemoteControlServer).toHaveBeenCalledWith(expect.objectContaining({ port: 59000 }));
    const options = rc.startRemoteControl.mock.calls[0]![0] as RemoteControlOptions;
    expect(options.localOrigin).toBe('http://127.0.0.1:58627');
    expect(rc.readStdout()).toContain('Local UI: http://127.0.0.1:58627/#token=local-token');
    expect(rc.readStdout()).not.toContain('Ignoring');

    rc.terminate();
    await expect(running).resolves.toBeUndefined();
    expect(rc.tunnelClose).toHaveBeenCalledOnce();
    expect(rc.ownServer.close).toHaveBeenCalledOnce();
    expect(rc.readStdout()).not.toContain('sessions keep running');
  });

  it('runs `kimi rc --background` through the daemon socket without a foreground server and leaves the daemon on Ctrl+C', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const rc = makeRemoteControl();

    const running = handleWebCommand({ remoteControl: true, background: true, open: true }, rc.deps);
    await vi.waitFor(() => expect(rc.deps.openUrl).toHaveBeenCalledOnce());
    expect(rc.startServerForeground).not.toHaveBeenCalled();
    expect(rc.startRemoteControl).toHaveBeenCalledOnce();
    const options = rc.startRemoteControl.mock.calls[0]![0] as RemoteControlOptions;
    expect(options.localOrigin).toBe(`unix:${daemonSocketPath(home)}`);
    expect(options.localServerToken).toBeUndefined();
    expect(rc.deps.openUrl).toHaveBeenCalledWith(
      'https://example.test/devices/device-1/?rc=1&from=kimi_code_cli',
    );
    expect(rc.readStdout()).not.toContain('Local UI');
    expect(rc.readStdout()).not.toContain('Ignoring');

    rc.terminate();
    await expect(running).resolves.toBeUndefined();
    expect(rc.tunnelClose).toHaveBeenCalledOnce();
    expect(rc.lease.close).toHaveBeenCalledOnce();
    expect(rc.readStdout()).toContain('sessions keep running in the background Kimi server');
    expect(rc.startRemoteControlServer).not.toHaveBeenCalled();
  });

  it('prints one notice for flags that only configure a foreground server', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const rc = makeRemoteControl();

    const running = handleWebCommand(
      { remoteControl: true, background: true, port: '59000', host: '0.0.0.0', open: false },
      rc.deps,
    );
    await vi.waitFor(() => expect(rc.startRemoteControl).toHaveBeenCalledOnce());
    rc.terminate();
    await running;

    const notices = rc.readStdout().match(/^.*Ignoring.*\n/gm);
    expect(notices).toEqual([
      '  ! Ignoring --port, --host: Remote Control runs on the background Kimi server.\n',
    ]);
    expect(rc.startServerForeground).not.toHaveBeenCalled();
  });

  it('retries while a busy daemon of another version finishes its work', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const rc = makeRemoteControl();
    let attempts = 0;
    const wait = vi.fn(async () => {});
    const attachDaemon = rc.deps.attachDaemon!;
    const running = handleWebCommand(
      { remoteControl: true, background: true, open: false },
      {
        ...rc.deps,
        wait,
        attachDaemon: async () => {
          attempts += 1;
          if (attempts === 1) throw new DaemonBusyError('0.9.0');
          return attachDaemon();
        },
      },
    );
    await vi.waitFor(() => expect(rc.startRemoteControl).toHaveBeenCalledOnce());
    expect(attempts).toBe(2);
    expect(wait).toHaveBeenCalledOnce();
    expect(rc.readStdout()).toContain('Kimi server 0.9.0 is still running work on this device');

    rc.terminate();
    await running;
  });

  it('keeps the loopback check when Remote Control runs on its own server', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const rc = makeRemoteControl();
    const attachDaemon = vi.fn(rc.deps.attachDaemon!);

    await expect(
      handleWebCommand({ remoteControl: true, host: '0.0.0.0', port: '59000' }, { ...rc.deps, attachDaemon }),
    ).rejects.toThrow('--remote-control requires a loopback host.');
    expect(rc.readStdout()).not.toContain('Ignoring');
    expect(attachDaemon).not.toHaveBeenCalled();
    expect(rc.startRemoteControlServer).not.toHaveBeenCalled();
    expect(rc.startRemoteControl).not.toHaveBeenCalled();
  });

  it('rejects --background on Windows and without Remote Control', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const rc = makeRemoteControl();
    const attachDaemon = vi.fn(rc.deps.attachDaemon!);

    await expect(
      handleWebCommand({ remoteControl: true, background: true }, { ...rc.deps, attachDaemon, platform: 'win32' }),
    ).rejects.toThrow('--background is only available on macOS and Linux.');
    await expect(handleWebCommand({ background: true }, rc.deps)).rejects.toThrow(
      '--background requires --remote-control.',
    );
    expect(attachDaemon).not.toHaveBeenCalled();
    expect(rc.startServerForeground).not.toHaveBeenCalled();
    expect(rc.startRemoteControl).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('replaces itself with the upgraded kimi and the same flags when the background server restarts for an upgrade', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const rc = makeRemoteControl();
    const execve = vi.spyOn(process, 'execve').mockImplementation(() => undefined as never);
    try {
      const running = handleWebCommand({ remoteControl: true, background: true, open: false }, rc.deps);
      await vi.waitFor(() => expect(rc.startRemoteControl).toHaveBeenCalledOnce());
      rc.serverExits('upgraded');
      await expect(running).resolves.toBeUndefined();

      const argv = [...kimiArgv(), ...process.argv.slice(2)];
      expect(execve).toHaveBeenCalledOnce();
      expect(execve).toHaveBeenCalledWith(
        argv[0],
        argv,
        expect.objectContaining({ [KIMI_CODE_RC_UPGRADED_FROM_ENV]: getVersion() }),
      );
      expect(rc.tunnelClose.mock.invocationCallOrder[0]).toBeLessThan(execve.mock.invocationCallOrder[0]!);
      expect(rc.lease.close.mock.invocationCallOrder[0]).toBeLessThan(execve.mock.invocationCallOrder[0]!);
      expect(rc.readStdout()).toContain('restarting Remote Control');
    } finally {
      execve.mockRestore();
    }
  });

  it('refuses to attach when a relaunch after an upgrade still runs the old kimi', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const rc = makeRemoteControl();
    const attachDaemon = vi.fn(rc.deps.attachDaemon!);
    vi.stubEnv(KIMI_CODE_RC_UPGRADED_FROM_ENV, getVersion());

    await expect(
      handleWebCommand({ remoteControl: true, background: true, open: false }, { ...rc.deps, attachDaemon }),
    ).rejects.toThrow(`Remote Control restarted after an upgrade but still runs Kimi Code ${getVersion()}`);
    expect(attachDaemon).not.toHaveBeenCalled();
    expect(rc.startRemoteControl).not.toHaveBeenCalled();
    expect(process.env[KIMI_CODE_RC_UPGRADED_FROM_ENV]).toBeUndefined();
  });

  it('comes back online on the upgraded kimi without opening the browser again', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const rc = makeRemoteControl();
    vi.stubEnv(KIMI_CODE_RC_UPGRADED_FROM_ENV, '0.0.1');

    const running = handleWebCommand({ remoteControl: true, background: true, open: true }, rc.deps);
    await vi.waitFor(() => expect(rc.startRemoteControl).toHaveBeenCalledOnce());
    expect(process.env[KIMI_CODE_RC_UPGRADED_FROM_ENV]).toBeUndefined();
    expect(rc.readStdout()).toContain(`Kimi Code upgraded from 0.0.1 to ${getVersion()}`);

    rc.terminate();
    await running;
    expect(rc.deps.openUrl).not.toHaveBeenCalled();
  });

  it('rejects Remote Control combined with --socket or --dangerous-bypass-auth', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const rc = makeRemoteControl();

    await expect(
      handleWebCommand({ remoteControl: true, socket: '/tmp/daemon.sock' }, rc.deps),
    ).rejects.toThrow('--remote-control cannot be combined with --socket.');
    await expect(
      handleWebCommand({ remoteControl: true, dangerousBypassAuth: true }, rc.deps),
    ).rejects.toThrow('--remote-control cannot be combined with --dangerous-bypass-auth.');
    expect(rc.startRemoteControl).not.toHaveBeenCalled();
    expect(rc.startServerForeground).not.toHaveBeenCalled();
  });
});

describe('`kimi web` option threading', () => {
  it('threads the CLI flags into the foreground runner options', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      {
        port: '59000',
        host: '0.0.0.0',
        insecureNoTls: true,
        allowedHost: ['.example.com'],
        dangerousBypassAuth: true,
        debugEndpoints: true,
        allowRemoteShutdown: true,
        open: false,
      },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options).toEqual({
      host: '0.0.0.0',
      port: 59000,
      logLevel: 'silent',
      debugEndpoints: true,
      insecureNoTls: true,
      allowRemoteShutdown: true,
      dangerousBypassAuth: true,
      allowedHosts: ['.example.com'],
    });
  });

  it('defaults the host to 127.0.0.1 and insecureNoTls to true', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      { port: '58627', open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options).toMatchObject({
      host: '127.0.0.1',
      insecureNoTls: true,
      logLevel: 'silent',
    });
  });

  it('maps a bare --host to the default LAN host', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      { port: '58627', host: true, open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options).toMatchObject({ host: '0.0.0.0', insecureNoTls: true });
  });

  it('passes --log-level through to the runner', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      { port: '58627', logLevel: 'debug', open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options).toMatchObject({ logLevel: 'debug' });
  });

  it('passes --web-title through to the runner', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      { port: '58627', webTitle: 'My Dev Box', open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options).toMatchObject({ webTitle: 'My Dev Box' });
  });

  it('leaves webTitle undefined when --web-title is not passed', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner();
    const { stdout, stderr } = makeIo();

    await handleWebCommand(
      { port: '58627', open: false },
      { startServerForeground: runner, openUrl: vi.fn(), stdout, stderr },
    );

    expect(calls.options?.webTitle).toBeUndefined();
  });

  it('rejects an invalid --log-level before calling the runner', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const startServerForeground = vi.fn(async () => undefined as never);
    const { stdout, stderr } = makeIo();

    await expect(
      handleWebCommand(
        { logLevel: 'shout', open: false },
        { startServerForeground, openUrl: vi.fn(), stdout, stderr },
      ),
    ).rejects.toThrow(/invalid --log-level/);
    expect(startServerForeground).not.toHaveBeenCalled();
  });

  it('prints the one-line ready line instead of the full banner with a non-default --log-level', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const { runner } = makeRunner();
    const { stdout, stderr, readStdout } = makeIo();

    await handleWebCommand(
      { port: '58627', logLevel: 'info', open: false },
      {
        startServerForeground: runner,
        resolveToken: () => 'tok',
        openUrl: vi.fn(),
        stdout,
        stderr,
      },
    );

    const plain = stripAnsi(readStdout());
    expect(plain).toContain('Kimi server: http://127.0.0.1:58627/#token=tok');
    expect(plain).not.toContain('Kimi server ready');
    expect(plain).not.toContain('Local:');
  });

  it('parses comma-separated --allowed-host values', async () => {
    const { parseAllowedHostArgs } = await import('#/cli/sub/web/shared');
    expect(parseAllowedHostArgs(['.example.com, app.example.com'])).toEqual([
      '.example.com',
      'app.example.com',
    ]);
  });
});

describe('shared parsers stay strict', () => {
  it('rejects out-of-range --port', async () => {
    const { parsePort } = await import('#/cli/sub/web/shared');
    expect(() => parsePort('99999', '--port', 58627)).toThrow(/invalid --port/);
    expect(() => parsePort('-1', '--port', 58627)).toThrow(/invalid --port/);
    expect(parsePort(undefined, '--port', 58627)).toBe(58627);
    expect(parsePort('8080', '--port', 58627)).toBe(8080);
  });

  it('rejects unknown --log-level values', async () => {
    const { parseLogLevel } = await import('#/cli/sub/web/shared');
    expect(() => parseLogLevel('shout')).toThrow(/invalid --log-level/);
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('debug')).toBe('debug');
  });
});

describe('server web asset directory resolution', () => {
  it('uses extracted SEA web assets when available', async () => {
    const { resolveServerWebAssetsDir } = await import('#/cli/sub/web/run');
    expect(resolveServerWebAssetsDir('/cache/kimi/dist-web')).toBe('/cache/kimi/dist-web');
  });

  it('falls back to package dist-web outside SEA mode', async () => {
    const { resolveServerWebAssetsDir } = await import('#/cli/sub/web/run');
    expect(resolveServerWebAssetsDir(null)).toMatch(/[/\\]dist-web$/);
  });

  it('returns the assets dir when it is built, dev mode or not', async () => {
    const { serverWebAssetsDir } = await import('#/cli/sub/web/run');
    const dir = mkdtempSync(join(tmpdir(), 'kimi-web-assets-'));
    try {
      writeFileSync(join(dir, 'index.html'), '<html></html>');
      expect(serverWebAssetsDir({}, dir)).toBe(dir);
      expect(serverWebAssetsDir({ KIMI_CODE_DEV_SERVER: '1' }, dir)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires built assets outside dev mode', async () => {
    const { serverWebAssetsDir } = await import('#/cli/sub/web/run');
    const dir = mkdtempSync(join(tmpdir(), 'kimi-web-assets-'));
    try {
      expect(serverWebAssetsDir({}, dir)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tolerates missing assets in dev mode (API-only server)', async () => {
    const { serverWebAssetsDir } = await import('#/cli/sub/web/run');
    const dir = mkdtempSync(join(tmpdir(), 'kimi-web-assets-'));
    try {
      expect(serverWebAssetsDir({ KIMI_CODE_DEV_SERVER: '1' }, dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function makeLegacyKillDeps(overrides: Partial<LegacyKillDeps> = {}): {
  deps: LegacyKillDeps;
  writes: string[];
  errors: string[];
  signals: Array<{ pid: number; signal: NodeJS.Signals }>;
  state: { shutdownCalls: number; removeCalls: number };
  clock: { t: number };
} {
  const writes: string[] = [];
  const errors: string[] = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const state = { shutdownCalls: 0, removeCalls: 0 };
  const clock = { t: 0 };
  const deps: LegacyKillDeps = {
    readLock: async () => undefined,
    removeLock: async () => {
      state.removeCalls += 1;
    },
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
    stderr: {
      write(chunk: string | Uint8Array) {
        errors.push(String(chunk));
        return true;
      },
    },
    now: () => clock.t,
    ...overrides,
  };
  return { deps, writes, errors, signals, state, clock };
}

describe('`kimi server kill` (deprecated, legacy servers only)', () => {
  const legacyLock = { pid: 1234, host: '127.0.0.1', port: 58627 };

  it('is registered as a subcommand of `server`', () => {
    const program = makeProgram();
    const server = program.commands.find((c) => c.name() === 'server');
    expect(server).toBeDefined();
    expect(server?.commands.map((c) => c.name())).toContain('kill');
  });

  it('prints a deprecation notice naming the 0.28.0 cutoff on every run', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    const { deps, errors } = makeLegacyKillDeps();

    await handleLegacyKillCommand(deps);

    const notice = errors.join('');
    expect(notice).toContain('deprecated');
    expect(notice).toContain('0.28.0');
    expect(notice).toContain('Ctrl+C');
  });

  it('prints "No running legacy Kimi server." and sends no signal when no lock exists', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    const { deps, writes, signals } = makeLegacyKillDeps({ readLock: async () => undefined });

    await handleLegacyKillCommand(deps);

    expect(writes.join('')).toContain('No running legacy Kimi server.');
    expect(signals).toEqual([]);
  });

  it('sweeps a stale lock whose pid is already dead', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    const { deps, writes, signals, state } = makeLegacyKillDeps({
      readLock: async () => legacyLock,
      pidAlive: () => false,
    });

    await handleLegacyKillCommand(deps);

    expect(writes.join('')).toContain('No running legacy Kimi server.');
    expect(signals).toEqual([]);
    expect(state.shutdownCalls).toBe(0);
    expect(state.removeCalls).toBe(1);
  });

  it('attempts the API shutdown, then stops after SIGTERM when the pid exits promptly', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    const { deps, writes, signals, state, clock } = makeLegacyKillDeps({
      readLock: async () => legacyLock,
      pidAlive: () => clock.t < 50,
    });

    await handleLegacyKillCommand(deps);

    expect(state.shutdownCalls).toBe(1);
    expect(signals).toEqual([{ pid: 1234, signal: 'SIGTERM' }]);
    expect(writes.join('')).toContain('pid 1234');
    expect(writes.join('')).toContain('stopped.');
    expect(state.removeCalls).toBe(1);
  });

  it('escalates to SIGKILL when the pid survives SIGTERM', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    const { deps, writes, signals, clock } = makeLegacyKillDeps({
      readLock: async () => ({ ...legacyLock, pid: 5678 }),
      pidAlive: () => clock.t < 3100,
    });

    await handleLegacyKillCommand(deps);

    expect(signals.map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(writes.join('')).toContain('pid 5678');
    expect(writes.join('')).toContain('killed.');
  });

  it('throws a permissions error when the pid survives SIGKILL', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    const { deps } = makeLegacyKillDeps({
      readLock: async () => ({ ...legacyLock, pid: 9999 }),
      pidAlive: () => true,
    });

    await expect(handleLegacyKillCommand(deps)).rejects.toThrow(/insufficient permissions/);
  });

  it('skips the API path when the lock records no port', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    const { deps, signals, state, clock } = makeLegacyKillDeps({
      readLock: async () => ({ pid: 1234 }),
      pidAlive: () => clock.t < 50,
    });

    await handleLegacyKillCommand(deps);

    expect(state.shutdownCalls).toBe(0);
    expect(signals).toEqual([{ pid: 1234, signal: 'SIGTERM' }]);
  });

  it('passes the resolved token to requestShutdown', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    let seenToken: string | undefined = 'unset';
    const { deps, clock } = makeLegacyKillDeps({
      readLock: async () => legacyLock,
      resolveToken: () => 'tok-123',
      requestShutdown: async (_origin, token) => {
        seenToken = token;
      },
      pidAlive: () => clock.t < 50,
    });

    await handleLegacyKillCommand(deps);

    expect(seenToken).toBe('tok-123');
  });

  it('passes undefined when the token cannot be read (best-effort)', async () => {
    const { handleLegacyKillCommand } = await import('#/cli/sub/web/legacy-kill');
    let seenToken: string | undefined = 'unset';
    const { deps, clock } = makeLegacyKillDeps({
      readLock: async () => legacyLock,
      resolveToken: () => undefined,
      requestShutdown: async (_origin, token) => {
        seenToken = token;
      },
      pidAlive: () => clock.t < 50,
    });

    await handleLegacyKillCommand(deps);

    expect(seenToken).toBeUndefined();
  });
});

describe('readLegacyLock', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kimi-legacy-lock-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses a lock written by an old build', async () => {
    const { readLegacyLock } = await import('#/cli/sub/web/legacy-kill');
    const lockPath = join(dir, 'lock');
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 1234, started_at: '2026-01-01T00:00:00.000Z', port: 58627 }),
    );

    await expect(readLegacyLock(lockPath)).resolves.toEqual({
      pid: 1234,
      host: undefined,
      port: 58627,
    });
  });

  it('rejects a corrupt lock whose pid is not a positive integer', async () => {
    const { readLegacyLock } = await import('#/cli/sub/web/legacy-kill');
    const lockPath = join(dir, 'lock');
    for (const pid of [0, -1, 1.5, '1234']) {
      writeFileSync(lockPath, JSON.stringify({ pid, port: 58627 }));
      await expect(readLegacyLock(lockPath)).resolves.toBeUndefined();
    }
  });

  it('returns undefined when the lock file is missing or unparseable', async () => {
    const { readLegacyLock } = await import('#/cli/sub/web/legacy-kill');
    await expect(readLegacyLock(join(dir, 'missing'))).resolves.toBeUndefined();
    const lockPath = join(dir, 'lock');
    writeFileSync(lockPath, 'not json');
    await expect(readLegacyLock(lockPath)).resolves.toBeUndefined();
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
    const { resolveServerToken } = await import('#/cli/sub/web/shared');
    writeFileSync(join(dir, 'server.token'), 'secret-token\n');
    expect(resolveServerToken(dir)).toBe('secret-token');
  });

  it('trims surrounding whitespace', async () => {
    const { resolveServerToken } = await import('#/cli/sub/web/shared');
    writeFileSync(join(dir, 'server.token'), '  tok  \n');
    expect(resolveServerToken(dir)).toBe('tok');
  });

  it('throws a clear error when the token file is missing', async () => {
    const { resolveServerToken } = await import('#/cli/sub/web/shared');
    expect(() => resolveServerToken(dir)).toThrow(/unable to read server token/);
  });
});

describe('authHeaders', () => {
  it('builds a Bearer Authorization header', async () => {
    const { authHeaders } = await import('#/cli/sub/web/shared');
    expect(authHeaders('abc')).toEqual({ Authorization: 'Bearer abc' });
  });
});

describe('buildWebUrl', () => {
  it('carries the token in the URL fragment (not path or query)', async () => {
    const { buildWebUrl } = await import('#/cli/sub/web/run');
    const url = buildWebUrl('http://127.0.0.1:58627', 'abc123');
    expect(url).toBe('http://127.0.0.1:58627/#token=abc123');
    const parsed = new URL(url);
    expect(parsed.hash).toBe('#token=abc123');
    expect(parsed.pathname).not.toContain('abc123');
    expect(parsed.search).not.toContain('abc123');
  });

  it('normalizes a trailing slash', async () => {
    const { buildWebUrl } = await import('#/cli/sub/web/run');
    expect(buildWebUrl('http://127.0.0.1:58627/', 't')).toBe(
      'http://127.0.0.1:58627/#token=t',
    );
  });
});

describe('accessUrlLines', () => {
  it('returns Local + Network lines for a wildcard bind', async () => {
    const { accessUrlLines } = await import('#/cli/sub/web/access-urls');
    const lines = accessUrlLines('0.0.0.0', 58627, 'tok', [
      { address: '192.168.1.5', family: 'IPv4' },
    ]);
    expect(lines).toEqual([
      { label: 'Local:    ', url: 'http://localhost:58627/#token=tok' },
      { label: 'Network:  ', url: 'http://192.168.1.5:58627/#token=tok' },
    ]);
  });

  it('returns a single Local line for a loopback bind', async () => {
    const { accessUrlLines } = await import('#/cli/sub/web/access-urls');
    const lines = accessUrlLines('127.0.0.1', 58627, 'tok');
    expect(lines).toEqual([
      { label: 'Local:    ', url: 'http://127.0.0.1:58627/#token=tok' },
    ]);
  });

  it('returns a single URL line for a specific host (no token)', async () => {
    const { accessUrlLines } = await import('#/cli/sub/web/access-urls');
    const lines = accessUrlLines('192.168.1.5', 58627, undefined);
    expect(lines).toEqual([{ label: 'URL:      ', url: 'http://192.168.1.5:58627/' }]);
  });

  it('splitTokenFragment splits off the #token= fragment', async () => {
    const { splitTokenFragment } = await import('#/cli/sub/web/access-urls');
    expect(splitTokenFragment('http://h:1/#token=abc')).toEqual(['http://h:1/', '#token=abc']);
    expect(splitTokenFragment('http://h:1/')).toEqual(['http://h:1/', '']);
  });
});

describe('browserOpenOrigin', () => {
  it('rewrites wildcard bind hosts to localhost on the same port', async () => {
    const { browserOpenOrigin } = await import('#/cli/sub/web/access-urls');
    expect(browserOpenOrigin('http://0.0.0.0:58627')).toBe('http://localhost:58627');
    expect(browserOpenOrigin('http://:::58627')).toBe('http://localhost:58627');
  });

  it('keeps navigable origins unchanged', async () => {
    const { browserOpenOrigin } = await import('#/cli/sub/web/access-urls');
    expect(browserOpenOrigin('http://127.0.0.1:58627')).toBe('http://127.0.0.1:58627');
    expect(browserOpenOrigin('http://192.168.1.5:58627')).toBe('http://192.168.1.5:58627');
    expect(browserOpenOrigin('http://[::1]:58627')).toBe('http://[::1]:58627');
  });
});

describe('`kimi server ensure-daemon`', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-ensure-daemon-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  function connection(overrides: Partial<DaemonConnection> = {}): DaemonConnection {
    return {
      stream: new PassThrough(),
      version: '1.0.0',
      stopIfIdle: async () => true,
      close: () => {},
      ...overrides,
    };
  }

  function lease(): DaemonLease {
    return { closed: new Promise(() => {}), close: () => {} };
  }

  function makeDeps(overrides: Partial<EnsureDaemonDeps> = {}): EnsureDaemonDeps {
    return {
      homeDir,
      version: '1.0.0',
      connectSocket: async () => connection(),
      leaseSocket: async () => lease(),
      spawnServer: vi.fn(),
      wait: async () => {},
      ...overrides,
    };
  }

  async function listenRpcSocket(
    onLine: (frame: Record<string, unknown>, socket: Socket) => void,
  ): Promise<{ socketPath: string; client(): Socket | undefined }> {
    const socketPath = join(homeDir, 'daemon.sock');
    let client: Socket | undefined;
    const server = createServer((socket) => {
      client = socket;
      createInterface({ input: socket }).on('line', (line) => {
        onLine(JSON.parse(line) as Record<string, unknown>, socket);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanupServers.push(server);
    return { socketPath, client: () => client };
  }

  const cleanupServers: Array<ReturnType<typeof createServer>> = [];

  afterEach(async () => {
    for (const server of cleanupServers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('attaches Remote Control under the lock and returns the daemon socket instead of a stdio stream', async () => {
    const lockPath = join(homeDir, 'server', 'ensure-daemon.lock');
    const close = vi.fn();
    const held = lease();
    let lockedWhileLeasing = false;
    const leaseSocket = vi.fn(async () => {
      lockedWhileLeasing = existsSync(lockPath);
      return held;
    });
    const deps = makeDeps({ connectSocket: async () => connection({ close }), leaseSocket });

    await expect(attachDaemon(deps)).resolves.toEqual({
      socketPath: daemonSocketPath(homeDir),
      logPath: join(homeDir, 'server', 'ensure-daemon.log'),
      lease: held,
    });
    expect(leaseSocket).toHaveBeenCalledWith(daemonSocketPath(homeDir));
    expect(lockedWhileLeasing).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(existsSync(lockPath)).toBe(false);
    expect(deps.spawnServer).not.toHaveBeenCalled();
  });

  it('reports the running version when a busy daemon blocks Remote Control', async () => {
    const leaseSocket = vi.fn(async () => lease());
    const failure = attachDaemon(
      makeDeps({
        connectSocket: async () => connection({ version: '0.9.0', stopIfIdle: async () => false }),
        leaseSocket,
      }),
    );

    await expect(failure).rejects.toBeInstanceOf(DaemonBusyError);
    await expect(failure).rejects.toMatchObject({
      code: 'version_mismatch_busy',
      runningVersion: '0.9.0',
    });
    expect(leaseSocket).not.toHaveBeenCalled();
  });

  it('fails Remote Control when the daemon stops before the lease attaches', async () => {
    await expect(attachDaemon(makeDeps({ leaseSocket: async () => undefined }))).rejects.toThrow(
      'stopped before Remote Control could attach',
    );
    expect(existsSync(join(homeDir, 'server', 'ensure-daemon.lock'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('holds the daemon with a KAP WebSocket over its RPC socket and answers heartbeats', async () => {
    const received: Array<Record<string, unknown>> = [];
    const rpc = await listenRpcSocket((frame, socket) => {
      received.push(frame);
      if (frame['type'] !== 'http.req') return;
      socket.write(`${JSON.stringify({ type: 'ws.msg', id: 'lease', data: '{"type":"session.changed"}' })}\n`);
      socket.write(`${JSON.stringify({ type: 'http.res', id: frame['id'], status: 200, headers: {} })}\n`);
    });

    const held = await defaultEnsureDaemonDeps().leaseSocket(rpc.socketPath);
    expect(held).toBeDefined();
    expect(received[0]).toEqual({ type: 'ws.open', id: 'lease', path: '/api/v1/ws' });
    expect(received[1]).toMatchObject({ type: 'http.req', method: 'GET', path: '/api/v1/healthz' });

    rpc.client()!.write(`${JSON.stringify({ type: 'ws.msg', id: 'lease', data: '{"type":"ping"}' })}\n`);
    await vi.waitFor(() => {
      expect(received).toContainEqual({ type: 'ws.msg', id: 'lease', data: '{"type":"pong"}' });
    });
    expect(received.filter((frame) => frame['type'] === 'ws.msg')).toHaveLength(1);

    rpc.client()!.write(`${JSON.stringify({ type: 'ws.close', id: 'lease', code: 1001 })}\n`);
    await expect(held!.closed).resolves.toBe('stopped');
  });

  it.skipIf(process.platform === 'win32')('reports that the daemon left to run an upgraded version when it closes the lease with the upgrade code', async () => {
    const rpc = await listenRpcSocket((frame, socket) => {
      if (frame['type'] !== 'http.req') return;
      socket.write(`${JSON.stringify({ type: 'http.res', id: frame['id'], status: 200, headers: {} })}\n`);
    });

    const held = await defaultEnsureDaemonDeps().leaseSocket(rpc.socketPath);
    expect(held).toBeDefined();
    rpc.client()!.write(
      `${JSON.stringify({ type: 'ws.close', id: 'lease', code: SERVER_UPGRADED_CLOSE_CODE, reason: 'Kimi Code 9.9.9 is installed; this server is restarting' })}\n`,
    );
    await expect(held!.closed).resolves.toBe('upgraded');
  });

  it.skipIf(process.platform === 'win32')('does not hand out a lease when the daemon closes the stream before confirming it', async () => {
    const rpc = await listenRpcSocket((_frame, socket) => {
      socket.destroy();
    });

    await expect(defaultEnsureDaemonDeps().leaseSocket(rpc.socketPath)).resolves.toBeUndefined();
  });

  it('reuses a live daemon socket of the same version without spawning', async () => {
    const conn = connection();
    const deps = makeDeps({
      connectSocket: async () => conn,
    });

    await expect(ensureDaemon(deps)).resolves.toEqual({
      version: '1.0.0',
      stream: conn.stream,
    });
    expect(deps.spawnServer).not.toHaveBeenCalled();
  });

  it('spawns a new server when the socket is absent and waits until it connects', async () => {
    let attempts = 0;
    const spawned = connection();
    const deps = makeDeps({
      connectSocket: async () => {
        attempts += 1;
        return attempts >= 4 ? spawned : undefined;
      },
    });

    await expect(ensureDaemon(deps)).resolves.toEqual({
      version: '1.0.0',
      stream: spawned.stream,
    });
    expect(deps.spawnServer).toHaveBeenCalledWith(
      daemonSocketPath(homeDir),
      join(homeDir, 'server', 'ensure-daemon.log'),
      join(homeDir, 'server', 'forwarded-ssh-agent.sock'),
    );
  });

  it('replaces an idle daemon of another version after its socket closes', async () => {
    let state: 'old' | 'draining' | 'closed' | 'new' = 'old';
    const stopIfIdle = vi.fn(async () => {
      state = 'draining';
      return true;
    });
    const spawned = connection();
    const deps = makeDeps({
      connectSocket: async () => {
        if (state === 'old') return connection({ version: '0.9.0', stopIfIdle });
        if (state === 'draining') {
          state = 'closed';
          return connection({ version: '0.9.0' });
        }
        if (state === 'closed') return undefined;
        return spawned;
      },
      spawnServer: vi.fn(() => {
        state = 'new';
      }),
    });

    await expect(ensureDaemon(deps)).resolves.toMatchObject({ version: '1.0.0' });
    expect(stopIfIdle).toHaveBeenCalledTimes(1);
    expect(deps.spawnServer).toHaveBeenCalledTimes(1);
  });

  it('refuses to replace a daemon of another version that still has live work', async () => {
    const deps = makeDeps({
      connectSocket: async () =>
        connection({ version: '0.9.0', stopIfIdle: async () => false }),
    });

    await expect(ensureDaemon(deps)).rejects.toMatchObject({ code: 'version_mismatch_busy' });
    expect(deps.spawnServer).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('atomically updates the forwarded agent socket symlink when SSH_AUTH_SOCK is present', async () => {
    const agentSocket = join(homeDir, 'server', 'forwarded-ssh-agent.sock');
    await ensureDaemon(makeDeps({ sshAuthSock: '/tmp/ssh-1/agent.100' }));
    expect(lstatSync(agentSocket).isSymbolicLink()).toBe(true);
    expect(readlinkSync(agentSocket)).toBe('/tmp/ssh-1/agent.100');

    await ensureDaemon(makeDeps({ sshAuthSock: '/tmp/ssh-2/agent.200' }));
    expect(readlinkSync(agentSocket)).toBe('/tmp/ssh-2/agent.200');

    await ensureDaemon(makeDeps({ sshAuthSock: undefined }));
    expect(readlinkSync(agentSocket)).toBe('/tmp/ssh-2/agent.200');
  });

  it.skipIf(process.platform === 'win32')('runs a background command detached and returns its exit code with only its own output, appended to the log', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(spawn).mockImplementation(actual.spawn);
    const logPath = daemonUpgradeLogPath(homeDir);
    mkdirSync(join(homeDir, 'server'), { recursive: true });
    writeFileSync(logPath, 'earlier run\n');
    try {
      await expect(
        runLoggedCommand(
          [process.execPath, '-e', 'console.log("Updated"); console.error("warning: slow mirror"); process.exit(3)'],
          logPath,
        ),
      ).resolves.toEqual({ code: 3, output: 'Updated\nwarning: slow mirror\n' });
      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        ['-e', expect.any(String)],
        expect.objectContaining({ detached: true }),
      );
      expect(readFileSync(logPath, 'utf8')).toBe('earlier run\nUpdated\nwarning: slow mirror\n');
      await expect(runLoggedCommand([join(homeDir, 'missing-kimi'), '--version'], logPath)).resolves.toMatchObject({
        code: null,
        output: expect.stringContaining('ENOENT'),
      });
    } finally {
      vi.mocked(spawn).mockReset();
    }
  });

  it('re-runs this kimi binary for background commands and logs them next to the daemon log', async () => {
    vi.stubEnv('KIMI_CODE_HOME', homeDir);
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockImplementation(() => {
      setImmediate(() => child.emit('close', 0));
      return child as unknown as ChildProcess;
    });
    try {
      await expect(runKimiCommand(['upgrade', '--yes'])).resolves.toEqual({ code: 0, output: '' });
      expect(spawn).toHaveBeenCalledWith(
        process.execPath,
        [...process.execArgv, process.argv[1], 'upgrade', '--yes'],
        expect.objectContaining({ detached: true }),
      );
      expect(child.unref).toHaveBeenCalledOnce();
      expect(existsSync(join(homeDir, 'server', 'upgrade.log'))).toBe(true);
    } finally {
      vi.mocked(spawn).mockReset();
      vi.unstubAllEnvs();
    }
  });

  it('releases the lock after a failure and clears dead or corrupted lock files', async () => {
    const lockPath = join(homeDir, 'server', 'ensure-daemon.lock');
    await expect(
      ensureDaemon(
        makeDeps({
          connectSocket: async () =>
            connection({ version: '0.9.0', stopIfIdle: async () => false }),
        }),
      ),
    ).rejects.toMatchObject({
      code: 'version_mismatch_busy',
    });
    expect(existsSync(lockPath)).toBe(false);

    writeFileSync(lockPath, '999999999');
    await expect(ensureDaemon(makeDeps())).resolves.toMatchObject({ version: '1.0.0' });
    expect(existsSync(lockPath)).toBe(false);

    writeFileSync(lockPath, '');
    await expect(ensureDaemon(makeDeps())).resolves.toMatchObject({ version: '1.0.0' });
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe('`kimi web rotate-token`', () => {
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
    const { registerWebCommand } = await import('#/cli/sub/web');
    const program = new Command('kimi').exitOverride();
    registerWebCommand(program);
    let stdout = '';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });

    await program.parseAsync(['node', 'kimi', 'web', 'rotate-token']);
    writeSpy.mockRestore();

    const token = readFileSync(join(dir, 'server.token'), 'utf8').trim();
    expect(token.length).toBeGreaterThan(20);
    expect(stdout).toContain('New server token');
    expect(stdout).toContain(token);
  });

  it('re-prints the access links with the new token when a server is running', async () => {
    const { registerWebCommand } = await import('#/cli/sub/web');
    const { mkdirSync, writeFileSync: writeSync } = await import('node:fs');
    mkdirSync(join(dir, 'server', 'instances'), { recursive: true });
    writeSync(
      join(dir, 'server', 'instances', '01JTEST0000000000000000000.json'),
      JSON.stringify({
        server_id: '01JTEST0000000000000000000',
        pid: process.pid,
        host: '127.0.0.1',
        port: 58627,
        started_at: Date.now(),
        heartbeat_at: Date.now(),
      }),
    );

    const program = new Command('kimi').exitOverride();
    registerWebCommand(program);
    let stdout = '';
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });

    await program.parseAsync(['node', 'kimi', 'web', 'rotate-token']);
    writeSpy.mockRestore();

    const token = readFileSync(join(dir, 'server.token'), 'utf8').trim();
    expect(stdout).toContain('New server token');
    expect(stdout).toContain(`http://127.0.0.1:58627/#token=${token}`);
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
    const { formatHostForUrl } = await import('#/cli/sub/web/networks');
    expect(formatHostForUrl('192.168.1.5', 'IPv4')).toBe('192.168.1.5');
    expect(formatHostForUrl('fe80::1', 'IPv6')).toBe('[fe80::1]');
  });
});

describe('filterDisplayAddresses', () => {
  it('drops IPv6 link-local, de-duplicates, and orders IPv4 before IPv6', async () => {
    const { filterDisplayAddresses } = await import('#/cli/sub/web/networks');
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

describe('kimi web --json', () => {
  it('mints an ephemeral in-memory bearer token, skips openUrl and server.token, and prints a single-line JSON ready payload', async () => {
    const { handleWebCommand, formatJsonBootLine } = await import('#/cli/sub/web/run');
    const { runner, calls } = makeRunner('http://127.0.0.1:49123/');
    const io = makeIo();
    const openUrl = vi.fn();
    const resolveToken = vi.fn(() => 'persistent-server-token');

    await handleWebCommand(
      { port: '0', json: true, open: true },
      {
        startServerForeground: runner,
        openUrl,
        resolveToken,
        stdout: io.stdout,
        stderr: io.stderr,
      },
    );

    expect(openUrl).not.toHaveBeenCalled();
    expect(resolveToken).not.toHaveBeenCalled();
    expect(calls.options?.skipInstanceRegistry).toBe(true);
    expect(calls.options?.logToStderr).toBe(true);
    expect(calls.options?.authTokenService).toBeDefined();

    const issuedToken = calls.options!.authTokenService!.getToken();
    expect(issuedToken.length).toBeGreaterThan(20);
    expect(await calls.options!.authTokenService!.isValid(issuedToken)).toBe(true);
    expect(await calls.options!.authTokenService!.isValid('persistent-server-token')).toBe(false);

    const lines = io.readStdout().trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed).toEqual({
      origin: 'http://127.0.0.1:49123',
      ws_url: 'ws://127.0.0.1:49123/api/v1/ws',
      token: issuedToken,
      kimi_agent_protocol_version: '1.0.0',
    });

    expect(JSON.parse(formatJsonBootLine('http://::1:58627', 'tok_1'))).toMatchObject({
      origin: 'http://[::1]:58627',
      ws_url: 'ws://[::1]:58627/api/v1/ws',
    });
    expect(JSON.parse(formatJsonBootLine('http://0.0.0.0:58627', 'tok_1'))).toMatchObject({
      origin: 'http://127.0.0.1:58627',
      ws_url: 'ws://127.0.0.1:58627/api/v1/ws',
    });
  });

  it('rejects combining --json with incompatible flags', async () => {
    const { handleWebCommand } = await import('#/cli/sub/web/run');
    const io = makeIo();

    for (const [opts, pattern] of [
      [{ json: true, remoteControl: true }, /--json cannot be combined with --remote-control/],
      [{ json: true, dangerousBypassAuth: true }, /--json cannot be combined with --dangerous-bypass-auth/],
      [{ json: true, debugEndpoints: true }, /--json cannot be combined with --debug-endpoints/],
      [{ json: true, allowRemoteShutdown: true }, /--json cannot be combined with --allow-remote-shutdown/],
    ] as const) {
      await expect(
        handleWebCommand(opts, { openUrl: vi.fn(), stdout: io.stdout, stderr: io.stderr }),
      ).rejects.toThrow(pattern);
    }
  });
});
