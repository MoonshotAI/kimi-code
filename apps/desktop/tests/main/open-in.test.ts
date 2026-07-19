import { describe, expect, it, vi } from 'vitest';

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
  it('returns an empty catalog off macOS (renderer hides the entry)', () => {
    expect(listAvailableOpenInApps({ platform: 'linux' })).toEqual([]);
    expect(listAvailableOpenInApps({ platform: 'win32' })).toEqual([]);
  });

  it('always includes Finder and Terminal on macOS, even with nothing installed', () => {
    const apps = listAvailableOpenInApps({ platform: 'darwin', home: HOME, exists: () => false });
    expect(apps.map((a) => a.id)).toEqual(['finder', 'terminal']);
  });

  it('detects bundles in /Applications and ~/Applications', () => {
    const apps = listAvailableOpenInApps({
      platform: 'darwin',
      home: HOME,
      exists: fakeExists([
        '/Applications/Ghostty.app',
        `${HOME}/Applications/Zed.app`,
      ]),
    });
    expect(apps.map((a) => a.id)).toEqual(['zed', 'finder', 'terminal', 'ghostty']);
  });

  it('keeps the catalog order stable: editors, Finder, terminals, Xcode last', () => {
    const everything = listAvailableOpenInApps({
      platform: 'darwin',
      home: HOME,
      exists: () => true,
    });
    expect(everything.map((a) => a.id)).toEqual([...OPEN_IN_APP_IDS]);
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

  it('rejects off macOS without spawning', async () => {
    const run = vi.fn();
    const result = await openInApp('vscode', '/work/dir', { platform: 'linux', run });
    expect(result).toEqual({ ok: false, error: 'open-in is only supported on macOS' });
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
      exists: fakeExists([`${HOME}/Applications/Ghostty.app`]),
      run,
    });
    expect(result).toEqual({ ok: true });
    expect(run).toHaveBeenCalledWith('open', ['-a', `${HOME}/Applications/Ghostty.app`, '/work/dir']);
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
