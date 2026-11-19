import { afterEach, describe, expect, it, vi } from 'vitest';
import { openInNativeApp, openTextFileInNative } from '../../src/renderer/lib/nativeOpenIn';

const globalRef = globalThis as { window?: unknown };
const originalWindow = globalRef.window;

afterEach(() => {
  if (originalWindow === undefined) delete globalRef.window;
  else globalRef.window = originalWindow;
});

function bridgeWithTrack(openInApp: () => Promise<{ ok: boolean; error?: string }>) {
  const spy = vi.fn<(event: string, properties?: Record<string, unknown>) => void>();
  globalRef.window = {
    kimiDesktop: {
      listOpenInApps: async () => [{ id: 'vscode', label: 'VS Code' }],
      openInApp,
      track: spy,
    },
  };
  return spy;
}

describe('openInNativeApp tracking', () => {
  it('emits open_in on a successful open', async () => {
    const spy = bridgeWithTrack(async () => ({ ok: true }));
    expect(await openInNativeApp('vscode', '/work/dir')).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('native_feature_used', { feature: 'open_in' });
  });

  it('stays silent when the main process reports a failure', async () => {
    const spy = bridgeWithTrack(async () => ({ ok: false, error: 'not installed' }));
    expect(await openInNativeApp('vscode', '/work/dir')).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('opens a text file in the first installed editor', async () => {
    const openInApp = vi.fn(async () => ({ ok: true }));
    globalRef.window = {
      kimiDesktop: {
        listOpenInApps: async () => [
          { id: 'finder', label: 'Finder' },
          { id: 'zed', label: 'Zed' },
        ],
        openInApp,
      },
    };
    expect(await openTextFileInNative('/Users/me/.ssh/config')).toBe(true);
    expect(openInApp).toHaveBeenCalledExactlyOnceWith('zed', '/Users/me/.ssh/config');
  });

  it('does not fall back to system open when no editor is installed', async () => {
    const openInApp = vi.fn(async () => ({ ok: true }));
    globalRef.window = {
      kimiDesktop: {
        listOpenInApps: async () => [{ id: 'finder', label: 'Finder' }],
        openInApp,
      },
    };
    expect(await openTextFileInNative('/Users/me/.ssh/config')).toBe(false);
    expect(openInApp).not.toHaveBeenCalled();
  });

  it('stays silent when the IPC call rejects', async () => {
    const spy = bridgeWithTrack(async () => Promise.reject(new Error('ipc down')));
    expect(await openInNativeApp('vscode', '/work/dir')).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
