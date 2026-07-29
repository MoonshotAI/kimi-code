import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAddWorkspaceEntry } from '../../src/renderer/lib/nativeWorkspacePicker';

// native_feature_used ('workspace_picker') tracking on the add-workspace entry
// flow: the native picker success carries no flag, every landing in the
// in-app fallback dialog carries fallback: true, and an explicit cancel is
// silent. The flow behavior itself is covered by the colocated
// src/renderer/lib/nativeWorkspacePicker.test.ts.
const globalRef = globalThis as { window?: unknown };
const originalWindow = globalRef.window;

afterEach(() => {
  if (originalWindow === undefined) delete globalRef.window;
  else globalRef.window = originalWindow;
});

function trackSpy() {
  const spy = vi.fn<(event: string, properties?: Record<string, unknown>) => void>();
  globalRef.window = { kimiDesktop: { track: spy } };
  return spy;
}

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

describe('createAddWorkspaceEntry tracking', () => {
  it('marks fallback when the native picker is unavailable', async () => {
    const spy = trackSpy();
    const deps = makeDeps({ canPick: vi.fn(() => false) });
    await createAddWorkspaceEntry(deps)();
    expect(deps.openFallbackDialog).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('native_feature_used', { feature: 'workspace_picker', fallback: true });
  });

  it('marks fallback when the native pick errors', async () => {
    const spy = trackSpy();
    const deps = makeDeps({ pick: vi.fn(async () => ({ status: 'error' }) as const) });
    await createAddWorkspaceEntry(deps)();
    expect(deps.openFallbackDialog).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('native_feature_used', { feature: 'workspace_picker', fallback: true });
  });

  it('marks fallback when the daemon rejects the picked path', async () => {
    const spy = trackSpy();
    const deps = makeDeps({ add: vi.fn(async () => false) });
    await createAddWorkspaceEntry(deps)();
    expect(deps.openFallbackDialog).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('native_feature_used', { feature: 'workspace_picker', fallback: true });
  });

  it('reports a plain native-picker success without the fallback flag', async () => {
    const spy = trackSpy();
    const deps = makeDeps();
    await createAddWorkspaceEntry(deps)();
    expect(deps.add).toHaveBeenCalledWith('/picked/dir');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('native_feature_used', { feature: 'workspace_picker' });
  });

  it('stays silent on an explicit cancel', async () => {
    const spy = trackSpy();
    const deps = makeDeps({ pick: vi.fn(async () => ({ status: 'canceled' }) as const) });
    await createAddWorkspaceEntry(deps)();
    expect(deps.dropPending).toHaveBeenCalledOnce();
    expect(spy).not.toHaveBeenCalled();
  });
});
