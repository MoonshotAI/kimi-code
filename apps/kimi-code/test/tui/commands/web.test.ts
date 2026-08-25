import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setCapabilities } from '@moonshot-ai/pi-tui';

import { findBuiltInSlashCommand, resolveSlashCommandAvailability } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import {
  handleRemoteControlCommand,
  handleWebCommand,
  webSessionUrl,
} from '#/tui/commands/web';
import { renderTerminalQr } from '#/utils/remote-control-qr';

const mocks = vi.hoisted(() => ({
  startServerForeground: vi.fn(),
  startRemoteControl: vi.fn(),
  tryResolveServerToken: vi.fn(),
  getDataDir: vi.fn(() => '/tmp/kimi-home'),
  openUrl: vi.fn(),
}));

vi.mock('#/cli/sub/web/remote-control', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/cli/sub/web/remote-control')>();
  return { ...actual, startRemoteControl: mocks.startRemoteControl };
});

vi.mock('#/cli/sub/web/run', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/cli/sub/web/run')>();
  return { ...actual, startServerForeground: mocks.startServerForeground };
});

vi.mock('#/cli/sub/web/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/cli/sub/web/shared')>();
  return {
    ...actual,
    tryResolveServerToken: mocks.tryResolveServerToken,
  };
});

vi.mock('#/utils/open-url', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/utils/open-url')>();
  return { ...actual, openUrl: mocks.openUrl };
});

vi.mock('#/utils/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/utils/paths')>();
  return { ...actual, getDataDir: mocks.getDataDir };
});

function makeHost() {
  const host = {
    session: { id: 'ses-1' },
    showStatus: vi.fn(),
    showError: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    setExitOpenUrl: vi.fn(),
    setExitForegroundTask: vi.fn(),
    stop: vi.fn(async () => {}),
    waitForLazyCreation: vi.fn(async () => {}),
  } as unknown as SlashCommandHost & {
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    restoreEditor: ReturnType<typeof vi.fn>;
    setExitOpenUrl: ReturnType<typeof vi.fn>;
    setExitForegroundTask: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    waitForLazyCreation: ReturnType<typeof vi.fn>;
  };
  return host;
}

describe('web slash command', () => {
  it('is registered as an always-available built-in', () => {
    const command = findBuiltInSlashCommand('web');
    expect(command).toBeDefined();
    expect(resolveSlashCommandAvailability(command!, '')).toBe('always');
  });

  it('registers /remote-control and /rc as the same always-available built-in', () => {
    const command = findBuiltInSlashCommand('remote-control');
    expect(command).toBeDefined();
    expect(findBuiltInSlashCommand('rc')).toBe(command);
    expect(resolveSlashCommandAvailability(command!, '')).toBe('always');
  });
});

describe('handleWebCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDataDir.mockReturnValue('/tmp/kimi-home');
  });

  it('shows an error and does nothing when there is no active session', async () => {
    const host = makeHost();
    host.session = undefined;

    await handleWebCommand(host);

    expect(host.showError).toHaveBeenCalledOnce();
    expect(host.setExitForegroundTask).not.toHaveBeenCalled();
    expect(host.stop).not.toHaveBeenCalled();
  });

  it('registers a foreground takeover and stops the TUI without opening a URL yet', async () => {
    const host = makeHost();

    await handleWebCommand(host);

    expect(host.setExitForegroundTask).toHaveBeenCalledOnce();
    expect(host.stop).toHaveBeenCalledOnce();
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it('starts the new server on takeover, printing the banner and opening the deep link', async () => {
    mocks.tryResolveServerToken.mockReturnValue('tok-1');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mocks.startServerForeground.mockImplementation(
      async (_options: unknown, hooks: { onReady?: (origin: string) => void }) => {
        hooks.onReady?.('http://127.0.0.1:58627');
      },
    );
    const host = makeHost();

    await handleWebCommand(host);
    const task = host.setExitForegroundTask.mock.calls[0]![0] as (
      exitCode: number,
    ) => Promise<void>;
    await task(0);

    expect(mocks.startServerForeground).toHaveBeenCalledOnce();
    expect(mocks.openUrl).toHaveBeenCalledWith(
      'http://127.0.0.1:58627/sessions/ses-1#token=tok-1',
    );
    const written = writeSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(written).toContain('Kimi server ready');
    expect(written).toContain('Ctrl+C');
    expect(written).toContain('/sessions/ses-1');
    writeSpy.mockRestore();
  });
});

describe('handleRemoteControlCommand', () => {
  it('stays in the TUI with a readable error when another instance holds Remote Control', async () => {
    vi.clearAllMocks();
    const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tempRoot = mkdtempSync(join(tmpdir(), 'kimi-rc-lock-'));
    const dataDir = join(tempRoot, 'home');
    mkdirSync(join(dataDir, 'server'), { recursive: true });
    writeFileSync(
      join(dataDir, 'server', 'rc.json'),
      JSON.stringify({
        pid: process.pid,
        nonce: 'holder',
        local_origin: 'http://127.0.0.1:58627',
        device_id: 'device-1',
        url: 'https://code-rc.kimi.com/devices/device-1/?rc=1&from=kimi_code_cli',
        started_at: Date.now(),
      }),
    );
    mocks.getDataDir.mockReturnValue(dataDir);
    const host = makeHost();

    try {
      await handleRemoteControlCommand(host);

      expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('already running'));
      expect(host.showError).toHaveBeenCalledWith(
        expect.stringContaining('/devices/device-1/'),
      );
      expect(host.setExitForegroundTask).not.toHaveBeenCalled();
      expect(host.stop).not.toHaveBeenCalled();
      expect(mocks.startServerForeground).not.toHaveBeenCalled();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('starts the tunnel and saves a token-free session QR code', async () => {
    vi.clearAllMocks();
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { isAbsolute, join } = await import('node:path');
    const QRCode = await import('qrcode');
    const tempRoot = mkdtempSync(join(tmpdir(), 'kimi-rc-qrcode-'));
    const dataDir = join(tempRoot, 'custom-home');
    const entryUrl =
      'https://code-rc.kimi.com/devices/device-1/?rc=1&from=kimi_code_cli';
    const sessionUrl =
      'https://code-rc.kimi.com/devices/device-1/sessions/ses-1?rc=1&from=kimi_code_cli';
    const pngPath = join(dataDir, 'rc-qrcode.png');
    mocks.getDataDir.mockReturnValue(dataDir);
    mocks.tryResolveServerToken.mockReturnValue('local-server-token');
    const close = vi.fn(async () => {});
    mocks.startRemoteControl.mockResolvedValue({
      deviceId: 'device-1',
      deviceName: 'example-device',
      url: entryUrl,
      close,
    });
    mocks.startServerForeground.mockImplementation(
      async (
        _options: unknown,
        hooks: {
          onReady?: (origin: string) => void | Promise<void>;
          onShutdown?: (reason: string) => void | Promise<void>;
        },
      ) => {
        await hooks.onReady?.('http://127.0.0.1:58627');
        await hooks.onShutdown?.('SIGINT');
      },
    );
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const host = makeHost();

    try {
      await handleRemoteControlCommand(host);
      const task = host.setExitForegroundTask.mock.calls[0]![0] as () => Promise<void>;
      await task();

      expect(mocks.startRemoteControl).toHaveBeenCalledWith(
        expect.objectContaining({
          homeDir: dataDir,
          localOrigin: 'http://127.0.0.1:58627',
          localServerToken: 'local-server-token',
        }),
      );
      expect(mocks.openUrl).toHaveBeenCalledWith(sessionUrl);
      const written = writeSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(written).toContain('Kimi Remote Control ready');
      expect(written).toContain(renderTerminalQr(sessionUrl));
      expect(written).not.toContain(renderTerminalQr(entryUrl));
      expect(isAbsolute(pngPath)).toBe(true);
      expect(written).toContain(`QR code PNG: ${pngPath}`);
      const png = readFileSync(pngPath);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png).toEqual(await QRCode.toBuffer(sessionUrl));
      expect(written).not.toContain('local-server-token');
      expect(written).not.toContain('#token=');
      expect(close).toHaveBeenCalledOnce();
    } finally {
      writeSpy.mockRestore();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('opens the device entry URL without a session instead of creating one', async () => {
    vi.clearAllMocks();
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const QRCode = await import('qrcode');
    const tempRoot = mkdtempSync(join(tmpdir(), 'kimi-rc-entry-'));
    const dataDir = join(tempRoot, 'custom-home');
    const entryUrl =
      'https://code-rc.kimi.com/devices/device-1/?rc=1&from=kimi_code_cli';
    mocks.getDataDir.mockReturnValue(dataDir);
    mocks.tryResolveServerToken.mockReturnValue('local-server-token');
    const close = vi.fn(async () => {});
    mocks.startRemoteControl.mockResolvedValue({
      deviceId: 'device-1',
      deviceName: 'example-device',
      url: entryUrl,
      close,
    });
    mocks.startServerForeground.mockImplementation(
      async (
        _options: unknown,
        hooks: {
          onReady?: (origin: string) => void | Promise<void>;
          onShutdown?: (reason: string) => void | Promise<void>;
        },
      ) => {
        await hooks.onReady?.('http://127.0.0.1:58627');
        await hooks.onShutdown?.('SIGINT');
      },
    );
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const host = makeHost();
    host.session = undefined;

    try {
      await handleRemoteControlCommand(host);

      expect(host.waitForLazyCreation).toHaveBeenCalledOnce();
      expect(host.showError).not.toHaveBeenCalled();
      expect(host.setExitForegroundTask).toHaveBeenCalledOnce();
      expect(host.stop).toHaveBeenCalledOnce();

      const task = host.setExitForegroundTask.mock.calls[0]![0] as () => Promise<void>;
      await task();

      expect(mocks.openUrl).toHaveBeenCalledWith(entryUrl);
      const written = writeSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(written).toContain(renderTerminalQr(entryUrl));
      expect(written).not.toContain('/sessions/');
      expect(readFileSync(join(dataDir, 'rc-qrcode.png'))).toEqual(
        await QRCode.toBuffer(entryUrl),
      );
      expect(close).toHaveBeenCalledOnce();
    } finally {
      writeSpy.mockRestore();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('webSessionUrl', () => {
  it('deep-links to the session under the origin', () => {
    expect(webSessionUrl('http://127.0.0.1:58627', 'abc123')).toBe(
      'http://127.0.0.1:58627/sessions/abc123',
    );
  });

  it('strips a trailing slash from the origin', () => {
    expect(webSessionUrl('http://127.0.0.1:58627/', 'abc123')).toBe(
      'http://127.0.0.1:58627/sessions/abc123',
    );
  });

  it('encodes session ids so the web UI can decode them', () => {
    expect(webSessionUrl('http://127.0.0.1:58627', 'a/b c')).toBe(
      'http://127.0.0.1:58627/sessions/a%2Fb%20c',
    );
  });

  it('carries the bearer token in the fragment so the browser authenticates on load', () => {
    expect(webSessionUrl('http://127.0.0.1:58627', 'abc123', 'tok-1')).toBe(
      'http://127.0.0.1:58627/sessions/abc123#token=tok-1',
    );
  });

  it('omits the fragment when no token is available', () => {
    expect(webSessionUrl('http://127.0.0.1:58627', 'abc123', undefined)).toBe(
      'http://127.0.0.1:58627/sessions/abc123',
    );
  });
});
