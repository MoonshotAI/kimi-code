// @vitest-environment jsdom
import { createApp, defineComponent, h, inject, nextTick, onMounted, reactive, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { HistoryStateKey } from '@moonshot-ai/app-core/contracts';
import { useTranscriptScroll, type TranscriptScroll } from '@moonshot-ai/app-client/composables';
import TranscriptList from '../src/chat/TranscriptList.vue';

const VIEWPORT = 300;
const WIDTH = 600;

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

const rowHeights = new Map<string, number>();
let scroller: HTMLElement;
let rawTop = 0;
let app: App | null = null;
let scroll: TranscriptScroll;
const props = reactive<{ scope: string; items: string[]; renderAll: boolean }>({ scope: 's1', items: [], renderAll: false });
const stateMap = new Map<string, unknown>();
const injectedStates = new Map<string, Map<string, unknown>[]>();

function list(): HTMLElement | null {
  return scroller.querySelector<HTMLElement>('.transcript-list');
}

function heightOf(el: Element): number {
  const html = el as HTMLElement;
  if (html.classList.contains('transcript-measure')) return 0;
  if (html.classList.contains('transcript-space')) return parseFloat(html.style.height) || 0;
  const key = html.dataset?.rowKey;
  return key === undefined ? 0 : rowHeights.get(key) ?? 100;
}

function listHeight(): number {
  const root = list();
  if (!root) return 0;
  let total = 0;
  for (const child of root.children) total += heightOf(child);
  return total;
}

function offsetInList(el: Element): number {
  let top = 0;
  for (let node = el.previousElementSibling; node; node = node.previousElementSibling) top += heightOf(node);
  return top;
}

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, left: 0, right: WIDTH, width: WIDTH, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

function maxTop(): number {
  return Math.max(0, listHeight() - VIEWPORT);
}

function rectOf(el: Element): DOMRect {
  if (el === scroller) return rect(0, VIEWPORT);
  const root = list();
  if (!root || !root.contains(el)) return rect(0, 0);
  if (el === root) return rect(-rawTop, listHeight());
  const child = el.parentElement === root ? el : el.closest<HTMLElement>('[data-row-key]');
  if (!child) return rect(0, 0);
  return rect(-rawTop + offsetInList(child), heightOf(child));
}

function sizeOf(el: Element): Size {
  if (!el.isConnected) return { block: 0, inline: 0 };
  if (el === scroller) return { block: VIEWPORT, inline: WIDTH };
  return { block: heightOf(el), inline: WIDTH };
}

function flushResize(): number {
  let callbacks = 0;
  for (let pass = 0; pass < 6; pass++) {
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
      if (entries.length) {
        callbacks++;
        observer.callback(entries, observer as unknown as ResizeObserver);
      }
    }
  }
  return callbacks;
}

let frames: FrameRequestCallback[] = [];

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await nextTick();
    flushResize();
    await nextTick();
    const pending = frames;
    frames = [];
    for (const callback of pending) callback(performance.now());
  }
}

function renderedKeys(): string[] {
  return [...scroller.querySelectorAll<HTMLElement>('[data-row-key]')].map(el => el.dataset.rowKey!);
}

function rowEl(key: string): HTMLElement | null {
  return scroller.querySelector<HTMLElement>(`[data-row-key="${key}"]`);
}

function keys(prefix: string, from: number, to: number): string[] {
  return Array.from({ length: to - from }, (_, i) => `${prefix}${from + i}`);
}

async function userScrollTo(top: number): Promise<void> {
  scroll.onInput(new WheelEvent('wheel', { deltaY: top < rawTop ? -100 : 100 }));
  rawTop = Math.max(0, Math.min(top, maxTop()));
  scroll.onScroll();
  await settle();
}

const RowState = defineComponent({
  props: { id: { type: String, required: true } },
  setup(componentProps) {
    const state = inject(HistoryStateKey)!;
    onMounted(() => {
      const seen = injectedStates.get(componentProps.id) ?? [];
      seen.push(state);
      injectedStates.set(componentProps.id, seen);
    });
    return () => h('div', { class: 'body' }, componentProps.id);
  },
});

let selectionListeners = 0;

beforeEach(async () => {
  FakeResizeObserver.instances = [];
  frames = [];
  rawTop = 0;
  rowHeights.clear();
  stateMap.clear();
  injectedStates.clear();
  props.scope = 's1';
  props.items = keys('a', 0, 50);
  props.renderAll = false;
  selectionListeners = 0;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return rectOf(this);
  });
  const addListener = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === 'selectionchange') selectionListeners++;
    addListener(type, listener, options);
  });
  scroller = document.createElement('div');
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, get: () => VIEWPORT },
    clientWidth: { configurable: true, get: () => WIDTH },
    offsetWidth: { configurable: true, get: () => WIDTH },
    scrollHeight: { configurable: true, get: () => Math.max(VIEWPORT, listHeight()) },
    scrollTop: { configurable: true, get: () => rawTop, set: (value: number) => { rawTop = Math.max(0, Math.min(value, maxTop())); } },
  });
  document.body.append(scroller);
  app = createApp(defineComponent({
    setup() {
      scroll = useTranscriptScroll({
        sessionId: () => props.scope,
        controller: { reducedMotion: () => true, supportsScrollEnd: false, fontScale: () => 'medium' },
      });
      onMounted(() => scroll.bindScroller(scroller));
      return () => h('div', { class: 'content-wrap' }, [
        h(TranscriptList<string>, {
          key: props.scope,
          scope: props.scope,
          state: stateMap,
          items: props.items,
          itemKey: (item: string) => item,
          estimate: () => 100,
          renderAll: props.renderAll,
        }, { default: ({ item }: { item: string }) => h(RowState, { id: item }) }),
      ]);
    },
  }));
  app.use(createKimiI18n({ locale: 'en' }));
  const mountPoint = document.createElement('div');
  scroller.append(mountPoint);
  app.mount(mountPoint);
  await settle();
});

afterEach(() => {
  app?.unmount();
  app = null;
  scroller.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TranscriptList', () => {
  it('renders only the rows around the viewport and sizes the placeholder from the model', async () => {
    expect(rawTop).toBe(50 * 100 - VIEWPORT);
    expect(renderedKeys()).toEqual(keys('a', 38, 50));
    const spacer = list()!.querySelector<HTMLElement>('.transcript-space')!;
    expect(spacer.style.height).toBe('3800px');
    expect(scroll.following.value).toBe(true);
  });

  it('keeps rendered rows and the reading position when older rows are prepended', async () => {
    await userScrollTo(4000);
    expect(scroll.following.value).toBe(false);
    const row = rowEl('a41')!;
    const before = row.getBoundingClientRect().top;
    props.items = [...keys('b', 0, 10), ...props.items];
    await settle();
    expect(rowEl('a41')).toBe(row);
    expect(row.getBoundingClientRect().top).toBe(before);
  });

  it('keeps the focused row mounted when it scrolls out of the window', async () => {
    const row = rowEl('a45')!;
    row.focus();
    row.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await settle();
    await userScrollTo(0);
    expect(renderedKeys()).toContain('a0');
    expect(rowEl('a45')).toBe(row);
  });

  it('renders every row while renderAll is on', async () => {
    props.renderAll = true;
    await settle();
    expect(renderedKeys()).toHaveLength(50);
    expect(list()!.querySelectorAll('.transcript-space')).toHaveLength(0);
    props.renderAll = false;
    await settle();
    expect(renderedKeys().length).toBeLessThan(50);
  });

  it('exposes list semantics and keyboard navigation between rows', async () => {
    const row = rowEl('a45')!;
    expect(list()!.getAttribute('role')).toBe('list');
    expect(row.getAttribute('role')).toBe('listitem');
    expect(row.getAttribute('aria-posinset')).toBe('46');
    expect(row.getAttribute('aria-setsize')).toBe('50');
    row.querySelector<HTMLElement>('.history-previous')!.click();
    await settle();
    expect(document.activeElement).toBe(rowEl('a44'));
    expect(rowEl('a49')!.querySelector('.history-next')).toBeNull();
  });

  it('keeps per-row state across unmount and remount', async () => {
    await userScrollTo(0);
    expect(rowEl('a45')).toBeNull();
    await userScrollTo(maxTop());
    const seen = injectedStates.get('a45')!;
    expect(seen.length).toBe(2);
    expect(seen[1]).toBe(seen[0]);
  });

  it('uses one resize observer and one set of document listeners', () => {
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(selectionListeners).toBe(1);
  });
});

describe('useTranscriptScroll', () => {
  it('shows the jump pill once the user scrolls far from the bottom', async () => {
    expect(scroll.showJump.value).toBe(false);
    await userScrollTo(1000);
    expect(scroll.following.value).toBe(false);
    expect(scroll.showJump.value).toBe(true);
    scroll.follow();
    await settle();
    expect(scroll.following.value).toBe(true);
    expect(rawTop).toBe(maxTop());
  });

  it('restores each session position on the first frame after switching back', async () => {
    await userScrollTo(2000);
    const anchor = renderedKeys().find(key => rowEl(key)!.getBoundingClientRect().bottom > 0)!;
    const before = rowEl(anchor)!.getBoundingClientRect().top;
    props.scope = 's2';
    props.items = keys('c', 0, 20);
    await settle();
    expect(scroll.following.value).toBe(true);
    expect(rawTop).toBe(maxTop());
    props.scope = 's1';
    props.items = keys('a', 0, 50);
    await nextTick();
    expect(rowEl(anchor)).not.toBeNull();
    expect(flushResize()).toBeGreaterThan(0);
    expect(rowEl(anchor)!.getBoundingClientRect().top).toBe(before);
    expect(scroll.following.value).toBe(false);
  });
});
