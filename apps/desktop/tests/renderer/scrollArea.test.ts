// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ScrollArea from '../../../../packages/app-ui/src/components/ui/ScrollArea.vue';

let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

function mount(props: Record<string, unknown> | null = null): HTMLElement {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({
    render: () => h(ScrollArea as never, props, { default: () => h('div', 'content') }),
  });
  app.mount(host);
  const el = host.querySelector<HTMLElement>('.ui-scroll-area__viewport');
  expect(el).not.toBeNull();
  return el!;
}

function mockMetrics(el: HTMLElement, client: number, content: number): void {
  Object.defineProperty(el, 'clientHeight', { value: client, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { value: content, configurable: true });
}

function thumb(): HTMLElement {
  const el = host.querySelector<HTMLElement>('.ui-scroll-area__thumb');
  expect(el).not.toBeNull();
  return el!;
}

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.unstubAllGlobals();
});

describe('ScrollArea track inset', () => {
  it('keeps the thumb inside the track at bottom scroll with a custom inset', async () => {
    const el = mount();
    mockMetrics(el, 200, 600);
    el.style.setProperty('--ui-scroll-area-track-inset', '12px');
    el.scrollTop = 400;
    el.dispatchEvent(new Event('scroll'));
    await nextTick();
    const t = thumb();
    const size = Number.parseFloat(t.style.height);
    const offset = Number.parseFloat(t.style.transform.match(/translateY\(([\d.]+)px\)/)?.[1] ?? '0');
    expect(size).toBeCloseTo(58.67, 1);
    expect(offset + size).toBeLessThanOrEqual(200 - 12 * 2 + 0.01);
  });

  it('uses the default 2px inset when the variable is unset', async () => {
    const el = mount();
    mockMetrics(el, 200, 600);
    el.scrollTop = 400;
    el.dispatchEvent(new Event('scroll'));
    await nextTick();
    const t = thumb();
    const size = Number.parseFloat(t.style.height);
    const offset = Number.parseFloat(t.style.transform.match(/translateY\(([\d.]+)px\)/)?.[1] ?? '0');
    expect(size).toBeCloseTo(65.33, 1);
    expect(offset).toBeCloseTo(130.67, 1);
  });
});

describe('ScrollArea overscroll', () => {
  it('contains scroll chaining by default', () => {
    const el = mount();
    expect(el.style.getPropertyValue('overscroll-behavior')).toBe('contain');
  });

  it('lets scrolling chain to the page when overscroll is auto', () => {
    const el = mount({ overscroll: 'auto' });
    expect(el.style.getPropertyValue('overscroll-behavior')).toBe('auto');
  });
});
