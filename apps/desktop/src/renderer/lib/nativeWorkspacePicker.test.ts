import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canPickWorkspaceDirectory,
  pickWorkspaceDirectory,
  pickWorkspaceDirectoryWithFallback,
} from './nativeWorkspacePicker';

const globalRef = globalThis as { window?: unknown };
const originalWindow = globalRef.window;

afterEach(() => {
  if (originalWindow === undefined) {
    delete globalRef.window;
  } else {
    globalRef.window = originalWindow;
  }
});

function setBridge(bridge: unknown): void {
  globalRef.window = bridge === undefined ? {} : { kimiDesktop: bridge };
}

describe('canPickWorkspaceDirectory', () => {
  it('is false when the desktop bridge is absent (not running in Electron)', () => {
    setBridge(undefined);
    expect(canPickWorkspaceDirectory()).toBe(false);
  });

  it('is true whenever the preload bridge is injected', () => {
    setBridge({});
    expect(canPickWorkspaceDirectory()).toBe(true);
  });

  it('is true when the bridge exposes showOpenDialog', () => {
    setBridge({ showOpenDialog: async () => ({ canceled: true, filePaths: [] }) });
    expect(canPickWorkspaceDirectory()).toBe(true);
  });
});

describe('pickWorkspaceDirectory', () => {
  it('reports an error when the desktop bridge is absent', async () => {
    setBridge(undefined);
    expect(await pickWorkspaceDirectory({ title: 'Add workspace' })).toEqual({ status: 'error' });
  });

  it('reports an error when the bridge lacks showOpenDialog (call throws)', async () => {
    setBridge({});
    expect(await pickWorkspaceDirectory({ title: 'Add workspace' })).toEqual({ status: 'error' });
  });

  it('reports cancellation when the user cancels the native dialog', async () => {
    setBridge({ showOpenDialog: async () => ({ canceled: true, filePaths: [] }) });
    expect(await pickWorkspaceDirectory({ title: 'Add workspace' })).toEqual({ status: 'canceled' });
  });

  it('reports cancellation when the dialog comes back with no paths', async () => {
    setBridge({ showOpenDialog: async () => ({ canceled: false, filePaths: [] }) });
    expect(await pickWorkspaceDirectory({ title: 'Add workspace' })).toEqual({ status: 'canceled' });
  });

  it('returns the chosen directories and requests a multi-select directory pick', async () => {
    let received: Record<string, unknown> | undefined;
    setBridge({
      showOpenDialog: async (opts: Record<string, unknown>) => {
        received = opts;
        return { canceled: false, filePaths: ['/Users/x/project', '/Users/x/lib'] };
      },
    });
    const picked = await pickWorkspaceDirectory({ title: 'Add workspace' });
    expect(picked).toEqual({ status: 'picked', paths: ['/Users/x/project', '/Users/x/lib'] });
    expect(received?.title).toBe('Add workspace');
    expect(received?.properties).toEqual(['openDirectory', 'createDirectory', 'multiSelections']);
  });

  it('reports an error when the bridge call rejects', async () => {
    setBridge({
      showOpenDialog: async () => {
        throw new Error('ipc down');
      },
    });
    expect(await pickWorkspaceDirectory({ title: 'Add workspace' })).toEqual({ status: 'error' });
  });
});

describe('pickWorkspaceDirectoryWithFallback', () => {
  it('returns native selections without invoking the fallback', async () => {
    setBridge({
      showOpenDialog: async () => ({ canceled: false, filePaths: ['/native/a', '/native/b'] }),
    });
    const fallback = vi.fn(async () => ['/fallback']);

    expect(await pickWorkspaceDirectoryWithFallback({ title: 'Add directories', fallback })).toEqual([
      '/native/a',
      '/native/b',
    ]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('uses the fallback when the desktop bridge is unavailable', async () => {
    setBridge(undefined);
    const fallback = vi.fn(async () => ['/fallback/a', '/fallback/b']);

    expect(await pickWorkspaceDirectoryWithFallback({ title: 'Add directories', fallback })).toEqual([
      '/fallback/a',
      '/fallback/b',
    ]);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('uses the fallback when the native picker fails', async () => {
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
  });

  it('returns cancellation without invoking the fallback', async () => {
    setBridge({ showOpenDialog: async () => ({ canceled: true, filePaths: [] }) });
    const fallback = vi.fn(async () => ['/fallback']);

    expect(await pickWorkspaceDirectoryWithFallback({ title: 'Add directories', fallback })).toEqual([]);
    expect(fallback).not.toHaveBeenCalled();
  });
});
