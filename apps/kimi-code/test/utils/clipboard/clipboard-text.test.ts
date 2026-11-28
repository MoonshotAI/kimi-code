import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { clipboard } from '#/utils/clipboard/clipboard-native';
import { buildClipboardOSC52 } from '#/utils/clipboard/clipboard-osc52';
import {
  copyTextToClipboard,
  planClipboardRead,
  planClipboardWrite,
  readClipboardText,
} from '#/utils/clipboard/clipboard-text';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: vi.fn(() => {
    throw new Error('ENOENT');
  }),
}));

vi.mock('#/utils/process/resolve-command', async () => {
  const { existsSync } = await import('node:fs');
  const { isAbsolute, join, relative, resolve } = await import('node:path');
  return {
    resolveCommandPath: (command: string, cwd = process.cwd()) => {
      const directory = process.env['PATH'];
      if (!directory) return undefined;
      const candidate = resolve(join(directory, command));
      if (!existsSync(candidate)) return undefined;
      const fromCwd = relative(cwd, candidate);
      if (fromCwd !== '' && !fromCwd.startsWith('..') && !isAbsolute(fromCwd)) return undefined;
      return candidate;
    },
  };
});

vi.mock('#/utils/clipboard/clipboard-native', () => ({
  clipboard: {
    getText: vi.fn(),
    setText: vi.fn(),
  },
}));

const clipboardMock = clipboard as unknown as {
  getText: ReturnType<typeof vi.fn> | undefined;
  setText: ReturnType<typeof vi.fn> | undefined;
};
const spawnMock = vi.mocked(spawn);

const originalIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

const CLEAN_ENV = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_SESSION_TYPE',
  'TERMUX_VERSION',
  'SSH_CONNECTION',
  'SSH_CLIENT',
  'MOSH_CONNECTION',
  'KIMI_CODE_CLIPBOARD_OSC52',
  'WSL_DISTRO_NAME',
  'WSLENV',
];

function stubStdoutTTY(isTTY: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, writable: true, value: isTTY });
}

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
}

function stubEnv(env: Record<string, string>): void {
  for (const name of CLEAN_ENV) vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}

const CLIPBOARD_TOOLS = [
  'pbcopy',
  'pbpaste',
  'clip.exe',
  'termux-clipboard-set',
  'termux-clipboard-get',
  'wl-copy',
  'wl-paste',
  'xclip',
  'xsel',
  'powershell.exe',
];

function makeToolDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-clipboard-tools-'));
  for (const tool of CLIPBOARD_TOOLS) writeFileSync(join(dir, tool), '', { mode: 0o755 });
  return dir;
}

let toolDir = '';

function stubInstalledClipboardCommands(exitCodeByCommand: Record<string, number>): { command: string; input: string }[] {
  const calls: { command: string; input: string }[] = [];
  spawnMock.mockImplementation(((executable: string) => {
    const command = basename(executable);
    const child = new EventEmitter() as ChildProcess;
    const call = { command, input: '' };
    calls.push(call);
    Object.assign(child, {
      kill: vi.fn(),
      stdin: Object.assign(new EventEmitter(), {
        destroy: vi.fn(),
        end: (input: string) => {
          call.input = input;
          const code = exitCodeByCommand[command];
          setImmediate(() => {
            if (code === undefined) child.emit('error', new Error(`spawn ${command} ENOENT`));
            else child.emit('close', code);
          });
        },
      }),
    });
    return child;
  }) as unknown as typeof spawn);
  return calls;
}

function stubInstalledClipboardReaders(outputByCommand: Record<string, string | null>) {
  const calls: { command: string; args: string[] }[] = [];
  spawnMock.mockImplementation(((executable: string, args: string[]) => {
    const command = basename(executable);
    const child = new EventEmitter() as ChildProcess;
    const stdout = new EventEmitter();
    calls.push({ command, args });
    Object.assign(child, { kill: vi.fn(), stdout });
    setImmediate(() => {
      const output = outputByCommand[command];
      if (output === undefined) {
        child.emit('error', new Error(`spawn ${command} ENOENT`));
      } else {
        if (output !== null) stdout.emit('data', Buffer.from(output));
        child.emit('close', output === null ? 1 : 0);
      }
    });
    return child;
  }) as unknown as typeof spawn);
  return calls;
}

function captureStdout(): () => string {
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return () => writeSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

const powershell = {
  command: 'powershell.exe',
  args: [
    '-NoProfile',
    '-NonInteractive',
    '-STA',
    '-Command',
    'Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Out.Write([System.Windows.Forms.Clipboard]::GetText())',
  ],
};

beforeAll(() => {
  toolDir = makeToolDir();
});

beforeEach(() => {
  vi.stubEnv('PATH', toolDir);
  stubEnv({});
  stubStdoutTTY(true);
  clipboardMock.getText = vi.fn().mockResolvedValue('native text');
  clipboardMock.setText = vi.fn().mockResolvedValue(undefined);
  stubInstalledClipboardCommands({});
});

afterEach(() => {
  if (originalIsTTYDescriptor !== undefined) {
    Object.defineProperty(process.stdout, 'isTTY', originalIsTTYDescriptor);
  }
  if (originalPlatformDescriptor !== undefined) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('planClipboardWrite', () => {
  const pbcopy = { command: 'pbcopy', args: [] };
  const wlCopy = { command: 'wl-copy', args: [] };
  const xclip = { command: 'xclip', args: ['-selection', 'clipboard'] };
  const xsel = { command: 'xsel', args: ['--clipboard', '--input'] };
  const unavailable = 'Clipboard unavailable';
  const missingX11 = 'Clipboard unavailable: install `xclip` or `xsel`, or check X11 access';
  const missingWayland = 'Clipboard unavailable: install `wl-clipboard` (`wl-copy`) or check Wayland access';
  const missingTermux = 'Clipboard unavailable: install the Termux:API app and `termux-api` package';

  it.each<[string, NodeJS.Platform, NodeJS.ProcessEnv, ReturnType<typeof planClipboardWrite>]>([
    ['macOS', 'darwin', {}, { nativeModule: true, commands: [pbcopy], osc52: 'never', unavailableMessage: unavailable }],
    [
      'Windows',
      'win32',
      {},
      { nativeModule: true, commands: [{ command: 'clip.exe', args: [] }], osc52: 'never', unavailableMessage: unavailable },
    ],
    [
      'Linux X11',
      'linux',
      { DISPLAY: ':0' },
      { nativeModule: false, commands: [xclip, xsel], osc52: 'never', unavailableMessage: missingX11 },
    ],
    [
      'Linux Wayland with XWayland',
      'linux',
      { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' },
      { nativeModule: false, commands: [wlCopy, xclip, xsel], osc52: 'never', unavailableMessage: missingWayland },
    ],
    [
      'Wayland session without WAYLAND_DISPLAY',
      'linux',
      { XDG_SESSION_TYPE: 'wayland' },
      { nativeModule: false, commands: [wlCopy], osc52: 'never', unavailableMessage: missingWayland },
    ],
    [
      'Linux without a display',
      'linux',
      {},
      { nativeModule: false, commands: [], osc52: 'fallback', unavailableMessage: unavailable },
    ],
    [
      'WSLg',
      'linux',
      { WSL_DISTRO_NAME: 'Ubuntu', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' },
      { nativeModule: false, commands: [wlCopy, xclip, xsel], osc52: 'fallback', unavailableMessage: missingWayland },
    ],
    [
      'Termux',
      'android',
      { TERMUX_VERSION: '0.118' },
      {
        nativeModule: true,
        commands: [{ command: 'termux-clipboard-set', args: [] }],
        osc52: 'fallback',
        unavailableMessage: missingTermux,
      },
    ],
    [
      'SSH into Linux',
      'linux',
      { SSH_CONNECTION: '10.0.0.1 5000 10.0.0.2 22' },
      { nativeModule: false, commands: [], osc52: 'always', unavailableMessage: unavailable },
    ],
    [
      'SSH into a Linux desktop',
      'linux',
      { SSH_CLIENT: '10.0.0.1 5000 22', DISPLAY: ':0' },
      { nativeModule: false, commands: [xclip, xsel], osc52: 'always', unavailableMessage: missingX11 },
    ],
    [
      'mosh into macOS',
      'darwin',
      { MOSH_CONNECTION: '10.0.0.1' },
      { nativeModule: true, commands: [pbcopy], osc52: 'always', unavailableMessage: unavailable },
    ],
    [
      'KIMI_CODE_CLIPBOARD_OSC52=1 on a Linux desktop',
      'linux',
      { KIMI_CODE_CLIPBOARD_OSC52: '1', DISPLAY: ':0' },
      { nativeModule: false, commands: [xclip, xsel], osc52: 'always', unavailableMessage: missingX11 },
    ],
    [
      'KIMI_CODE_CLIPBOARD_OSC52=0',
      'linux',
      { KIMI_CODE_CLIPBOARD_OSC52: '0', DISPLAY: ':0' },
      { nativeModule: false, commands: [xclip, xsel], osc52: 'never', unavailableMessage: missingX11 },
    ],
  ])('%s', (_name, platform, env, expected) => {
    expect(planClipboardWrite(platform, env)).toEqual(expected);
  });
});

describe('planClipboardRead', () => {
  const unavailable = "Clipboard paste unavailable: use your terminal's paste shortcut";
  const missingX11 = 'Clipboard paste unavailable: install `xclip` or `xsel`, or check X11 access';
  const missingWayland =
    'Clipboard paste unavailable: install `wl-clipboard` (`wl-paste`) or check Wayland access';
  const pbpaste = { command: 'pbpaste', args: [] };
  const wlPaste = { command: 'wl-paste', args: ['--no-newline'] };
  const xclip = { command: 'xclip', args: ['-selection', 'clipboard', '-o'] };
  const xsel = { command: 'xsel', args: ['--clipboard', '--output'] };

  it.each<[string, NodeJS.Platform, NodeJS.ProcessEnv, ReturnType<typeof planClipboardRead>]>([
    ['macOS', 'darwin', {}, { nativeModule: true, commands: [pbpaste], unavailableMessage: unavailable }],
    ['Windows', 'win32', {}, { nativeModule: true, commands: [powershell], unavailableMessage: unavailable }],
    [
      'Linux without a display',
      'linux',
      {},
      { nativeModule: false, commands: [], unavailableMessage: unavailable },
    ],
    [
      'SSH without a display',
      'linux',
      { SSH_CONNECTION: '10.0.0.1 5000 10.0.0.2 22' },
      { nativeModule: false, commands: [], unavailableMessage: unavailable },
    ],
    [
      'Linux X11',
      'linux',
      { DISPLAY: ':0' },
      { nativeModule: false, commands: [xclip, xsel], unavailableMessage: missingX11 },
    ],
    [
      'Linux Wayland with XWayland',
      'linux',
      { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' },
      { nativeModule: false, commands: [wlPaste, xclip, xsel], unavailableMessage: missingWayland },
    ],
    [
      'WSL without a display',
      'linux',
      { WSL_DISTRO_NAME: 'Ubuntu' },
      { nativeModule: false, commands: [powershell], unavailableMessage: unavailable },
    ],
    [
      'WSLg',
      'linux',
      { WSL_DISTRO_NAME: 'Ubuntu', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' },
      {
        nativeModule: false,
        commands: [wlPaste, xclip, xsel, powershell],
        unavailableMessage: missingWayland,
      },
    ],
    [
      'Termux',
      'android',
      { TERMUX_VERSION: '0.118' },
      {
        nativeModule: true,
        commands: [{ command: 'termux-clipboard-get', args: [] }],
        unavailableMessage: 'Clipboard paste unavailable: install the Termux:API app and `termux-api` package',
      },
    ],
  ])('%s', (_name, platform, env, expected) => {
    expect(planClipboardRead(platform, env)).toEqual(expected);
  });
});

describe('readClipboardText', () => {
  it('reads text through the native clipboard when available', async () => {
    stubPlatform('darwin');

    await expect(readClipboardText()).resolves.toBe('native text');
    expect(clipboardMock.getText).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('falls back to pbpaste when native reading rejects', async () => {
    stubPlatform('darwin');
    clipboardMock.getText = vi.fn().mockRejectedValue(new Error('native failed'));
    const calls = stubInstalledClipboardReaders({ pbpaste: 'pasted text' });

    await expect(readClipboardText()).resolves.toBe('pasted text');
    expect(calls).toEqual([{ command: 'pbpaste', args: [] }]);
  });

  it('falls back to pbpaste when native reading is unavailable', async () => {
    stubPlatform('darwin');
    clipboardMock.getText = undefined;
    stubInstalledClipboardReaders({ pbpaste: 'pasted text' });

    await expect(readClipboardText()).resolves.toBe('pasted text');
  });

  it('falls back to PowerShell when native reading is unavailable on Windows', async () => {
    stubPlatform('win32');
    clipboardMock.getText = undefined;
    const calls = stubInstalledClipboardReaders({ 'powershell.exe': 'pasted text' });

    await expect(readClipboardText()).resolves.toBe('pasted text');
    expect(calls).toEqual([{ command: powershell.command, args: powershell.args }]);
    expect(spawnMock).toHaveBeenCalledWith(
      join(toolDir, 'powershell.exe'),
      powershell.args,
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'ignore'] }),
    );
  });

  it('falls back to PowerShell when native reading rejects on Windows', async () => {
    stubPlatform('win32');
    clipboardMock.getText = vi.fn().mockRejectedValue(new Error('native failed'));
    const calls = stubInstalledClipboardReaders({ 'powershell.exe': 'pasted text' });

    await expect(readClipboardText()).resolves.toBe('pasted text');
    expect(calls).toEqual([{ command: powershell.command, args: powershell.args }]);
  });

  it('reads through PowerShell on WSL without a display', async () => {
    stubPlatform('linux');
    stubEnv({ WSL_DISTRO_NAME: 'Ubuntu' });
    const calls = stubInstalledClipboardReaders({ 'powershell.exe': 'pasted text' });

    await expect(readClipboardText()).resolves.toBe('pasted text');
    expect(clipboardMock.getText).not.toHaveBeenCalled();
    expect(calls).toEqual([{ command: powershell.command, args: powershell.args }]);
  });

  it('falls back to PowerShell after WSLg clipboard tools fail', async () => {
    stubPlatform('linux');
    stubEnv({ WSL_DISTRO_NAME: 'Ubuntu', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' });
    const calls = stubInstalledClipboardReaders({
      'wl-paste': null,
      xclip: null,
      xsel: null,
      'powershell.exe': 'pasted text',
    });

    await expect(readClipboardText()).resolves.toBe('pasted text');
    expect(calls).toEqual([
      { command: 'wl-paste', args: ['--no-newline'] },
      { command: 'xclip', args: ['-selection', 'clipboard', '-o'] },
      { command: 'xsel', args: ['--clipboard', '--output'] },
      { command: powershell.command, args: powershell.args },
    ]);
  });

  it('preserves Unicode, CRLF, and trailing newlines returned by PowerShell', async () => {
    stubPlatform('linux');
    stubEnv({ WSL_DISTRO_NAME: 'Ubuntu' });
    const text = '中文 🚀\r\nsecond line\r\n';
    stubInstalledClipboardReaders({ 'powershell.exe': text });

    await expect(readClipboardText()).resolves.toBe(text);
  });

  it('returns an empty string when PowerShell reports no clipboard text', async () => {
    stubPlatform('win32');
    clipboardMock.getText = undefined;
    stubInstalledClipboardReaders({ 'powershell.exe': '' });

    await expect(readClipboardText()).resolves.toBe('');
  });

  it('does not invoke PowerShell on headless Linux outside WSL', async () => {
    stubPlatform('linux');
    const calls = stubInstalledClipboardReaders({ 'powershell.exe': 'pasted text' });

    await expect(readClipboardText()).rejects.toThrow(
      "Clipboard paste unavailable: use your terminal's paste shortcut",
    );
    expect(clipboardMock.getText).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('reads Linux X11 through CLI tools without trusting the native module', async () => {
    stubPlatform('linux');
    stubEnv({ DISPLAY: ':0' });
    const calls = stubInstalledClipboardReaders({ xclip: null, xsel: 'pasted text' });

    await expect(readClipboardText()).resolves.toBe('pasted text');
    expect(clipboardMock.getText).not.toHaveBeenCalled();
    expect(calls).toEqual([
      { command: 'xclip', args: ['-selection', 'clipboard', '-o'] },
      { command: 'xsel', args: ['--clipboard', '--output'] },
    ]);
  });

  it('preserves Unicode and newlines returned by wl-paste', async () => {
    stubPlatform('linux');
    stubEnv({ WAYLAND_DISPLAY: 'wayland-0' });
    stubInstalledClipboardReaders({ 'wl-paste': '中文\nsecond line\n' });

    await expect(readClipboardText()).resolves.toBe('中文\nsecond line\n');
  });

  it('reports an unreadable clipboard without spawning tools on headless SSH', async () => {
    stubPlatform('linux');
    stubEnv({ SSH_CONNECTION: '10.0.0.1 5000 10.0.0.2 22' });

    await expect(readClipboardText()).rejects.toThrow(
      "Clipboard paste unavailable: use your terminal's paste shortcut",
    );
    expect(clipboardMock.getText).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('copyTextToClipboard', () => {
  it('copies text with the native clipboard when available', async () => {
    stubPlatform('darwin');
    const stdout = captureStdout();

    await expect(copyTextToClipboard('cd "/tmp/proj-b"')).resolves.toBe('native');
    expect(clipboardMock.setText).toHaveBeenCalledWith('cd "/tmp/proj-b"');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(stdout()).toBe('');
  });

  it('keeps native clipboard method context when copying text', async () => {
    stubPlatform('darwin');
    clipboardMock.setText = vi.fn(function (this: unknown, text: string): void {
      expect(this).toBe(clipboardMock);
      expect(text).toBe('cd "/tmp/proj-b"');
    });

    await expect(copyTextToClipboard('cd "/tmp/proj-b"')).resolves.toBe('native');
  });

  it('falls back to pbcopy when the native clipboard fails on macOS', async () => {
    stubPlatform('darwin');
    clipboardMock.setText = vi.fn().mockRejectedValue(new Error('native failed'));
    const calls = stubInstalledClipboardCommands({ pbcopy: 0 });

    await expect(copyTextToClipboard('hello')).resolves.toBe('native');
    expect(calls).toEqual([{ command: 'pbcopy', input: 'hello' }]);
  });

  it('never trusts the native module on Linux and writes through the CLI tools', async () => {
    stubPlatform('linux');
    stubEnv({ DISPLAY: ':0' });
    const calls = stubInstalledClipboardCommands({ xsel: 0 });
    const stdout = captureStdout();

    await expect(copyTextToClipboard('hello')).resolves.toBe('native');
    expect(clipboardMock.setText).not.toHaveBeenCalled();
    expect(calls).toEqual([
      { command: 'xclip', input: 'hello' },
      { command: 'xsel', input: 'hello' },
    ]);
    expect(stdout()).toBe('');
  });

  it('still emits OSC 52 to the client terminal of a remote session after a native copy', async () => {
    stubPlatform('darwin');
    stubEnv({ SSH_CONNECTION: '10.0.0.1 5000 10.0.0.2 22' });
    const stdout = captureStdout();

    await expect(copyTextToClipboard('hello world')).resolves.toBe('native');
    expect(clipboardMock.setText).toHaveBeenCalledWith('hello world');
    expect(stdout()).toContain(`]52;c;${base64('hello world')}`);
  });

  it('reaches the client terminal of a remote session while the system clipboard is still busy', async () => {
    stubPlatform('darwin');
    stubEnv({ SSH_CONNECTION: '10.0.0.1 5000 10.0.0.2 22' });
    let finishNativeCopy = (): void => {};
    clipboardMock.setText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishNativeCopy = resolve;
        }),
    );
    const stdout = captureStdout();

    const copy = copyTextToClipboard('hello world');

    expect(stdout()).toContain(`]52;c;${base64('hello world')}`);
    finishNativeCopy();
    await expect(copy).resolves.toBe('native');
  });

  it('falls back to OSC 52 on Linux without a display', async () => {
    stubPlatform('linux');
    const stdout = captureStdout();

    await expect(copyTextToClipboard('hello world')).resolves.toBe('osc52');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(stdout()).toContain(`]52;c;${base64('hello world')}`);
  });

  it('falls back to OSC 52 under WSLg when no clipboard tool is installed', async () => {
    stubPlatform('linux');
    stubEnv({ WSL_DISTRO_NAME: 'Ubuntu', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' });
    const calls = stubInstalledClipboardCommands({});
    const stdout = captureStdout();

    await expect(copyTextToClipboard('hello')).resolves.toBe('osc52');
    expect(calls.map(({ command }) => command)).toEqual(['wl-copy', 'xclip', 'xsel']);
    expect(stdout()).toContain(`]52;c;${base64('hello')}`);
  });

  it('reports a missing X11 tool instead of trusting OSC 52 on a Linux desktop', async () => {
    stubPlatform('linux');
    stubEnv({ DISPLAY: ':0' });
    const stdout = captureStdout();

    await expect(copyTextToClipboard('hello')).rejects.toThrow(
      'Clipboard unavailable: install `xclip` or `xsel`, or check X11 access',
    );
    expect(stdout()).toBe('');
  });

  it('reports a missing Wayland tool', async () => {
    stubPlatform('linux');
    stubEnv({ WAYLAND_DISPLAY: 'wayland-0' });
    stubInstalledClipboardCommands({ 'wl-copy': 1 });

    await expect(copyTextToClipboard('hello')).rejects.toThrow(
      'Clipboard unavailable: install `wl-clipboard` (`wl-copy`) or check Wayland access',
    );
  });

  it('sends long text through OSC 52 without a size cap', async () => {
    stubPlatform('linux');
    const stdout = captureStdout();
    const text = 'x'.repeat(1_000_000);

    await expect(copyTextToClipboard(text)).resolves.toBe('osc52');
    expect(stdout()).toContain(`]52;c;${base64(text)}`);
  });

  it('spawns clipboard tools by their resolved absolute path', async () => {
    stubPlatform('darwin');
    clipboardMock.setText = vi.fn().mockRejectedValue(new Error('native failed'));
    stubInstalledClipboardCommands({ pbcopy: 0 });

    await expect(copyTextToClipboard('hello')).resolves.toBe('native');
    expect(spawnMock).toHaveBeenCalledWith(join(toolDir, 'pbcopy'), [], expect.anything());
  });

  it('never spawns a clipboard tool planted in the workspace', async () => {
    stubPlatform('linux');
    stubEnv({ DISPLAY: ':0' });
    const workspace = makeToolDir();
    vi.stubEnv('PATH', workspace);
    vi.spyOn(process, 'cwd').mockReturnValue(workspace);
    const calls = stubInstalledClipboardCommands({ xclip: 0, xsel: 0 });

    await expect(copyTextToClipboard('hello')).rejects.toThrow('install `xclip` or `xsel`');
    expect(calls).toEqual([]);
  });

  it('does not write escape sequences when stdout is not a terminal', async () => {
    stubPlatform('linux');
    stubStdoutTTY(false);
    const stdout = captureStdout();

    await expect(copyTextToClipboard('hello')).rejects.toThrow(/^Clipboard unavailable$/);
    expect(stdout()).toBe('');
  });
});

describe('buildClipboardOSC52', () => {
  it('emits a bare OSC 52 sequence outside tmux', () => {
    expect(buildClipboardOSC52('hi', false)).toBe(`\u001B]52;c;${base64('hi')}\u0007`);
  });

  it('sends both the bare sequence and the tmux passthrough form inside tmux', () => {
    expect(buildClipboardOSC52('hi', true)).toBe(
      `\u001B]52;c;${base64('hi')}\u0007\u001BPtmux;\u001B\u001B]52;c;${base64('hi')}\u0007\u001B\\`,
    );
  });
});
