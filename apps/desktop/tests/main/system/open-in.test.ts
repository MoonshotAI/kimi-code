import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listAvailableOpenInApps, openInApp, OPEN_IN_APP_IDS } from '../../../src/main/system/open-in';
import type { RegQuery } from '../../../src/main/system/win-registry';

const HOME = '/Users/test';

function fakeExists(paths: string[]): (p: string) => boolean {
  const set = new Set(paths);
  return (p) => set.has(p);
}

describe('listAvailableOpenInApps', () => {
  it('returns an empty catalog on Linux (renderer hides the entry)', async () => {
    expect(await listAvailableOpenInApps({ platform: 'linux' })).toEqual([]);
  });

  it('always includes Finder and Terminal on macOS, even with nothing installed', async () => {
    const apps = await listAvailableOpenInApps({ platform: 'darwin', home: HOME, exists: () => false });
    expect(apps.map((a) => a.id)).toEqual(['finder', 'terminal']);
  });

  it('detects bundles in /Applications and ~/Applications', async () => {
    const apps = await listAvailableOpenInApps({
      platform: 'darwin',
      home: HOME,
      exists: fakeExists([join('/Applications', 'Ghostty.app'), join(HOME, 'Applications', 'Zed.app')]),
    });
    expect(apps.map((a) => a.id)).toEqual(['zed', 'finder', 'terminal', 'ghostty']);
  });

  it('keeps the catalog order stable: editors, Finder, terminals, Xcode last', async () => {
    const everything = await listAvailableOpenInApps({
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

  it('offers Typora only for Markdown files on macOS', async () => {
    const apps = await listAvailableOpenInApps({
      platform: 'darwin',
      home: HOME,
      exists: () => true,
      filePath: '/work/notes.md',
    });
    expect(apps[0]).toEqual({ id: 'typora', label: 'Typora' });

    const other = await listAvailableOpenInApps({
      platform: 'darwin',
      home: HOME,
      exists: () => true,
      filePath: '/work/main.ts',
    });
    expect(other.map((a) => a.id)).not.toContain('typora');
  });
});

describe('openInApp', () => {
  it('opens with the system default app through the shell for the system id', async () => {
    const shell = { openPath: vi.fn().mockResolvedValue(''), showItemInFolder: vi.fn() };
    const result = await openInApp('system', '/work/dir/pic.png', { platform: 'darwin', shell, lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }) });
    expect(result).toEqual({ ok: true });
    expect(shell.openPath).toHaveBeenCalledWith('/work/dir/pic.png');
  });

  it('surfaces the shell error when the system default open fails', async () => {
    const shell = { openPath: vi.fn().mockResolvedValue('no such file'), showItemInFolder: vi.fn() };
    const result = await openInApp('system', '/work/none.png', { platform: 'win32', shell, lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }) });
    expect(result).toEqual({ ok: false, error: 'no such file' });
  });

  it('rejects directories and unsupported files for the system id without touching the shell', async () => {
    const shell = { openPath: vi.fn().mockResolvedValue(''), showItemInFolder: vi.fn() };
    expect(await openInApp('system', '/work/dir', { platform: 'darwin', shell, lstat: () => ({ isFile: () => false, isSymbolicLink: () => false }) })).toEqual({
      ok: false,
      error: 'system open only supports regular files',
    });
    expect(await openInApp('system', '/work/evil.exe', { platform: 'win32', shell, lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }) })).toEqual({
      ok: false,
      error: 'system open only supports image, HTML, Markdown, or Office document files',
    });
    expect(await openInApp('system', '/work/link.png', { platform: 'darwin', shell, lstat: () => ({ isFile: () => true, isSymbolicLink: () => true }) })).toEqual({
      ok: false,
      error: 'system open only supports regular files',
    });
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('accepts the extended image extensions for the system id', async () => {
    const shell = { openPath: vi.fn().mockResolvedValue(''), showItemInFolder: vi.fn() };
    for (const ext of ['jfif', 'tiff', 'heic', 'avif']) {
      const result = await openInApp('system', `/work/pic.${ext}`, { platform: 'darwin', shell, lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }) });
      expect(result).toEqual({ ok: true });
    }
  });

  it('accepts HTML files for the system id', async () => {
    const shell = { openPath: vi.fn().mockResolvedValue(''), showItemInFolder: vi.fn() };
    for (const ext of ['html', 'htm', 'HTML']) {
      const result = await openInApp('system', `/work/site/page.${ext}`, { platform: 'darwin', shell, lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }) });
      expect(result).toEqual({ ok: true });
    }
    expect(shell.openPath).toHaveBeenCalledTimes(3);
  });

  it('opens Markdown files with the system default app', async () => {
    const shell = { openPath: vi.fn().mockResolvedValue(''), showItemInFolder: vi.fn() };
    for (const ext of ['md', 'markdown', 'mdx', 'MD']) {
      const path = `/work/docs/README.${ext}`;
      const result = await openInApp('system', path, { platform: 'darwin', shell, lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }) });
      expect(result).toEqual({ ok: true });
      expect(shell.openPath).toHaveBeenCalledWith(path);
    }
    expect(shell.openPath).toHaveBeenCalledTimes(4);
  });

  it('opens Office documents with the system default app using the complete path', async () => {
    const shell = { openPath: vi.fn().mockResolvedValue(''), showItemInFolder: vi.fn() };
    const lstat = () => ({ isFile: () => true, isSymbolicLink: () => false });
    for (const ext of ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'DOCX']) {
      const path = ext === 'docx'
        ? '/Users/moonshot/Downloads/kimi code desktop/自研代码变更说明-KimiCode-侧边栏和session首页.docx'
        : `/work/docs/report.${ext}`;
      expect(await openInApp('system', path, { platform: 'darwin', shell, lstat })).toEqual({ ok: true });
      expect(shell.openPath).toHaveBeenLastCalledWith(path);
    }
    expect(shell.openPath).toHaveBeenCalledTimes(7);
  });

  it('rejects unknown app ids without spawning', async () => {
    const run = vi.fn();
    const result = await openInApp('emacs', '/work/dir', { platform: 'darwin', run });
    expect(result.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('opens directories with the default file manager on Linux', async () => {
    const shell = { openPath: vi.fn().mockResolvedValue(''), showItemInFolder: vi.fn() };
    const result = await openInApp('file-manager', '/work/dir', { platform: 'linux', shell, isDir: () => true });
    expect(result).toEqual({ ok: true });
    expect(shell.openPath).toHaveBeenCalledWith('/work/dir');
  });

  it('rejects files and other platforms for the Linux file manager', async () => {
    const shell = { openPath: vi.fn().mockResolvedValue(''), showItemInFolder: vi.fn() };
    expect(await openInApp('file-manager', '/work/file.txt', { platform: 'linux', shell, isDir: () => false })).toEqual({
      ok: false,
      error: 'file-manager only supports directories',
    });
    expect(await openInApp('file-manager', '/work/dir', { platform: 'darwin', shell, isDir: () => true })).toEqual({
      ok: false,
      error: 'file-manager is only supported on Linux',
    });
    expect(shell.openPath).not.toHaveBeenCalled();
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

  it('opens Markdown files with Typora when installed on macOS', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stderr: '' });
    const result = await openInApp('typora', '/work/notes.md', {
      platform: 'darwin',
      home: HOME,
      exists: fakeExists([join('/Applications', 'Typora.app')]),
      run,
    });
    expect(result).toEqual({ ok: true });
    expect(run).toHaveBeenCalledWith('open', ['-a', join('/Applications', 'Typora.app'), '/work/notes.md']);
  });

  it('opens directories in Finder with a bare `open <dir>` (default handler)', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stderr: '' });
    await openInApp('finder', '/work/dir', { platform: 'darwin', isDir: () => true, run });
    expect(run).toHaveBeenCalledWith('open', ['/work/dir']);
  });

  it('reveals files in Finder with `open -R <file>`', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stderr: '' });
    await openInApp('finder', '/work/notes.md', { platform: 'darwin', isDir: () => false, run });
    expect(run).toHaveBeenCalledWith('open', ['-R', '/work/notes.md']);
  });

  it('falls back to `open <path>` when the target cannot be stat-ed', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stderr: '' });
    await openInApp('finder', '/work/definitely-missing-path', { platform: 'darwin', run });
    expect(run).toHaveBeenCalledWith('open', ['/work/definitely-missing-path']);
  });

  it('treats a symlink to a directory as a directory (stat follows links)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'open-in-'));
    try {
      mkdirSync(join(tmp, 'real-dir'));
      symlinkSync(join(tmp, 'real-dir'), join(tmp, 'link-dir'));
      const run = vi.fn().mockResolvedValue({ code: 0, stderr: '' });
      await openInApp('finder', join(tmp, 'link-dir'), { platform: 'darwin', run });
      expect(run).toHaveBeenCalledWith('open', [join(tmp, 'link-dir')]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('opens files in browsers via `open -a <resolved app path> <file>`', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stderr: '' });
    const result = await openInApp('safari', '/work/index.html', {
      platform: 'darwin',
      home: HOME,
      exists: fakeExists([join('/Applications', 'Safari.app')]),
      run,
    });
    expect(result).toEqual({ ok: true });
    expect(run).toHaveBeenCalledWith('open', ['-a', join('/Applications', 'Safari.app'), '/work/index.html']);
  });

  it('opens pdf files in Preview from /System/Applications', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stderr: '' });
    const result = await openInApp('preview', '/work/spec.pdf', {
      platform: 'darwin',
      home: HOME,
      exists: fakeExists([join('/System/Applications', 'Preview.app')]),
      run,
    });
    expect(result).toEqual({ ok: true });
    expect(run).toHaveBeenCalledWith('open', ['-a', join('/System/Applications', 'Preview.app'), '/work/spec.pdf']);
  });

  it('reports a clear error when the browser is not installed', async () => {
    const run = vi.fn();
    const result = await openInApp('chrome', '/work/index.html', {
      platform: 'darwin',
      home: HOME,
      exists: () => false,
      run,
    });
    expect(result).toEqual({ ok: false, error: 'Chrome is not installed' });
    expect(run).not.toHaveBeenCalled();
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

const LOCALAPPDATA = '/Users/test/AppData/Local';
const PROGRAM_FILES = '/Program Files';
const WIN_ENV = { LOCALAPPDATA, ProgramFiles: PROGRAM_FILES } as NodeJS.ProcessEnv;

const VSCODE_EXE = join(LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe');
const WT_ALIAS = join(LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'wt.exe');
const GIT_BASH_EXE = join(PROGRAM_FILES, 'Git', 'git-bash.exe');

describe('listAvailableOpenInApps (win32)', () => {
  it('exports every app id supported on macOS or Windows', async () => {
    const macIds = [
      ...await listAvailableOpenInApps({
        platform: 'darwin',
        home: HOME,
        exists: () => true,
        filePath: '/work/page.html',
      }),
      ...await listAvailableOpenInApps({
        platform: 'darwin',
        home: HOME,
        exists: () => true,
        filePath: '/work/spec.pdf',
      }),
      ...await listAvailableOpenInApps({
        platform: 'darwin',
        home: HOME,
        exists: () => true,
        filePath: '/work/notes.md',
      }),
    ].map((app) => app.id);
    const windowsIds = [
      ...await listAvailableOpenInApps({
        platform: 'win32',
        env: WIN_ENV,
        exists: () => true,
        filePath: 'C:\\work\\page.html',
      }),
      ...await listAvailableOpenInApps({
        platform: 'win32',
        env: WIN_ENV,
        exists: () => true,
        filePath: 'C:\\work\\notes.md',
      }),
    ].map((app) => app.id);

    expect([...OPEN_IN_APP_IDS].sort()).toEqual([...new Set([...macIds, ...windowsIds])].sort());
  });

  it('always includes File Explorer and a PowerShell-backed Terminal on Windows', async () => {
    const apps = await listAvailableOpenInApps({ platform: 'win32', env: WIN_ENV, exists: () => false });
    expect(apps).toEqual([
      { id: 'explorer', label: 'File Explorer' },
      { id: 'windows-terminal', label: 'Terminal' },
    ]);
  });

  it('detects per-user editor installs, Windows Terminal, and Git Bash', async () => {
    const apps = await listAvailableOpenInApps({
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

  it('falls back to Program Files for system-wide installs', async () => {
    const systemCursor = join(PROGRAM_FILES, 'Cursor', 'Cursor.exe');
    const apps = await listAvailableOpenInApps({
      platform: 'win32',
      env: WIN_ENV,
      exists: fakeExists([systemCursor]),
    });
    expect(apps.map((a) => a.id)).toEqual(['cursor', 'explorer', 'windows-terminal']);
  });

  it('detects and opens Typora on Windows', async () => {
    const typoraExe = join(LOCALAPPDATA, 'Programs', 'Typora', 'Typora.exe');
    const apps = await listAvailableOpenInApps({
      platform: 'win32',
      env: WIN_ENV,
      exists: fakeExists([typoraExe]),
      filePath: 'C:\\work\\notes.md',
    });
    expect(apps[0]).toEqual({ id: 'typora', label: 'Typora' });

    const runDetached = vi.fn().mockResolvedValue({ error: null });
    const result = await openInApp('typora', 'C:\\work\\notes.md', {
      platform: 'win32',
      env: WIN_ENV,
      exists: fakeExists([typoraExe]),
      runDetached,
    });
    expect(result).toEqual({ ok: true });
    expect(runDetached).toHaveBeenCalledWith(typoraExe, ['C:\\work\\notes.md'], { consoleWindow: false });

    const systemTypora = join(PROGRAM_FILES, 'Typora', 'Typora.exe');
    const systemApps = await listAvailableOpenInApps({
      platform: 'win32',
      env: WIN_ENV,
      exists: fakeExists([systemTypora]),
      filePath: 'C:\\work\\notes.md',
    });
    expect(systemApps[0]).toEqual({ id: 'typora', label: 'Typora' });
  });

  it('keeps the catalog order: editors, file manager, terminals', async () => {
    const apps = await listAvailableOpenInApps({ platform: 'win32', env: WIN_ENV, exists: () => true });
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

describe('listAvailableOpenInApps (file extras)', () => {
  it('prepends detected browsers for html files on macOS', async () => {
    const apps = await listAvailableOpenInApps({
      platform: 'darwin',
      home: HOME,
      exists: fakeExists([join('/Applications', 'Safari.app'), join(HOME, 'Applications', 'Google Chrome.app')]),
      filePath: '/work/index.html',
    });
    expect(apps.map((a) => a.id)).toEqual(['chrome', 'safari', 'finder', 'terminal']);
    expect(apps[0]).toEqual({ id: 'chrome', label: 'Chrome', preferred: true });
    expect(apps[1]).toEqual({ id: 'safari', label: 'Safari', preferred: true });
    expect(apps[2]).toEqual({ id: 'finder', label: 'Finder' });
  });

  it('matches browser-openable extensions case-insensitively', async () => {
    const apps = await listAvailableOpenInApps({
      platform: 'darwin',
      home: HOME,
      exists: fakeExists([join('/Applications', 'Safari.app')]),
      filePath: '/work/LOGO.SVG',
    });
    expect(apps[0]).toEqual({ id: 'safari', label: 'Safari', preferred: true });
  });

  it('prepends Preview for pdf files on macOS (system apps live in /System/Applications)', async () => {
    const apps = await listAvailableOpenInApps({
      platform: 'darwin',
      home: HOME,
      exists: fakeExists([join('/System/Applications', 'Preview.app')]),
      filePath: '/work/spec.pdf',
    });
    expect(apps.map((a) => a.id)).toEqual(['preview', 'finder', 'terminal']);
    expect(apps[0]).toEqual({ id: 'preview', label: 'Preview', preferred: true });
  });

  it('offers both Preview and detected browsers for pdf files on macOS, without editors', async () => {
    const apps = await listAvailableOpenInApps({
      platform: 'darwin',
      home: HOME,
      exists: () => true,
      filePath: '/work/spec.pdf',
    });
    expect(apps.map((a) => a.id)).toEqual([
      'preview',
      'chrome',
      'safari',
      'arc',
      'edge',
      'firefox',
      'brave',
      'finder',
      'terminal',
      'iterm',
      'ghostty',
      'warp',
      'kitty',
    ]);
  });

  it('prepends Preview for image files on macOS without offering browsers', async () => {
    const apps = await listAvailableOpenInApps({
      platform: 'darwin',
      home: HOME,
      exists: () => true,
      filePath: '/work/photo.PNG',
    });
    expect(apps.map((a) => a.id)).toEqual([
      'preview',
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
  });

  it('prepends browsers for image files on Windows, except formats browsers cannot render', async () => {
    const chromeExe = join(PROGRAM_FILES, 'Google', 'Chrome', 'Application', 'chrome.exe');
    const withPng = await listAvailableOpenInApps({
      platform: 'win32',
      env: WIN_ENV,
      exists: fakeExists([chromeExe]),
      filePath: 'C:\\work\\photo.png',
    });
    expect(withPng[0]).toEqual({ id: 'chrome', label: 'Chrome', preferred: true });

    const withTiff = await listAvailableOpenInApps({
      platform: 'win32',
      env: WIN_ENV,
      exists: () => true,
      filePath: 'C:\\work\\scan.tiff',
    });
    expect(withTiff.map((a) => a.id)).toEqual([
      'vscode',
      'vscode-insiders',
      'cursor',
      'zed',
      'explorer',
      'windows-terminal',
      'git-bash',
    ]);
  });

  it('omits browsers that are not installed', async () => {
    const apps = await listAvailableOpenInApps({
      platform: 'darwin',
      home: HOME,
      exists: () => false,
      filePath: '/work/index.html',
    });
    expect(apps.map((a) => a.id)).toEqual(['finder', 'terminal']);
  });

  it('adds no extras for other extensions or when no filePath is given', async () => {
    const exists = fakeExists([join('/Applications', 'Safari.app'), join('/System/Applications', 'Preview.app')]);
    expect(
      (await listAvailableOpenInApps({ platform: 'darwin', home: HOME, exists, filePath: '/work/main.ts' })).map((a) => a.id),
    ).toEqual(['finder', 'terminal']);
    expect((await listAvailableOpenInApps({ platform: 'darwin', home: HOME, exists })).map((a) => a.id)).toEqual([
      'finder',
      'terminal',
    ]);
  });

  it('prepends detected browsers for html and pdf files on Windows', async () => {
    const chromeExe = join(PROGRAM_FILES, 'Google', 'Chrome', 'Application', 'chrome.exe');
    for (const filePath of ['C:\\work\\page.html', 'C:\\work\\spec.pdf']) {
      const apps = await listAvailableOpenInApps({
        platform: 'win32',
        env: WIN_ENV,
        exists: fakeExists([chromeExe]),
        filePath,
      });
      expect(apps[0]).toEqual({ id: 'chrome', label: 'Chrome', preferred: true });
      expect(apps.map((a) => a.id)).toContain('explorer');
    }
  });

  it('adds no browser extras for other extensions on Windows', async () => {
    const apps = await listAvailableOpenInApps({
      platform: 'win32',
      env: WIN_ENV,
      exists: () => true,
      filePath: 'C:\\work\\main.ts',
    });
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

  it('drops editors for pdf files on Windows', async () => {
    const apps = await listAvailableOpenInApps({
      platform: 'win32',
      env: WIN_ENV,
      exists: () => true,
      filePath: 'C:\\work\\spec.pdf',
    });
    expect(apps.map((a) => a.id)).toEqual([
      'chrome',
      'edge',
      'firefox',
      'brave',
      'explorer',
      'windows-terminal',
      'git-bash',
    ]);
  });

  it('detects Brave installed per-user on Windows', async () => {
    const perUserBrave = join(LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe');
    const apps = await listAvailableOpenInApps({
      platform: 'win32',
      env: WIN_ENV,
      exists: fakeExists([perUserBrave]),
      filePath: 'C:\\work\\page.html',
    });
    expect(apps[0]).toEqual({ id: 'brave', label: 'Brave', preferred: true });
  });

  it('detects Edge installed per-user on Windows', async () => {
    const perUserEdge = join(LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    const apps = await listAvailableOpenInApps({
      platform: 'win32',
      env: WIN_ENV,
      exists: fakeExists([perUserEdge]),
      filePath: 'C:\\work\\page.html',
    });
    expect(apps[0]).toEqual({ id: 'edge', label: 'Edge', preferred: true });
  });

  it('detects Firefox installed per-user on Windows', async () => {
    const perUserFirefox = join(LOCALAPPDATA, 'Mozilla Firefox', 'firefox.exe');
    const apps = await listAvailableOpenInApps({
      platform: 'win32',
      env: WIN_ENV,
      exists: fakeExists([perUserFirefox]),
      filePath: 'C:\\work\\page.html',
    });
    expect(apps[0]).toEqual({ id: 'firefox', label: 'Firefox', preferred: true });
  });

  it('treats .jfif as an image on both platforms', async () => {
    const mac = await listAvailableOpenInApps({
      platform: 'darwin',
      home: HOME,
      exists: () => true,
      filePath: '/work/photo.jfif',
    });
    expect(mac[0]).toEqual({ id: 'preview', label: 'Preview', preferred: true });

    const win = await listAvailableOpenInApps({
      platform: 'win32',
      env: WIN_ENV,
      exists: () => true,
      filePath: 'C:\\work\\photo.jfif',
    });
    expect(win[0]).toEqual({ id: 'chrome', label: 'Chrome', preferred: true });
  });

  it('detects Chrome installed per-user on Windows', async () => {
    const perUserChrome = join(LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe');
    const apps = await listAvailableOpenInApps({
      platform: 'win32',
      env: WIN_ENV,
      exists: fakeExists([perUserChrome]),
      filePath: 'C:\\work\\page.html',
    });
    expect(apps[0]).toEqual({ id: 'chrome', label: 'Chrome', preferred: true });
  });

  it('prepends Preview for avif files on macOS', async () => {
    const apps = await listAvailableOpenInApps({
      platform: 'darwin',
      home: HOME,
      exists: () => true,
      filePath: '/work/image.avif',
    });
    expect(apps[0]).toEqual({ id: 'preview', label: 'Preview', preferred: true });
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
    const targetPath = 'C:\\work\\%USERNAME%\\repo; & whoami';
    const result = await openInApp('windows-terminal', targetPath, {
      platform: 'win32',
      env: { ...WIN_ENV, SystemRoot: 'D:\\Win' },
      exists: () => false,
      runDetached,
    });
    expect(result).toEqual({ ok: true });
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

  it('opens the header workspace directory through the native shell', async () => {
    const shell = { openPath: vi.fn().mockResolvedValue(''), showItemInFolder: vi.fn() };
    const runDetached = vi.fn();
    const targetPath = 'D:\\Projects\\Zhulong.DGC.Person';
    const result = await openInApp('explorer', targetPath, {
      platform: 'win32', isDir: () => true, shell, runDetached,
    });
    expect(result).toEqual({ ok: true });
    expect(shell.openPath).toHaveBeenCalledWith(targetPath);
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect(runDetached).not.toHaveBeenCalled();
  });

  it('reveals preview files through the native shell', async () => {
    const shell = { openPath: vi.fn(), showItemInFolder: vi.fn() };
    const result = await openInApp('explorer', 'C:\\work\\notes.md', {
      platform: 'win32',
      isDir: () => false,
      shell,
    });
    expect(result).toEqual({ ok: true });
    expect(shell.showItemInFolder).toHaveBeenCalledWith('C:\\work\\notes.md');
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it.each([
    ['D:\\OpenSource\\kimi-code-app/hello.ts', 'D:\\OpenSource\\kimi-code-app\\hello.ts', false],
    ['C:/work/中文 folder/notes.md', 'C:\\work\\中文 folder\\notes.md', false],
    ['//server/share/project/notes.md', '\\\\server\\share\\project\\notes.md', false],
    ['D:\\OpenSource/kimi-code-app', 'D:\\OpenSource\\kimi-code-app', true],
  ])('normalizes Explorer target %s', async (input, normalized, directory) => {
    const shell = { openPath: vi.fn().mockResolvedValue(''), showItemInFolder: vi.fn() };
    const isDir = vi.fn().mockReturnValue(directory);
    expect(await openInApp('explorer', input, {
      platform: 'win32',
      isDir,
      shell,
    })).toEqual({ ok: true });
    expect(isDir).toHaveBeenCalledWith(normalized);
    expect(directory ? shell.openPath : shell.showItemInFolder).toHaveBeenCalledWith(normalized);
  });

  it.each([
    ['D:\\OpenSource\\kimi-code-app/notes.md', 'D:\\OpenSource\\kimi-code-app\\notes.md'],
    ['C:/work/中文 folder/notes.md', 'C:\\work\\中文 folder\\notes.md'],
    ['//server/share/project/notes.md', '\\\\server\\share\\project\\notes.md'],
  ])('normalizes the system default-open target %s', async (input, normalized) => {
    const shell = { openPath: vi.fn().mockResolvedValue(''), showItemInFolder: vi.fn() };
    const lstat = vi.fn().mockReturnValue({ isFile: () => true, isSymbolicLink: () => false });
    expect(await openInApp('system', input, { platform: 'win32', shell, lstat })).toEqual({ ok: true });
    expect(lstat).toHaveBeenCalledWith(normalized);
    expect(shell.openPath).toHaveBeenCalledWith(normalized);
  });

  it('returns native directory opening failures', async () => {
    const shell = { openPath: vi.fn().mockResolvedValue('Failed to open path'), showItemInFolder: vi.fn() };
    expect(await openInApp('explorer', 'D:\\Projects\\Zhulong.DGC.Person', {
      platform: 'win32', isDir: () => true, shell,
    })).toEqual({ ok: false, error: 'Failed to open path' });
  });

  it('does not open Explorer when the target cannot be statted', async () => {
    const shell = { openPath: vi.fn(), showItemInFolder: vi.fn() };
    const result = await openInApp('explorer', 'D:\\missing', {
      platform: 'win32', shell, isDir: () => { throw new Error('ENOENT'); },
    });
    expect(result).toEqual({ ok: false, error: 'ENOENT' });
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it('launches browsers with the file as the single argument', async () => {
    const runDetached = vi.fn().mockResolvedValue({ error: null });
    const chromeExe = join(PROGRAM_FILES, 'Google', 'Chrome', 'Application', 'chrome.exe');
    const result = await openInApp('chrome', 'C:\\work\\page.html', {
      platform: 'win32',
      env: WIN_ENV,
      exists: fakeExists([chromeExe]),
      runDetached,
    });
    expect(result).toEqual({ ok: true });
    expect(runDetached).toHaveBeenCalledWith(chromeExe, ['C:\\work\\page.html'], { consoleWindow: false });
  });

  it('surfaces launcher errors as a result instead of throwing', async () => {
    const runDetached = vi.fn().mockResolvedValue({ error: 'spawn ENOENT' });
    const result = await openInApp('vscode', '/work/dir', {
      platform: 'win32', env: WIN_ENV, exists: fakeExists([VSCODE_EXE]), runDetached,
    });
    expect(result).toEqual({ ok: false, error: 'spawn ENOENT' });
  });
});

const CUSTOM_VSCODE_DIR = '/T/Microsoft VS Code';
const CUSTOM_VSCODE_EXE = join(CUSTOM_VSCODE_DIR, 'Code.exe');
const APP_PATHS_CODE_HKCU = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe';
const VSCODE_USER_UNINSTALL_KEY =
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{F8A2A208-72B3-4D61-95FC-8A65D340689B}_is1';
const GIT_INSTALL_KEY = 'HKLM\\SOFTWARE\\GitForWindows';

function fakeQueryReg(entries: Record<string, string>): RegQuery {
  return async (key, valueName) => entries[`${key}::${valueName ?? ''}`] ?? null;
}

describe('win32 custom install dir fallback', () => {
  it('detects VS Code through App Paths when fixed paths miss', async () => {
    const apps = await listAvailableOpenInApps({
      platform: 'win32',
      env: WIN_ENV,
      exists: fakeExists([CUSTOM_VSCODE_EXE]),
      queryReg: fakeQueryReg({ [`${APP_PATHS_CODE_HKCU}::`]: CUSTOM_VSCODE_EXE }),
    });
    expect(apps.map((a) => a.id)).toContain('vscode');
  });

  it('falls back to the uninstall InstallLocation when App Paths has no entry', async () => {
    const apps = await listAvailableOpenInApps({
      platform: 'win32',
      env: WIN_ENV,
      exists: fakeExists([CUSTOM_VSCODE_EXE]),
      queryReg: fakeQueryReg({ [`${VSCODE_USER_UNINSTALL_KEY}::InstallLocation`]: CUSTOM_VSCODE_DIR }),
    });
    expect(apps.map((a) => a.id)).toContain('vscode');
  });

  it('ignores registry entries whose target no longer exists', async () => {
    const apps = await listAvailableOpenInApps({
      platform: 'win32',
      env: WIN_ENV,
      exists: () => false,
      queryReg: fakeQueryReg({ [`${APP_PATHS_CODE_HKCU}::`]: CUSTOM_VSCODE_EXE }),
    });
    expect(apps.map((a) => a.id)).not.toContain('vscode');
  });

  it('finds VS Code through PATH when the registry has nothing', async () => {
    const apps = await listAvailableOpenInApps({
      platform: 'win32',
      env: { ...WIN_ENV, Path: join(CUSTOM_VSCODE_DIR, 'bin') },
      exists: fakeExists([join(CUSTOM_VSCODE_DIR, 'bin', 'code.cmd'), CUSTOM_VSCODE_EXE]),
      queryReg: fakeQueryReg({}),
    });
    expect(apps.map((a) => a.id)).toContain('vscode');
  });

  it('skips stale PATH shims whose editor binary is gone and finds the later valid entry', async () => {
    const staleBin = '/stale/bin';
    const goodExe = join('/good/Microsoft VS Code', 'Code.exe');
    const apps = await listAvailableOpenInApps({
      platform: 'win32',
      env: { ...WIN_ENV, Path: `${staleBin};${join('/good/Microsoft VS Code', 'bin')}` },
      exists: fakeExists([
        join(staleBin, 'code.cmd'),
        join('/good/Microsoft VS Code', 'bin', 'code.cmd'),
        goodExe,
      ]),
      queryReg: fakeQueryReg({}),
    });
    expect(apps.map((a) => a.id)).toContain('vscode');

    const runDetached = vi.fn().mockResolvedValue({ error: null });
    await openInApp('vscode', '/work/dir', {
      platform: 'win32',
      env: { ...WIN_ENV, Path: `${staleBin};${join('/good/Microsoft VS Code', 'bin')}` },
      exists: fakeExists([
        join(staleBin, 'code.cmd'),
        join('/good/Microsoft VS Code', 'bin', 'code.cmd'),
        goodExe,
      ]),
      queryReg: fakeQueryReg({}),
      runDetached,
    });
    expect(runDetached).toHaveBeenCalledWith(goodExe, ['/work/dir'], { consoleWindow: false });
  });

  it('expands environment variables in registry values before checking existence', async () => {
    const registryValue = '%custom_apps%/Microsoft VS Code/Code.exe';
    const apps = await listAvailableOpenInApps({
      platform: 'win32',
      env: { ...WIN_ENV, CUSTOM_APPS: '/T' },
      exists: fakeExists([CUSTOM_VSCODE_EXE]),
      queryReg: fakeQueryReg({ [`${APP_PATHS_CODE_HKCU}::`]: registryValue }),
    });
    expect(apps.map((a) => a.id)).toContain('vscode');

    const runDetached = vi.fn().mockResolvedValue({ error: null });
    await openInApp('vscode', '/work/dir', {
      platform: 'win32',
      env: { ...WIN_ENV, CUSTOM_APPS: '/T' },
      exists: fakeExists([CUSTOM_VSCODE_EXE]),
      queryReg: fakeQueryReg({ [`${APP_PATHS_CODE_HKCU}::`]: registryValue }),
      runDetached,
    });
    expect(runDetached).toHaveBeenCalledWith(CUSTOM_VSCODE_EXE, ['/work/dir'], { consoleWindow: false });
  });

  it('detects Git Bash through the GitForWindows install key', async () => {
    const customGitBash = join('/T/Git', 'git-bash.exe');
    const apps = await listAvailableOpenInApps({
      platform: 'win32',
      env: WIN_ENV,
      exists: fakeExists([customGitBash]),
      queryReg: fakeQueryReg({ [`${GIT_INSTALL_KEY}::InstallPath`]: '/T/Git' }),
    });
    expect(apps.map((a) => a.id)).toContain('git-bash');
  });

  it('detects per-user Git installs through the HKCU GitForWindows key', async () => {
    const customGitBash = join('/T/Git', 'git-bash.exe');
    const apps = await listAvailableOpenInApps({
      platform: 'win32',
      env: WIN_ENV,
      exists: fakeExists([customGitBash]),
      queryReg: fakeQueryReg({ 'HKCU\\SOFTWARE\\GitForWindows::InstallPath': '/T/Git' }),
    });
    expect(apps.map((a) => a.id)).toContain('git-bash');
  });

  it('opens VS Code from a custom install dir resolved via the registry', async () => {
    const runDetached = vi.fn().mockResolvedValue({ error: null });
    const result = await openInApp('vscode', '/work/dir', {
      platform: 'win32',
      env: WIN_ENV,
      exists: fakeExists([CUSTOM_VSCODE_EXE]),
      queryReg: fakeQueryReg({ [`${APP_PATHS_CODE_HKCU}::`]: CUSTOM_VSCODE_EXE }),
      runDetached,
    });
    expect(result).toEqual({ ok: true });
    expect(runDetached).toHaveBeenCalledWith(CUSTOM_VSCODE_EXE, ['/work/dir'], { consoleWindow: false });
  });
});
