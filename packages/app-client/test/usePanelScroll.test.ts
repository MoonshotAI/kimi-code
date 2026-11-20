// @vitest-environment jsdom
import { createApp, defineComponent, h, KeepAlive, nextTick, reactive, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScrollSnapshot } from '@moonshot-ai/app-core/lib';
import { usePanelScroll, type PanelScroll } from '../src/composables';

const VIEWPORT = 200;
const WIDTH = 400;

type Size = { block: number; inline: number };

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed = new Map<Element, Size | null>();
  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element): void { this.observed.set(el, null); }
  unobserve(el: Element): void { this.observed.delete(el); }
  disconnect(): void { this.observed.clear(); }
}

const state = reactive({ rows: [] as { key: string; height: number }[], identity: 'a', shown: true, mounted: true });
let rawTop = 0;
let app: App | null = null;
let scroll: PanelScroll;
let snapshots: Map<string, ScrollSnapshot>;
let frames: FrameRequestCallback[] = [];

function scroller(): HTMLElement {
  return document.querySelector<HTMLElement>('.scroller')!;
}

function contentHeight(): number {
  return state.rows.reduce((sum, row) => sum + row.height, 0);
}

function maxTop(): number {
  return Math.max(0, contentHeight() - VIEWPORT);
}

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, left: 0, right: WIDTH, width: WIDTH, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

function rowTop(key: string): number {
  let top = 0;
  for (const row of state.rows) {
    if (row.key === key) return top;
    top += row.height;
  }
  return top;
}

function rectOf(el: Element): DOMRect {
  if (!el.isConnected) return rect(0, 0);
  const html = el as HTMLElement;
  if (html.classList.contains('scroller')) return rect(0, VIEWPORT);
  if (html.classList.contains('content')) return rect(-rawTop, contentHeight());
  const row = html.closest<HTMLElement>('[data-row-key]');
  if (!row) return rect(0, 0);
  const key = row.dataset.rowKey!;
  const height = state.rows.find(item => item.key === key)?.height ?? 0;
  if (html === row) return rect(-rawTop + rowTop(key), height);
  return rect(-rawTop + rowTop(key) + 10, 20);
}

function sizeOf(el: Element): Size {
  if (!el.isConnected) return { block: 0, inline: 0 };
  return { block: rectOf(el).height, inline: WIDTH };
}

function flushResize(): void {
  for (let pass = 0; pass < 4; pass++) {
    for (const observer of FakeResizeObserver.instances) {
      const entries: ResizeObserverEntry[] = [];
      for (const [target, last] of observer.observed) {
        const size = sizeOf(target);
        if (last && last.block === size.block && last.inline === size.inline) continue;
        observer.observed.set(target, size);
        entries.push({
          target,
          borderBoxSize: [{ blockSize: size.block, inlineSize: size.inline }],
          contentBoxSize: [{ blockSize: size.block, inlineSize: size.inline }],
          contentRect: { width: size.inline, height: size.block },
        } as unknown as ResizeObserverEntry);
      }
      if (entries.length) observer.callback(entries, observer as unknown as ResizeObserver);
    }
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await nextTick();
    flushResize();
    const pending = frames;
    frames = [];
    for (const callback of pending) callback(0);
  }
}

async function userScrollTo(top: number): Promise<void> {
  scroller().dispatchEvent(new WheelEvent('wheel', { deltaY: top < rawTop ? -100 : 100, bubbles: true }));
  rawTop = Math.max(0, Math.min(top, maxTop()));
  scroll.onScroll();
  await settle();
}

function offsetOf(key: string): number {
  return rectOf(scroller().querySelector(`[data-row-key="${key}"]`)!).top;
}

async function grow(key: string, by: number): Promise<void> {
  const row = state.rows.find(item => item.key === key)!;
  row.height += by;
  await settle();
}

const Panel = defineComponent({
  name: 'Panel',
  setup() {
    scroll = usePanelScroll({
      identity: () => state.identity,
      snapshots,
      controller: { reducedMotion: () => true, supportsScrollEnd: false, fontScale: () => 'medium' },
    });
    return () => h('div', { ref: scroll.scroller, class: 'scroller', onScroll: scroll.onScroll }, [
      h('div', { class: 'content' }, state.rows.map(row => h('div', { key: row.key, 'data-row-key': row.key }, [h('button', { class: 'toggle' })]))),
    ]);
  },
});

function mount(): void {
  app = createApp(defineComponent(() => () => state.mounted ? h(KeepAlive, null, [state.shown ? h(Panel) : h('div', { class: 'other' })]) : null));
  const host = document.createElement('div');
  document.body.append(host);
  app.mount(host);
}

beforeEach(() => {
  FakeResizeObserver.instances = [];
  frames = [];
  rawTop = 0;
  snapshots = new Map();
  state.rows = Array.from({ length: 20 }, (_, i) => ({ key: `r${i}`, height: 100 }));
  state.identity = 'a';
  state.shown = true;
  state.mounted = true;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return rectOf(this);
  });
  Object.defineProperties(HTMLElement.prototype, {
    scrollHeight: { configurable: true, get(this: HTMLElement) { return this.classList.contains('scroller') && this.isConnected ? Math.max(VIEWPORT, contentHeight()) : 0; } },
    clientHeight: { configurable: true, get(this: HTMLElement) { return this.classList.contains('scroller') && this.isConnected ? VIEWPORT : 0; } },
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains('scroller') && this.isConnected ? rawTop : 0; },
      set(this: HTMLElement, value: number) { if (this.classList.contains('scroller') && this.isConnected) rawTop = Math.max(0, Math.min(value, maxTop())); },
    },
  });
});

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const key of ['scrollHeight', 'clientHeight', 'scrollTop']) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
});

describe('usePanelScroll', () => {
  it('follows growth at the bottom and keeps the reading row in place when content above grows', async () => {
    mount();
    await settle();
    expect(rawTop).toBe(maxTop());
    await grow('r19', 150);
    expect(rawTop).toBe(maxTop());
    expect(scroll.following.value).toBe(true);

    await userScrollTo(800);
    expect(scroll.following.value).toBe(false);
    const before = offsetOf('r8');
    await grow('r2', 240);
    expect(offsetOf('r8')).toBe(before);
    await grow('r19', 300);
    expect(offsetOf('r8')).toBe(before);
    expect(scroll.showJump.value).toBe(true);

    scroll.follow();
    await settle();
    expect(rawTop).toBe(maxTop());
    expect(scroll.following.value).toBe(true);
  });

  it('holds a clicked control while the row above it changes height', async () => {
    mount();
    await settle();
    await userScrollTo(1000);
    const toggle = scroller().querySelector<HTMLElement>('[data-row-key="r11"] .toggle')!;
    const before = rectOf(toggle).top;
    scroll.hold(toggle);
    await grow('r10', 180);
    expect(rectOf(toggle).top).toBe(before);
  });

  it('restores the reading position when a kept-alive panel is shown again', async () => {
    mount();
    await settle();
    await userScrollTo(900);
    const before = offsetOf('r10');
    state.shown = false;
    await settle();
    state.rows[3]!.height += 260;
    state.rows.push({ key: 'r20', height: 100 });
    state.shown = true;
    await settle();
    expect(offsetOf('r10')).toBe(before);
    expect(scroll.following.value).toBe(false);
  });

  it('restores a remounted panel from the shared snapshot store and follows unknown identities', async () => {
    mount();
    await settle();
    await userScrollTo(700);
    const before = offsetOf('r7');
    state.mounted = false;
    await settle();
    expect(snapshots.get('a')?.mode).toBe('anchored');
    state.rows[1]!.height += 120;
    state.mounted = true;
    await settle();
    expect(offsetOf('r7')).toBe(before);

    state.identity = 'b';
    await settle();
    expect(rawTop).toBe(maxTop());
    state.identity = 'a';
    await settle();
    expect(offsetOf('r7')).toBe(before);
  });

  it('writes scrollTop once per correction and disables native scroll anchoring', async () => {
    mount();
    await settle();
    expect(scroller().style.overflowAnchor).toBe('none');
    const writes: number[] = [];
    await userScrollTo(500);
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop')!;
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get(this: HTMLElement) { return descriptor.get!.call(this) as number; },
      set(this: HTMLElement, value: number) {
        writes.push(value);
        descriptor.set!.call(this, value);
      },
    });
    await grow('r1', 50);
    expect(writes).toHaveLength(1);
  });
});
