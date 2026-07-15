// apps/desktop/src/renderer/lib/nativeWorkspacePicker.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canPickWorkspaceDirectory,
  createAddWorkspaceEntry,
  pickWorkspaceDirectory,
} from './nativeWorkspacePicker';

// Renderer tests run in the node environment, so there is no real `window`;
// each test installs just enough of it to stand in for the preload bridge.
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
    // The desktop preload exposes the whole API unconditionally; presence of
    // the bridge object itself is the only signal we check.
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

  it('returns the chosen directory and requests a single-directory pick', async () => {
    let received: Record<string, unknown> | undefined;
    setBridge({
      showOpenDialog: async (opts: Record<string, unknown>) => {
        received = opts;
        return { canceled: false, filePaths: ['/Users/x/project'] };
      },
    });
    const picked = await pickWorkspaceDirectory({ title: 'Add workspace' });
    expect(picked).toEqual({ status: 'picked', path: '/Users/x/project' });
    expect(received?.title).toBe('Add workspace');
    expect(received?.properties).toEqual(['openDirectory', 'createDirectory']);
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

describe('createAddWorkspaceEntry', () => {
  function makeDeps(overrides: Partial<Parameters<typeof createAddWorkspaceEntry>[0]> = {}) {
    return {
      canPick: vi.fn(() => true),
      pick: vi.fn(async () => ({ status: 'picked', path: '/picked/dir' }) as const),
      add: vi.fn(async () => true),
      openFallbackDialog: vi.fn(),
      dropPending: vi.fn(),
      reportError: vi.fn(),
      ...overrides,
    };
  }

  it('opens the in-app dialog without picking when the bridge is unavailable', async () => {
    const deps = makeDeps({ canPick: vi.fn(() => false) });
    await createAddWorkspaceEntry(deps)();
    expect(deps.openFallbackDialog).toHaveBeenCalledOnce();
    expect(deps.pick).not.toHaveBeenCalled();
    expect(deps.dropPending).not.toHaveBeenCalled();
  });

  it('adds the picked path and leaves the pending queue alone', async () => {
    const deps = makeDeps();
    await createAddWorkspaceEntry(deps)();
    expect(deps.add).toHaveBeenCalledWith('/picked/dir');
    expect(deps.dropPending).not.toHaveBeenCalled();
    expect(deps.openFallbackDialog).not.toHaveBeenCalled();
    expect(deps.reportError).not.toHaveBeenCalled();
  });

  it('drops the pending submission when the user cancels', async () => {
    const deps = makeDeps({ pick: vi.fn(async () => ({ status: 'canceled' }) as const) });
    await createAddWorkspaceEntry(deps)();
    expect(deps.dropPending).toHaveBeenCalledOnce();
    expect(deps.add).not.toHaveBeenCalled();
    expect(deps.openFallbackDialog).not.toHaveBeenCalled();
  });

  it('falls back to the dialog with an error when the bridge fails', async () => {
    const deps = makeDeps({ pick: vi.fn(async () => ({ status: 'error' }) as const) });
    await createAddWorkspaceEntry(deps)();
    expect(deps.reportError).toHaveBeenCalledOnce();
    expect(deps.openFallbackDialog).toHaveBeenCalledOnce();
    expect(deps.dropPending).not.toHaveBeenCalled();
    expect(deps.add).not.toHaveBeenCalled();
  });

  it('falls back to the dialog with an error when the daemon rejects the path', async () => {
    const deps = makeDeps({ add: vi.fn(async () => false) });
    await createAddWorkspaceEntry(deps)();
    expect(deps.add).toHaveBeenCalledWith('/picked/dir');
    expect(deps.reportError).toHaveBeenCalledOnce();
    expect(deps.openFallbackDialog).toHaveBeenCalledOnce();
    expect(deps.dropPending).not.toHaveBeenCalled();
  });

  it('ignores re-entry while a pick is already in flight', async () => {
    let releasePick: (() => void) | undefined;
    const deps = makeDeps({
      pick: vi.fn(
        () =>
          new Promise<{ status: 'picked'; path: string }>((resolve) => {
            releasePick = () => resolve({ status: 'picked', path: '/picked/dir' });
          }),
      ),
    });
    const entry = createAddWorkspaceEntry(deps);
    const first = entry();
    const second = entry();
    releasePick?.();
    await Promise.all([first, second]);
    expect(deps.pick).toHaveBeenCalledOnce();
    expect(deps.add).toHaveBeenCalledOnce();
  });
});
