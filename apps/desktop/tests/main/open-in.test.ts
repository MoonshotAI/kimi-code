import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

import { listAvailableOpenInApps, openInApp, OPEN_IN_APP_IDS } from '../../src/main/open-in';

// Detection and launching are dependency-injected: tests fake the filesystem
// (`exists`), the spawn runner (`run`), and the platform instead of touching
// real /Applications or opening real windows.

const HOME = '/Users/test';

function fakeExists(paths: string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

describe('listAvailableOpenInApps', () => {
  it('returns an empty catalog on Linux (renderer hides the entry)', () => {
    expect(listAvailableOpenInApps({ platform: 'linux' })).toEqual([]);
  });

  it('always includes Finder and Terminal on macOS, even with nothing installed', () => {
    const apps = listAvailableOpenInApps({ platform: 'darwin', home: HOME, exists: () => false });
    expect(apps.map((a) => a.id)).toEqual(['finder', 'terminal']);
  });

  it('detects bundles in /Applications and ~/Applications', () => {
    const apps = listAvailableOpenInApps({
      platform: 'darwin',
      home: HOME,
      // Built with join(): the implementation joins its candidates the same
      // way, so the fake stays consistent on Windows (backslash separators).
      exists: fakeExists([join('/Applications', 'Ghostty.app'), join(HOME, 'Applications', 'Zed.app')]),
    });
    expect(apps.map((a) => a.id)).toEqual(['zed', 'finder', 'terminal', 'ghostty']);
  });

  it('keeps the catalog order stable: editors, Finder, terminals, Xcode last', () => {
    const everything = listAvailableOpenInApps({
      platform: 'darwin',
      home: HOME,
      exists: () => true,
    });
    expect(everything.map((a) => a.id)).toEqual([
      'vscode',
      'vscode-insiders',
      'cursor',
      'zed',
      'finder',
      'terminal',
      'iterm',
      'ghostty',
      'warp',
      'kitty',
      'xcode',
    ]);
    expect(everything).toContainEqual({ id: 'vscode', label: 'VS Code' });
    expect(everything).toContainEqual({ id: 'vscode-insiders', label: 'VS Code Insiders' });
    expect(everything).toContainEqual({ id: 'kitty', label: 'kitty' });
    expect(everything).toContainEqual({ id: 'iterm', label: 'iTerm2' });
  });
});

describe('openInApp', () => {
  it('rejects unknown app ids without spawning', async () => {
    const run = vi.fn();
    const result = await openInApp('emacs', '/work/dir', { platform: 'darwin', run });
    expect(result.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects unsupported platforms without spawning', async () => {
    const run = vi.fn();
    const result = await openInApp('vscode', '/work/dir', { platform: 'linux', run });
    expect(result).toEqual({ ok: false, error: 'open-in is only supported on macOS and Windows' });
    expect(run).not.toHaveBeenCalled();
  });

  it('reports a clear error when the app is not installed', async () => {
    const run = vi.fn();
    const result = await openInApp('cursor', '/work/dir', {
      platform: 'darwin',
      home: HOME,
      exists: () => false,
      run,
    });
    expect(result).toEqual({ ok: false, error: 'Cursor is not installed' });
    expect(run).not.toHaveBeenCalled();
  });

  it('opens detected bundles via `open -a <resolved app path> <dir>`', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stderr: '' });
    const result = await openInApp('ghostty', '/work/dir', {
      platform: 'darwin',
      home: HOME,
      exists: fakeExists([join(HOME, 'Applications', 'Ghostty.app')]),
      run,
    });
    expect(result).toEqual({ ok: true });
    expect(run).toHaveBeenCalledWith('open', ['-a', join(HOME, 'Applications', 'Ghostty.app'), '/work/dir']);
  });

  it('opens directories in Finder with a bare `open <dir>` (default handler)', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stderr: '' });
    await openInApp('finder', '/work/dir', { platform: 'darwin', run });
    expect(run).toHaveBeenCalledWith('open', ['/work/dir']);
  });

  it('opens Terminal via its bundle id (its .app path moves between macOS versions)', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stderr: '' });
    await openInApp('terminal', '/work/dir', { platform: 'darwin', run });
    expect(run).toHaveBeenCalledWith('open', ['-b', 'com.apple.Terminal', '/work/dir']);
  });

  it('surfaces `open` failures with the stderr text', async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, stderr: 'Unable to find application' });
    const result = await openInApp('finder', '/work/dir', { platform: 'darwin', run });
    expect(result).toEqual({ ok: false, error: 'Unable to find application' });
  });

  it('falls back to the exit code when stderr is empty', async () => {
    const run = vi.fn().mockResolvedValue({ code: 43, stderr: '' });
    const result = await openInApp('terminal', '/work/dir', { platform: 'darwin', run });
    expect(result).toEqual({ ok: false, error: 'open exited with code 43' });
  });

  it('converts spawn errors into a result instead of throwing', async () => {
    const run = vi.fn().mockRejectedValue(new Error('spawn open ENOENT'));
    const result = await openInApp('finder', '/work/dir', { platform: 'darwin', run });
    expect(result).toEqual({ ok: false, error: 'spawn open ENOENT' });
  });
});

// --- Windows -------------------------------------------------------------------

const LOCALAPPDATA = '/Users/test/AppData/Local';
const PROGRAM_FILES = '/Program Files';
const WIN_ENV = { LOCALAPPDATA, ProgramFiles: PROGRAM_FILES } as NodeJS.ProcessEnv;

const VSCODE_EXE = join(LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe');
const WT_ALIAS = join(LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe');
const GIT_BASH_EXE = join(PROGRAM_FILES, 'Git', 'git-bash.exe');

describe('listAvailableOpenInApps (win32)', () => {
  it('exports every app id supported on macOS or Windows', () => {
    const macIds = listAvailableOpenInApps({
      platform: 'darwin',
      home: HOME,
      exists: () => true,
    }).map((app) => app.id);
    const windowsIds = listAvailableOpenInApps({
      platform: 'win32',
      env: WIN_ENV,
      exists: () => true,
    }).map((app) => app.id);

    expect(OPEN_IN_APP_IDS).toEqual([...new Set([...macIds, ...windowsIds])]);
  });

  it('always includes File Explorer and a PowerShell-backed Terminal on Windows', () => {
    const apps = listAvailableOpenInApps({ platform: 'win32', env: WIN_ENV, exists: () => false });
    expect(apps).toEqual([
      { id: 'explorer', label: 'File Explorer' },
      { id: 'windows-terminal', label: 'Terminal' },
    ]);
  });

  it('detects per-user editor installs, Windows Terminal, and Git Bash', () => {
    const apps = listAvailableOpenInApps({
      platform: 'win32',
      env: WIN_ENV,
      exists: fakeExists([VSCODE_EXE, WT_ALIAS, GIT_BASH_EXE]),
    });
    expect(apps.map((a) => a.id)).toEqual([
      'vscode',
      'explorer',
      'windows-terminal',
      'git-bash',
    ]);
  });

  it('falls back to Program Files for system-wide installs', () => {
    const systemCursor = join(PROGRAM_FILES, 'Cursor', 'Cursor.exe');
    const apps = listAvailableOpenInApps({
      platform: 'win32',
      env: WIN_ENV,
      exists: fakeExists([systemCursor]),
    });
    expect(apps.map((a) => a.id)).toEqual(['cursor', 'explorer', 'windows-terminal']);
  });

  it('keeps the catalog order: editors, file manager, terminals', () => {
    const apps = listAvailableOpenInApps({ platform: 'win32', env: WIN_ENV, exists: () => true });
    expect(apps.map((a) => a.id)).toEqual([
      'vscode',
      'vscode-insiders',
      'cursor',
      'zed',
      'explorer',
      'windows-terminal',
      'git-bash',
    ]);
  });
});

describe('openInApp (win32)', () => {
  it('rejects unknown app ids (including macOS-only ones) without spawning', async () => {
    const runDetached = vi.fn();
    expect(await openInApp('emacs', '/work/dir', { platform: 'win32', runDetached })).toEqual({
      ok: false,
      error: 'unknown open-in app: emacs',
    });
    expect(await openInApp('finder', '/work/dir', { platform: 'win32', runDetached })).toEqual({
      ok: false,
      error: 'unknown open-in app: finder',
    });
    expect(runDetached).not.toHaveBeenCalled();
  });

  it('reports a clear error when the app is not installed', async () => {
    const runDetached = vi.fn();
    const result = await openInApp('zed', '/work/dir', {
      platform: 'win32',
      env: WIN_ENV,
      exists: () => false,
      runDetached,
    });
    expect(result).toEqual({ ok: false, error: 'Zed is not installed' });
    expect(runDetached).not.toHaveBeenCalled();
  });

  it('launches editors detached with the directory as the single argument', async () => {
    const runDetached = vi.fn().mockResolvedValue({ error: null });
    const result = await openInApp('vscode', '/work/dir', {
      platform: 'win32',
      env: WIN_ENV,
      exists: fakeExists([VSCODE_EXE]),
      runDetached,
    });
    expect(result).toEqual({ ok: true });
    expect(runDetached).toHaveBeenCalledWith(VSCODE_EXE, ['/work/dir'], { consoleWindow: false });
  });

  it('launches Windows Terminal via its alias with -d <dir>', async () => {
    const runDetached = vi.fn().mockResolvedValue({ error: null });
    const result = await openInApp('windows-terminal', '/work/dir', {
      platform: 'win32',
      env: WIN_ENV,
      exists: fakeExists([WT_ALIAS]),
      runDetached,
    });
    expect(result).toEqual({ ok: true });
    expect(runDetached).toHaveBeenCalledWith(WT_ALIAS, ['-d', '/work/dir'], { consoleWindow: false });
  });

  it('falls back to Windows PowerShell via `cmd /c start` when the Windows Terminal alias is unavailable', async () => {
    const runDetached = vi.fn().mockResolvedValue({ error: null });
    // Bait: a `%NAME%` segment (legal in a directory name, expanded by `cmd
    // /c` if passed inline) plus shell metacharacters.
    const targetPath = 'C:\\work\\%USERNAME%\\repo; & whoami';
    const result = await openInApp('windows-terminal', targetPath, {
      platform: 'win32',
      env: { ...WIN_ENV, SystemRoot: 'D:\\Win' },
      exists: () => false,
      runDetached,
    });
    expect(result).toEqual({ ok: true });
    // A console-subsystem exe spawned directly gets no window (DETACHED_PROCESS
    // when detached, stdin EOF otherwise) — `cmd /c start` opens the real
    // window. The directory rides in an env var so cmd's %-expansion cannot
    // mangle it, and PowerShell is absolute so `start /D <workspace>` cannot
    // resolve a same-named exe from the workspace.
    expect(runDetached).toHaveBeenCalledWith(
      'cmd.exe',
      [
        '/c',
        'start',
        '"PowerShell"',
        '/D',
        '"%KIMI_CODE_OPEN_IN_DIR%"',
        join('D:\\Win', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ],
      { consoleWindow: true, env: { KIMI_CODE_OPEN_IN_DIR: targetPath } },
    );
  });

  it('launches Git Bash at the workspace directory', async () => {
    const runDetached = vi.fn().mockResolvedValue({ error: null });
    const result = await openInApp('git-bash', '/work/dir', {
      platform: 'win32',
      env: WIN_ENV,
      exists: fakeExists([GIT_BASH_EXE]),
      runDetached,
    });
    expect(result).toEqual({ ok: true });
    expect(runDetached).toHaveBeenCalledWith(GIT_BASH_EXE, ['--cd=/work/dir'], { consoleWindow: false });
  });

  it('launches Explorer through PATH resolution', async () => {
    const runDetached = vi.fn().mockResolvedValue({ error: null });
    const result = await openInApp('explorer', '/work/dir', { platform: 'win32', runDetached });
    expect(result).toEqual({ ok: true });
    expect(runDetached).toHaveBeenCalledWith('explorer.exe', ['/work/dir'], { consoleWindow: false });
  });

  it('surfaces launcher errors as a result instead of throwing', async () => {
    const runDetached = vi.fn().mockResolvedValue({ error: 'spawn ENOENT' });
    const result = await openInApp('explorer', '/work/dir', { platform: 'win32', runDetached });
    expect(result).toEqual({ ok: false, error: 'spawn ENOENT' });
  });
});
