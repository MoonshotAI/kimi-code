// @vitest-environment jsdom

import { createApp, defineComponent, h, nextTick, ref, type Ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@moonshot-ai/app-core/lib', () => ({
  isDesktop: true,
  hasDesktopBridge: () => (globalThis as { kimiDesktop?: unknown }).kimiDesktop !== undefined,
}));

import { FAVICON_KEYFRAMES, usePageTitle } from '../src/composables/usePageTitle';

function mountPageTitle(title: Ref<string>) {
  const app = createApp(
    defineComponent(() => {
      usePageTitle({ title });
      return () => h('div');
    }),
  );
  app.mount(document.createElement('div'));
  return app;
}

function stubCanvas2D() {
  const draws: string[] = [];
  let currentFill = '';
  const fakeCtx = {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    roundRect: vi.fn((x: number, y: number, w: number, h: number) => {
      draws.push(`${currentFill}:${x.toFixed(2)},${y.toFixed(2)},${w.toFixed(2)},${h.toFixed(2)}`);
    }),
    fill: vi.fn(),
    get fillStyle() {
      return currentFill;
    },
    set fillStyle(val: string) {
      currentFill = val;
    },
  } as unknown as CanvasRenderingContext2D;

  const getContextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockImplementation(() => {
      draws.length = 0;
      return fakeCtx as never;
    });

  const toDataUrlSpy = vi
    .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
    .mockImplementation(() => {
      const signature = draws.slice(-3).join('|');
      return `data:image/png;base64,${Buffer.from(signature).toString('base64')}`;
    });

  return { getContextSpy, toDataUrlSpy };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.title = '';
  document.head.innerHTML = '';
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

describe('usePageTitle', () => {
  it('keeps the static title inside the desktop shell without touching favicon', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('kimiDesktop', {});
    const link = document.createElement('link');
    link.rel = 'icon';
    link.setAttribute('href', '/favicon.ico');
    document.head.appendChild(link);

    const app = mountPageTitle(ref('Kimi Code'));

    await nextTick();
    expect(document.title).toBe('Kimi Code');
    expect(link.getAttribute('href')).toBe('/favicon.ico');
    expect(vi.getTimerCount()).toBe(0);

    app.unmount();
  });

  it('prerenders 4 frames once and steps through calm ambient keyframes with zero ongoing canvas work', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('kimiDesktop', undefined);
    const { getContextSpy, toDataUrlSpy } = stubCanvas2D();

    const link = document.createElement('link');
    link.rel = 'icon';
    link.setAttribute('href', '/favicon.ico');
    document.head.appendChild(link);

    const title = ref('proj · Fix login');
    const app = mountPageTitle(title);

    await nextTick();
    expect(document.title).toBe('proj · Fix login');
    expect(getContextSpy).toHaveBeenCalledTimes(1);
    expect(toDataUrlSpy).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(1);

    const centerHref = link.href;
    expect(centerHref.startsWith('data:image/png;base64,')).toBe(true);

    vi.advanceTimersByTime(FAVICON_KEYFRAMES[0]!.foregroundMs);
    const leftHref = link.href;
    expect(leftHref).not.toBe(centerHref);

    vi.advanceTimersByTime(FAVICON_KEYFRAMES[1]!.foregroundMs);
    const rightHref = link.href;
    expect(rightHref).not.toBe(leftHref);
    expect(rightHref).not.toBe(centerHref);

    vi.advanceTimersByTime(FAVICON_KEYFRAMES[2]!.foregroundMs);
    expect(link.href).toBe(centerHref);

    vi.advanceTimersByTime(FAVICON_KEYFRAMES[3]!.foregroundMs);
    const blinkHref = link.href;
    expect(blinkHref).not.toBe(centerHref);

    vi.advanceTimersByTime(43_000);
    expect(getContextSpy).toHaveBeenCalledTimes(1);
    expect(toDataUrlSpy).toHaveBeenCalledTimes(4);

    title.value = 'proj · Ship release';
    await nextTick();
    expect(document.title).toBe('proj · Ship release');

    app.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(link.getAttribute('href')).toBe('/favicon.ico');
  });

  it('stretches rest intervals in hidden tabs and schedules zero timers under prefers-reduced-motion', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('kimiDesktop', undefined);
    stubCanvas2D();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });

    const app = mountPageTitle(ref('Fix login'));
    await nextTick();

    const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')!;
    const centerHref = link.href;

    vi.advanceTimersByTime(3000);
    expect(link.href).toBe(centerHref);

    vi.advanceTimersByTime(3000);
    expect(link.href).not.toBe(centerHref);
    app.unmount();

    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const reducedApp = mountPageTitle(ref('Fix login'));
    await nextTick();
    expect(vi.getTimerCount()).toBe(0);
    reducedApp.unmount();
  });
});
