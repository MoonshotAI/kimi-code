import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findBuiltInSlashCommand, resolveSlashCommandAvailability } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import {
  handleRemoteControlCommand,
  handleWebCommand,
  webSessionUrl,
} from '#/tui/commands/web';

const mocks = vi.hoisted(() => ({
  startServerForeground: vi.fn(),
  runRemoteControl: vi.fn(),
  tryResolveServerToken: vi.fn(),
  getDataDir: vi.fn(() => '/tmp/kimi-home'),
  openUrl: vi.fn(),
}));

vi.mock('#/cli/sub/web/remote-control', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/cli/sub/web/remote-control')>();
  return { ...actual, runRemoteControl: mocks.runRemoteControl };
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
    waitForSessionAssembly: vi.fn(async () => {}),
  } as unknown as SlashCommandHost & {
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    restoreEditor: ReturnType<typeof vi.fn>;
    setExitOpenUrl: ReturnType<typeof vi.fn>;
    setExitForegroundTask: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    waitForSessionAssembly: ReturnType<typeof vi.fn>;
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
      expect(mocks.runRemoteControl).not.toHaveBeenCalled();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('hands the active session to Remote Control after the TUI exits', async () => {
    vi.clearAllMocks();
    mocks.getDataDir.mockReturnValue('/tmp/kimi-home-without-lock');
    mocks.runRemoteControl.mockResolvedValue(undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const host = makeHost();

    try {
      await handleRemoteControlCommand(host);
      expect(host.setExitForegroundTask).toHaveBeenCalledOnce();
      expect(host.stop).toHaveBeenCalledOnce();
      expect(mocks.runRemoteControl).not.toHaveBeenCalled();

      const task = host.setExitForegroundTask.mock.calls[0]![0] as () => Promise<void>;
      await task();

      expect(mocks.runRemoteControl).toHaveBeenCalledWith(
        { open: true, sessionId: 'ses-1' },
        expect.objectContaining({ attachServer: expect.any(Function), relaunch: expect.any(Function) }),
      );
      expect(mocks.startServerForeground).not.toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      exit.mockRestore();
    }
  });

  it('opens the device entry without a session and exits non-zero when Remote Control fails', async () => {
    vi.clearAllMocks();
    mocks.getDataDir.mockReturnValue('/tmp/kimi-home-without-lock');
    mocks.runRemoteControl.mockRejectedValue(new Error('the relay rejected the device'));
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errors = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const host = makeHost();
    host.session = undefined;

    try {
      await handleRemoteControlCommand(host);
      expect(host.waitForSessionAssembly).toHaveBeenCalledOnce();
      expect(host.showError).not.toHaveBeenCalled();

      const task = host.setExitForegroundTask.mock.calls[0]![0] as () => Promise<void>;
      await task();

      expect(mocks.runRemoteControl).toHaveBeenCalledWith(
        { open: true, sessionId: undefined },
        expect.anything(),
      );
      expect(errors.mock.calls.map((call) => String(call[0])).join('')).toContain(
        'Remote Control failed: the relay rejected the device',
      );
      expect(exit.mock.calls[0]).toEqual([1]);
    } finally {
      errors.mockRestore();
      exit.mockRestore();
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
