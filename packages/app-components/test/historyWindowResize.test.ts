// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, provide, shallowRef, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { HistoryScrollKey, HistoryStateKey } from '@moonshot-ai/app-core/contracts';
import HistoryWindow from '../src/chat/HistoryWindow.vue';

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element): void { this.observed.add(el); }
  unobserve(el: Element): void { this.observed.delete(el); }
  disconnect(): void { this.observed.clear(); }
  fire(targets: Element[]): void {
    const entries = targets.map(target => ({ target, contentRect: target === scroller ? { width: scrollerWidth, height: scrollerHeight } : { width: 600, height: 0 } }) as ResizeObserverEntry);
    this.callback(entries, this as unknown as ResizeObserver);
  }
}

const items = ['a', 'b', 'c', 'd', 'e'];
const rowHeights = new Map<string, number>();
let frames: FrameRequestCallback[] = [];
let app: App | null = null;
let scroller: HTMLElement;
let scrollerWidth = 600;
let scrollerHeight = 300;
let rootTop = -250;
let adjust: ReturnType<typeof vi.fn>;

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, left: 0, right: 600, width: 600, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

function row(key: string): HTMLElement {
  return scroller.querySelector<HTMLElement>(`[data-history-key="${key}"]`)!;
}

function root(): HTMLElement {
  return scroller.querySelector<HTMLElement>('.history-window')!;
}

function observer(): FakeResizeObserver {
  return FakeResizeObserver.instances.find(instance => instance.observed.has(scroller))!;
}

async function runFrames(): Promise<void> {
  while (frames.length) {
    const pending = frames;
    frames = [];
    for (const callback of pending) callback(performance.now());
    await nextTick();
  }
}

function resizeScroller(): void {
  scrollerWidth -= 20;
}

beforeEach(async () => {
  FakeResizeObserver.instances = [];
  frames = [];
  scrollerWidth = 600;
  scrollerHeight = 300;
  rootTop = -250;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  for (const key of items) rowHeights.set(key, 100);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const key = (this as HTMLElement).dataset?.historyKey;
    if (key !== undefined) return rect(0, rowHeights.get(key) ?? 0);
    if (this === scroller) return rect(0, scrollerHeight);
    if (this.classList.contains('history-window')) return rect(rootTop, 500);
    return rect(0, 0);
  });
  scroller = document.createElement('div');
  scroller.className = 'panes';
  Object.defineProperty(scroller, 'clientHeight', { get: () => scrollerHeight });
  document.body.append(scroller);
  adjust = vi.fn();
  app = createApp(defineComponent({
    setup() {
      provide(HistoryScrollKey, adjust);
      return () => h(HistoryWindow, { items, itemKey: (item: string) => item, enabled: true, estimate: () => 100 }, {
        default: ({ item }: { item: string }) => h('div', item),
      });
    },
  }));
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(scroller);
  await runFrames();
  observer().fire([scroller, root(), ...items.map(row)]);
  await runFrames();
});

afterEach(() => {
  app?.unmount();
  app = null;
  scroller.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('HistoryWindow resize handling', () => {
  it('keeps the reading position in the same frame while the scroller resizes', async () => {
    resizeScroller();
    rowHeights.set('a', 150);
    observer().fire([scroller, row('a')]);
    await nextTick();
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(adjust).toHaveBeenCalledWith(scroller, 50);
    await runFrames();
    expect(adjust).toHaveBeenCalledTimes(1);
  });

  it('releases the held history height in the same frame while the scroller resizes', async () => {
    expect(root().style.minHeight).toBe('500px');
    resizeScroller();
    rowHeights.set('e', 60);
    observer().fire([scroller, row('e')]);
    expect(root().style.minHeight).toBe('460px');
    await runFrames();
    expect(root().style.minHeight).toBe('460px');
  });

  it('compensates later changes in the resize frame only once', async () => {
    resizeScroller();
    rowHeights.set('a', 150);
    observer().fire([scroller, row('a')]);
    rowHeights.set('a', 170);
    observer().fire([row('a')]);
    await nextTick();
    expect(adjust.mock.calls.map(call => call[1])).toEqual([50, 20]);
    await runFrames();
    expect(adjust.mock.calls.map(call => call[1])).toEqual([50, 20]);
    expect(root().style.minHeight).toBe('570px');
  });

  it('keeps the reading position in the same frame when a row above it resizes', async () => {
    rowHeights.set('a', 150);
    observer().fire([row('a')]);
    await nextTick();
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(adjust).toHaveBeenCalledWith(scroller, 50);
    expect(root().style.minHeight).toBe('500px');
    await runFrames();
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(root().style.minHeight).toBe('550px');
  });

  it('leaves the reading position alone when a row below it resizes', async () => {
    rowHeights.set('e', 60);
    observer().fire([row('e')]);
    await nextTick();
    expect(adjust).not.toHaveBeenCalled();
    expect(root().style.minHeight).toBe('500px');
    await runFrames();
    expect(adjust).not.toHaveBeenCalled();
    expect(root().style.minHeight).toBe('460px');
  });

  it('treats the first scroller observation of a new window as no resize', async () => {
    const created = FakeResizeObserver.instances.length;
    app?.unmount();
    app = createApp(defineComponent({
      setup() {
        provide(HistoryScrollKey, adjust);
        return () => h(HistoryWindow, { items, itemKey: (item: string) => item, enabled: true, estimate: () => 100 }, {
          default: ({ item }: { item: string }) => h('div', item),
        });
      },
    }));
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(scroller);
    await runFrames();
    const fresh = FakeResizeObserver.instances.slice(created).find(instance => instance.observed.has(scroller))!;
    rowHeights.set('a', 150);
    fresh.fire([scroller, row('a')]);
    await nextTick();
    expect(adjust).toHaveBeenCalledWith(scroller, 50);
    expect(root().style.minHeight).toBe('500px');
  });

  it('fills the taller viewport when only the scroller grows', async () => {
    const created = FakeResizeObserver.instances.length;
    const many = Array.from({ length: 20 }, (_, index) => `row-${index}`);
    for (const key of many) rowHeights.set(key, 100);
    app?.unmount();
    app = createApp(defineComponent({
      setup() {
        provide(HistoryScrollKey, adjust);
        return () => h(HistoryWindow, { items: many, itemKey: (item: string) => item, enabled: true, estimate: () => 100 }, {
          default: ({ item }: { item: string }) => h('div', item),
        });
      },
    }));
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(scroller);
    await runFrames();
    const fresh = FakeResizeObserver.instances.slice(created).find(instance => instance.observed.has(scroller))!;
    fresh.fire([scroller, root(), ...many.map(row).filter(Boolean)]);
    await runFrames();
    const rendered = () => scroller.querySelectorAll('[data-history-key]').length;
    expect(rendered()).toBe(11);
    scrollerHeight = 900;
    fresh.fire([scroller]);
    await nextTick();
    expect(adjust).not.toHaveBeenCalled();
    await runFrames();
    expect(rendered()).toBe(20);
    expect(root().style.minHeight).toBe('2000px');
  });

  async function mountList(list: ReturnType<typeof shallowRef<string[]>>): Promise<FakeResizeObserver> {
    const created = FakeResizeObserver.instances.length;
    app?.unmount();
    app = createApp(defineComponent({
      setup() {
        provide(HistoryScrollKey, adjust);
        return () => h(HistoryWindow, { items: list.value, itemKey: (item: string) => item, enabled: true, estimate: () => 100 }, {
          default: ({ item }: { item: string }) => h('div', item),
        });
      },
    }));
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(scroller);
    await runFrames();
    const fresh = FakeResizeObserver.instances.slice(created).find(instance => instance.observed.has(scroller))!;
    fresh.fire([scroller, root(), ...list.value.map(row)]);
    await runFrames();
    return fresh;
  }

  it('compensates prepended rows itself from measured heights before the observer reports them', async () => {
    const list = shallowRef(['c', 'd', 'e', 'f', 'g']);
    for (const key of ['a', 'b', ...list.value]) rowHeights.set(key, 100);
    rowHeights.set('a', 150);
    const fresh = await mountList(list);
    list.value = ['a', 'b', ...list.value];
    rootTop = -302;
    for (let i = 0; i < 4; i++) await nextTick();
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(adjust).toHaveBeenCalledWith(scroller, 198);
    expect(root().style.minHeight).toBe('750px');
    fresh.fire([scroller, row('a'), row('b')]);
    await nextTick();
    await runFrames();
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(root().style.minHeight).toBe('750px');
  });

  it('anchors on the first surviving row when the old first row disappears with the prepend', async () => {
    const list = shallowRef(['c', 'd', 'e', 'f', 'g']);
    for (const key of ['a', 'b', ...list.value]) rowHeights.set(key, 100);
    rowHeights.set('a', 150);
    await mountList(list);
    list.value = ['a', 'b', 'd', 'e', 'f', 'g'];
    for (let i = 0; i < 4; i++) await nextTick();
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(adjust).toHaveBeenCalledWith(scroller, 150);
    expect(root().style.minHeight).toBe('650px');
    expect(row('c')).toBeNull();
  });

  it('anchors on the next surviving row when the row at the viewport top disappears', async () => {
    rootTop = -50;
    const list = shallowRef(['c', 'd', 'e', 'f', 'g']);
    for (const key of ['a', 'b', ...list.value]) rowHeights.set(key, 100);
    rowHeights.set('a', 150);
    rowHeights.set('b', 120);
    await mountList(list);
    list.value = ['a', 'b', 'd', 'e', 'f', 'g'];
    for (let i = 0; i < 4; i++) await nextTick();
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(adjust).toHaveBeenCalledWith(scroller, 170);
    expect(root().style.minHeight).toBe('670px');
  });

  it('settles newly entering overscan rows in one scroll adjustment when prepended rows are shorter than estimated', async () => {
    const initial = ['k', 'l', 'm', 'n', 'o'];
    const prepended = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
    for (const key of initial) rowHeights.set(key, 100);
    for (const key of prepended) rowHeights.set(key, 40);
    const list = shallowRef(initial);
    const fresh = await mountList(list);
    list.value = [...prepended, ...list.value];
    for (let i = 0; i < 6; i++) await nextTick();
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(adjust).toHaveBeenCalledWith(scroller, 560);
    fresh.fire([scroller, row('p4'), row('p5'), row('p6'), row('p7')]);
    await nextTick();
    await runFrames();
    expect(adjust).toHaveBeenCalledTimes(1);
  });

  it('compensates content above the window changing height', async () => {
    rootTop = -302;
    observer().fire([scroller]);
    await nextTick();
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(adjust).toHaveBeenCalledWith(scroller, -52);
    observer().fire([scroller]);
    await nextTick();
    expect(adjust).toHaveBeenCalledTimes(1);
    rootTop = -250;
    rowHeights.set('a', 150);
    observer().fire([scroller, row('a')]);
    await nextTick();
    expect(adjust).toHaveBeenCalledTimes(2);
    expect(adjust).toHaveBeenLastCalledWith(scroller, 102);
    await runFrames();
    expect(root().style.minHeight).toBe('550px');
  });

  it('holds the history height only at the outermost window', async () => {
    const host = document.createElement('div');
    host.className = 'panes';
    document.body.append(host);
    const nestedApp = createApp(defineComponent({
      setup() {
        provide(HistoryStateKey, new Map());
        return () => h(HistoryWindow, { items, itemKey: (item: string) => item, enabled: true, estimate: () => 100 }, {
          default: ({ item }: { item: string }) => h('div', item),
        });
      },
    }));
    nestedApp.use(createKimiI18n({ locale: 'en' }));
    nestedApp.mount(host);
    await nextTick();
    expect(root().style.minHeight).toBe('500px');
    expect(host.querySelector<HTMLElement>('.history-window')!.style.minHeight).toBe('');
    nestedApp.unmount();
    host.remove();
  });

  it('keeps the row that owns an open dialog mounted while the dialog has focus outside the row', async () => {
    const created = FakeResizeObserver.instances.length;
    const many = Array.from({ length: 30 }, (_, index) => `row-${index}`);
    for (const key of many) rowHeights.set(key, 100);
    rootTop = -2500;
    app?.unmount();
    app = createApp(defineComponent({
      setup() {
        provide(HistoryScrollKey, adjust);
        return () => h(HistoryWindow, { items: many, itemKey: (item: string) => item, enabled: true, estimate: () => 100 }, {
          default: ({ item }: { item: string }) => h('div', item),
        });
      },
    }));
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(scroller);
    await runFrames();
    const fresh = FakeResizeObserver.instances.slice(created).find(instance => instance.observed.has(scroller))!;
    fresh.fire([scroller, root(), ...many.map(row).filter(Boolean)]);
    await runFrames();

    const target = row('row-25');
    expect(target).not.toBeNull();
    const button = document.createElement('button');
    const dialog = document.createElement('div');
    dialog.id = 'reply-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.tabIndex = -1;
    scroller.append(dialog);
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', dialog.id);
    button.setAttribute('aria-expanded', 'true');
    target.append(button);
    dialog.focus();
    await runFrames();

    rootTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    await runFrames();
    expect(row('row-25')).toBe(target);

    button.setAttribute('aria-expanded', 'false');
    row('row-0').focus();
    await Promise.resolve();
    scroller.dispatchEvent(new Event('scroll'));
    await runFrames();
    expect(row('row-25')).toBeNull();
  });
});
