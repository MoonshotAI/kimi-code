import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

describe('browser overlay state', () => {
  it('tracks the active overlay view identity', async () => {
    const state = await import('../../../src/main/browser/browser-overlay-state');
    const view = {};
    expect(state.isBrowserOverlayView(view as never)).toBe(false);
    state.setBrowserOverlayView(view as never);
    expect(state.isBrowserOverlayView(view as never)).toBe(true);
    expect(state.isBrowserOverlayView({} as never)).toBe(false);
    state.setBrowserOverlayView(null);
    expect(state.isBrowserOverlayView(view as never)).toBe(false);
  });

  it('observes outside mouseDown once per webContents and respects the user-surface gate', async () => {
    const state = await import('../../../src/main/browser/browser-overlay-state');
    let onMouse: ((event: unknown, mouse: { type: string }) => void) | undefined;
    const on = vi.fn((_event: string, listener: typeof onMouse) => { onMouse = listener; });
    const contents = { on };
    const outside = vi.fn();
    state.onBrowserOverlayOutsidePointer(outside);

    let userSurface = false;
    state.observeBrowserOverlayOutsidePointer(contents as never, () => userSurface);
    state.observeBrowserOverlayOutsidePointer(contents as never, () => userSurface);
    expect(on).toHaveBeenCalledTimes(1);

    onMouse!({}, { type: 'mouseMove' });
    expect(outside).not.toHaveBeenCalled();
    onMouse!({}, { type: 'mouseDown' });
    expect(outside).not.toHaveBeenCalled();

    userSurface = true;
    onMouse!({}, { type: 'mouseDown' });
    expect(outside).toHaveBeenCalledTimes(1);
  });

  it('dispatches annotation overlay refresh requests to the registered handler', async () => {
    const state = await import('../../../src/main/browser/browser-overlay-state');
    expect(() => state.requestBrowserAnnotationOverlayRefresh()).not.toThrow();
    const refresh = vi.fn();
    state.onBrowserAnnotationOverlayRefresh(refresh);
    state.requestBrowserAnnotationOverlayRefresh();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
