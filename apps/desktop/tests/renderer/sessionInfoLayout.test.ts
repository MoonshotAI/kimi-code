// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';

import { sessionInfoModeForWidth, sessionInfoPanelVisible, useSessionInfoLayout } from '../../src/renderer/composables/useSessionInfoLayout';

class FakeResizeObserver {
  static current: FakeResizeObserver | undefined;
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
  constructor(private readonly callback: (entries: Array<{ contentRect: { width: number } }>) => void) {
    FakeResizeObserver.current = this;
  }
  trigger(width: number): void {
    this.callback([{ contentRect: { width } }]);
  }
}

beforeEach(() => {
  localStorage.clear();
  FakeResizeObserver.current = undefined;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('session info layout rules', () => {
  it('uses a stable 960px threshold and independent visibility inputs', () => {
    expect(sessionInfoModeForWidth(960)).toBe('sidebar');
    expect(sessionInfoModeForWidth(959)).toBe('floating');
    expect(sessionInfoPanelVisible({ enabled: true, eligible: true, activeSessionId: 's1' })).toBe(true);
    expect(sessionInfoPanelVisible({ enabled: true, eligible: true })).toBe(false);
    expect(sessionInfoPanelVisible({ enabled: true, eligible: false, activeSessionId: 's1' })).toBe(false);
    expect(sessionInfoPanelVisible({ enabled: false, eligible: true, activeSessionId: 's1' })).toBe(false);
  });

  it('only expands the floating panel explicitly and preserves the sidebar preference', async () => {
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { value: 1200, writable: true });
    const rightPanelOpen = ref(false);
    const activeSessionId = ref<string | undefined>('s1');
    const scope = effectScope();
    const layout = scope.run(() => useSessionInfoLayout({
      host: ref(host),
      activeSessionId,
      rightPanelOpen,
      eligible: ref(true),
    }))!;
    await nextTick();

    expect(layout.enabled.value).toBe(true);
    expect(layout.visible.value).toBe(true);
    expect(layout.mode.value).toBe('sidebar');
    FakeResizeObserver.current!.trigger(959);
    expect(layout.mode.value).toBe('floating');
    expect(layout.visible.value).toBe(false);
    layout.toggle();
    expect(layout.visible.value).toBe(true);
    layout.toggle();
    expect(layout.visible.value).toBe(false);
    layout.toggle();
    expect(layout.visible.value).toBe(true);
    FakeResizeObserver.current!.trigger(960);
    expect(layout.mode.value).toBe('sidebar');
    expect(layout.visible.value).toBe(true);
    FakeResizeObserver.current!.trigger(959);
    expect(layout.visible.value).toBe(false);
    FakeResizeObserver.current!.trigger(960);
    expect(layout.visible.value).toBe(true);

    rightPanelOpen.value = true;
    expect(layout.visible.value).toBe(false);
    expect(layout.enabled.value).toBe(true);
    layout.toggle();
    expect(layout.visible.value).toBe(true);
    layout.toggle();
    expect(layout.visible.value).toBe(false);
    rightPanelOpen.value = false;
    expect(layout.visible.value).toBe(true);
    rightPanelOpen.value = true;
    expect(layout.visible.value).toBe(false);
    layout.toggle();
    expect(layout.visible.value).toBe(true);
    rightPanelOpen.value = false;
    expect(layout.visible.value).toBe(true);

    layout.toggle();
    expect(layout.enabled.value).toBe(false);
    expect(localStorage.getItem('kimi-web.session-info-panel')).toBe('false');
    expect(layout.visible.value).toBe(false);
    activeSessionId.value = undefined;
    expect(layout.visible.value).toBe(false);
    scope.stop();
    expect(FakeResizeObserver.current!.disconnect).toHaveBeenCalled();
  });

  it('keeps a hidden sidebar preference after temporarily opening the floating panel', async () => {
    localStorage.setItem('kimi-web.session-info-panel', 'false');
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { value: 1200, writable: true });
    const scope = effectScope();
    const layout = scope.run(() => useSessionInfoLayout({
      host: ref(host),
      activeSessionId: ref('s1'),
      rightPanelOpen: ref(false),
      eligible: ref(true),
    }))!;
    await nextTick();

    expect(layout.visible.value).toBe(false);
    FakeResizeObserver.current!.trigger(959);
    layout.toggle();
    expect(layout.visible.value).toBe(true);
    expect(layout.enabled.value).toBe(false);
    expect(localStorage.getItem('kimi-web.session-info-panel')).toBe('false');
    layout.toggle();
    expect(layout.visible.value).toBe(false);
    FakeResizeObserver.current!.trigger(960);
    expect(layout.mode.value).toBe('sidebar');
    expect(layout.visible.value).toBe(false);
    expect(layout.enabled.value).toBe(false);
    expect(localStorage.getItem('kimi-web.session-info-panel')).toBe('false');
    scope.stop();
  });

  it('restores an explicitly hidden preference and allows enabling it for the right panel', () => {
    localStorage.setItem('kimi-web.session-info-panel', 'false');
    const scope = effectScope();
    const layout = scope.run(() => useSessionInfoLayout({
      host: ref(null),
      activeSessionId: ref('s1'),
      rightPanelOpen: ref(true),
      eligible: ref(true),
    }))!;
    expect(layout.enabled.value).toBe(false);
    expect(layout.visible.value).toBe(false);
    layout.toggle();
    expect(layout.enabled.value).toBe(true);
    expect(layout.visible.value).toBe(true);
    expect(localStorage.getItem('kimi-web.session-info-panel')).toBe('true');
    scope.stop();
  });
});
