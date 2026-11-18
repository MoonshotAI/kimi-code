import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setCapabilities } from '@moonshot-ai/pi-tui';
import * as QRCode from 'qrcode';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { DaemonBusyError, type DaemonLease } from '#/cli/sub/web/ensure-daemon';
import {
  attachBackgroundServer,
  DAEMON_BUSY_RETRY_MS,
  formatRemoteControlOutput,
  formatRemoteControlStatus,
  runRemoteControl,
  type RemoteControlCloseReason,
  type RemoteControlHandle,
  type RemoteControlOptions,
  type RemoteControlRunDeps,
} from '#/cli/sub/web/remote-control';
import { renderTerminalQr } from '#/utils/remote-control-qr';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Remote Control output', () => {
  const outputOptions = {
    url: 'https://example.test/devices/example-device/?rc=1&from=kimi_code_cli',
    deviceName: 'example-device',
    qrCode: 'QR\n',
    pngPath: '/tmp/example-qr.png',
    logPath: '/tmp/example-home/server/ensure-daemon.log',
  };

  it('shows the full URL as the clickable link text alongside the setup contract', () => {
    vi.stubEnv('FORCE_HYPERLINK', '1');
    const output = formatRemoteControlOutput(outputOptions);
    const url = outputOptions.url;
    expect(output).toContain('Use Kimi Code on this machine');
    expect(output).toContain('1.');
    expect(output).toContain('2.');
    expect(output).toContain('3.');
    expect(output).toContain(`\u001B]8;;${url}`);
    const plain = output
      .replaceAll(/\u001B\]8;;.*?\u0007/g, '')
      .replaceAll(/\u001B\[[0-9;]*m/g, '');
    expect(plain).toContain(`open ${url}`);
    expect(plain).not.toContain('exampl…');
    expect(plain).not.toContain('Local UI');
    expect(plain).not.toContain('#token=');
    expect(output).toContain('Connected to example.test');
    expect(output).toContain('This device:');
    expect(output).not.toContain('Manage devices');
    expect(output).toContain('PNG:');
    expect(output).toContain('\n    QR');
    expect(output).toContain('grants control of this machine');
    expect(output).toContain('docs');
    expect(output).toContain('feedback');
    expect(plain).toContain(`Logs: ${outputOptions.logPath}`);
    expect(output).not.toContain('stream-1');
  });

  it('prints the full URL as plain text when the terminal cannot render hyperlinks', () => {
    vi.stubEnv('FORCE_HYPERLINK', '0');
    const output = formatRemoteControlOutput(outputOptions);
    expect(output).toContain(`open ${outputOptions.url}`);
    expect(output).not.toContain('exampl…vice');
    expect(output).not.toContain('Manage devices');
  });

  it('keeps the logs hint for a server without a log file', () => {
    const output = formatRemoteControlOutput({ ...outputOptions, logPath: undefined });
    expect(output.replaceAll(/\u001B\[[0-9;]*m/g, '')).toContain('Logs: off (--log-level info)');
  });

  it('formats relay and device lifecycle states', () => {
    expect(formatRemoteControlStatus('relay_connected').toLowerCase()).toContain('connected');
    expect(formatRemoteControlStatus('relay_disconnected')).toContain('disconnected');
    expect(formatRemoteControlStatus('relay_terminated')).toContain('offline');
    expect(formatRemoteControlStatus('relay_terminated')).toContain('exiting');
    expect(formatRemoteControlStatus('relay_terminated')).not.toContain('reconnecting');
    expect(formatRemoteControlStatus('device_connected').toLowerCase()).toContain('connected');
    expect(formatRemoteControlStatus('device_disconnected')).toContain('disconnected');
  });
});

const SOCKET_PATH = '/tmp/kimi-test-home/server/daemon.sock';
const LOG_PATH = '/tmp/kimi-test-home/server/ensure-daemon.log';
const ENTRY_URL = 'https://code-rc.kimi.com/devices/device-1/?rc=1&from=kimi_code_cli';

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function makeLease(): DaemonLease & { close: Mock<() => void>; lose(): void } {
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  return { closed, close: vi.fn(() => markClosed()), lose: () => markClosed() };
}

function makeTunnel(): {
  handle: RemoteControlHandle & { close: Mock<() => Promise<void>> };
  options(): RemoteControlOptions;
  startRemoteControl: Mock<RemoteControlRunDeps['startRemoteControl']>;
  end(reason: RemoteControlCloseReason): void;
} {
  let endTunnel!: (reason: RemoteControlCloseReason) => void;
  let received: RemoteControlOptions | undefined;
  const closed = new Promise<RemoteControlCloseReason>((resolve) => {
    endTunnel = resolve;
  });
  const handle = {
    deviceId: 'device-1',
    deviceName: 'example-device',
    url: ENTRY_URL,
    relayOrigin: 'https://code-rc.kimi.com',
    closed,
    close: vi.fn(async () => {
      received?.onStatus?.('relay_disconnected');
      endTunnel('local_close');
    }),
  };
  const startRemoteControl = vi.fn<RemoteControlRunDeps['startRemoteControl']>(async (options) => {
    received = options;
    options.onStatus?.('relay_connected');
    return handle;
  });
  return { handle, options: () => received!, startRemoteControl, end: (reason) => endTunnel(reason) };
}

function makeDeps(overrides: Partial<RemoteControlRunDeps> = {}): {
  deps: RemoteControlRunDeps;
  lease: ReturnType<typeof makeLease>;
  tunnel: ReturnType<typeof makeTunnel>;
  terminate(): void;
  stopListening: Mock<() => void>;
  stdout(): string;
  rawStdout(): string;
} {
  const lease = makeLease();
  const tunnel = makeTunnel();
  let terminate: (() => void) | undefined;
  const stopListening = vi.fn();
  let out = '';
  const deps: RemoteControlRunDeps = {
    attachServer: vi.fn(() =>
      attachBackgroundServer(async () => ({ socketPath: SOCKET_PATH, logPath: LOG_PATH, lease })),
    ),
    startRemoteControl: tunnel.startRemoteControl,
    onTerminate: (listener) => {
      terminate = listener;
      return stopListening;
    },
    wait: vi.fn(async () => {}),
    openUrl: vi.fn(),
    stdout: {
      write(chunk: string | Uint8Array) {
        out += String(chunk);
        return true;
      },
    },
    stderr: { write: () => true },
    ...overrides,
  };
  return {
    deps,
    lease,
    tunnel,
    terminate: () => terminate?.(),
    stopListening,
    stdout: () => stripAnsi(out),
    rawStdout: () => out,
  };
}

describe('runRemoteControl', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'kimi-rc-run-'));
    vi.stubEnv('KIMI_CODE_HOME', home);
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('serves the tunnel from the daemon socket and leaves the daemon running on Ctrl+C', async () => {
    const run = makeDeps();

    const running = runRemoteControl({ open: true }, run.deps);
    await vi.waitFor(() => expect(run.deps.openUrl).toHaveBeenCalledWith(ENTRY_URL));
    const options = run.tunnel.options();
    expect(options).toMatchObject({ homeDir: home, localOrigin: `unix:${SOCKET_PATH}` });
    expect(options.localServerToken).toBeUndefined();
    expect(run.stdout()).toContain('Kimi Remote Control ready');
    expect(run.stdout()).toContain(`Logs: ${LOG_PATH}`);
    expect(run.stdout()).not.toContain('#token=');
    expect(run.stdout().indexOf('Kimi Remote Control ready')).toBeLessThan(
      run.stdout().indexOf('Connected to relay'),
    );
    expect(run.lease.close).not.toHaveBeenCalled();

    run.terminate();
    await expect(running).resolves.toBeUndefined();
    expect(run.tunnel.handle.close).toHaveBeenCalledOnce();
    expect(run.lease.close).toHaveBeenCalledOnce();
    expect(run.stopListening).toHaveBeenCalledOnce();
    expect(run.stdout()).not.toContain('reconnecting');
    expect(run.stdout()).toContain('sessions keep running in the background Kimi server');
  });

  it('closes the tunnel and fails when the background server goes away', async () => {
    const run = makeDeps();

    const running = runRemoteControl({ open: false }, run.deps);
    await vi.waitFor(() => expect(run.tunnel.startRemoteControl).toHaveBeenCalledOnce());
    run.lease.lose();

    await expect(running).rejects.toThrow('The background Kimi server stopped');
    expect(run.tunnel.handle.close).toHaveBeenCalledOnce();
    expect(run.deps.openUrl).not.toHaveBeenCalled();
    expect(run.stdout()).not.toContain('sessions keep running');
  });

  it('exits cleanly when the relay takes the device offline', async () => {
    const run = makeDeps();

    const running = runRemoteControl({ open: false }, run.deps);
    await vi.waitFor(() => expect(run.tunnel.startRemoteControl).toHaveBeenCalledOnce());
    run.tunnel.options().onStatus?.('relay_terminated');
    run.tunnel.end('user_requested');

    await expect(running).resolves.toBeUndefined();
    expect(run.stdout()).toContain('Taken offline from the web');
    expect(run.lease.close).toHaveBeenCalledOnce();
  });

  it('waits with one status line while another version of the server is busy', async () => {
    let attempts = 0;
    const run = makeDeps();
    const attachServer = vi.fn(() =>
      attachBackgroundServer(async () => {
        attempts += 1;
        if (attempts < 3) throw new DaemonBusyError('0.9.0');
        return { socketPath: SOCKET_PATH, logPath: LOG_PATH, lease: run.lease };
      }),
    );
    run.deps = { ...run.deps, attachServer };

    const running = runRemoteControl({ open: false }, run.deps);
    await vi.waitFor(() => expect(run.tunnel.startRemoteControl).toHaveBeenCalledOnce());
    expect(attachServer).toHaveBeenCalledTimes(3);
    expect(run.deps.wait).toHaveBeenCalledTimes(2);
    expect(run.deps.wait).toHaveBeenCalledWith(DAEMON_BUSY_RETRY_MS, expect.any(AbortSignal));
    expect(run.stdout().match(/Kimi server 0\.9\.0 is still running work/g)).toHaveLength(1);

    run.terminate();
    await running;
  });

  it('stops waiting for a busy server on Ctrl+C without starting the tunnel', async () => {
    const run = makeDeps();
    const attachServer = vi.fn(async () => {
      throw new DaemonBusyError('0.9.0');
    });
    run.deps = {
      ...run.deps,
      attachServer,
      wait: async () => {
        run.terminate();
      },
    };

    await expect(runRemoteControl({ open: false }, run.deps)).resolves.toBeUndefined();
    expect(attachServer).toHaveBeenCalledOnce();
    expect(run.tunnel.startRemoteControl).not.toHaveBeenCalled();
  });

  it('forwards to an in-process server with its token and stops it with the tunnel', async () => {
    const run = makeDeps();
    const close = vi.fn(async () => {});
    run.deps = {
      ...run.deps,
      attachServer: async () => ({
        localOrigin: 'http://127.0.0.1:58627',
        localServerToken: () => 'local-server-token',
        background: false,
        closed: new Promise<void>(() => {}),
        close,
      }),
    };

    const running = runRemoteControl({ open: false }, run.deps);
    await vi.waitFor(() => expect(run.tunnel.startRemoteControl).toHaveBeenCalledOnce());
    const options = run.tunnel.options();
    expect(options.localOrigin).toBe('http://127.0.0.1:58627');
    expect(typeof options.localServerToken === 'function' && options.localServerToken()).toBe(
      'local-server-token',
    );
    expect(run.stdout()).toContain('Logs: off (--log-level info)');

    run.terminate();
    await running;
    expect(run.tunnel.handle.close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(run.stdout()).not.toContain('sessions keep running');
  });

  it('releases the daemon when the tunnel cannot start', async () => {
    const run = makeDeps({
      startRemoteControl: async () => {
        throw new Error('Remote Control requires a Kimi login. Run `kimi login` first.');
      },
    });

    await expect(runRemoteControl({ open: false }, run.deps)).rejects.toThrow('requires a Kimi login');
    expect(run.lease.close).toHaveBeenCalledOnce();
    expect(run.stopListening).toHaveBeenCalledOnce();
  });

  it('opens a session deep link and saves its token-free QR code', async () => {
    const sessionUrl = 'https://code-rc.kimi.com/devices/device-1/sessions/ses-1?rc=1&from=kimi_code_cli';
    const run = makeDeps();

    const running = runRemoteControl({ open: true, sessionId: 'ses-1' }, run.deps);
    await vi.waitFor(() => expect(run.deps.openUrl).toHaveBeenCalledWith(sessionUrl));
    const pngPath = join(home, 'rc-qrcode.png');
    expect(run.rawStdout()).toContain(renderTerminalQr(sessionUrl).trimEnd().replaceAll(/^/gm, '    '));
    expect(run.stdout()).toContain(`QR code PNG: ${pngPath}`);
    expect(readFileSync(pngPath)).toEqual(await QRCode.toBuffer(sessionUrl));
    expect(run.stdout()).not.toContain(`${sessionUrl}#token=`);

    run.terminate();
    await running;
  });
});
