import { afterEach, describe, expect, it, vi } from 'vitest';

const trackMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/lib/track', () => ({ track: trackMock }));

import { pickWorkspaceDirectoryWithFallback } from '../../src/renderer/lib/nativeWorkspacePicker';

const globalRef = globalThis as { window?: unknown };
const originalWindow = globalRef.window;

afterEach(() => {
  trackMock.mockReset();
  if (originalWindow === undefined) delete globalRef.window;
  else globalRef.window = originalWindow;
});

function setBridge(bridge: unknown): void {
  globalRef.window = bridge === undefined ? {} : { kimiDesktop: bridge };
}

describe('pickWorkspaceDirectoryWithFallback tracking', () => {
  it('does not report fallback separately when the native picker is unavailable', async () => {
    setBridge(undefined);
    const fallback = vi.fn(async () => ['/fallback']);

    expect(await pickWorkspaceDirectoryWithFallback({ title: 'Add directories', fallback })).toEqual([
      '/fallback',
    ]);
    expect(fallback).toHaveBeenCalledOnce();
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('does not report fallback separately when the native pick errors', async () => {
    setBridge({
      showOpenDialog: async () => {
        throw new Error('ipc down');
      },
    });
    const fallback = vi.fn(async () => ['/fallback']);

    expect(await pickWorkspaceDirectoryWithFallback({ title: 'Add directories', fallback })).toEqual([
      '/fallback',
    ]);
    expect(fallback).toHaveBeenCalledOnce();
    expect(trackMock).not.toHaveBeenCalled();
  });

  it('stays silent on an explicit cancel', async () => {
    setBridge({ showOpenDialog: async () => ({ canceled: true, filePaths: [] }) });
    const fallback = vi.fn(async () => ['/fallback']);

    expect(await pickWorkspaceDirectoryWithFallback({ title: 'Add directories', fallback })).toEqual([]);
    expect(fallback).not.toHaveBeenCalled();
    expect(trackMock).not.toHaveBeenCalled();
  });
});
