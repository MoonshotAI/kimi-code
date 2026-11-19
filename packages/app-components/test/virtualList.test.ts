// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, reactive, ref, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VirtualList from '../src/chat/VirtualList.vue';

const VIEWPORT = 200;
const SIZE = 36;
const GAP = 4;

const state = reactive({ count: 200, enabled: true });
let app: App | null = null;
let rawTop = 0;
let scroller: HTMLElement;
const listRef = ref<{ reveal: (key: string) => Promise<void>; release: () => void } | null>(null);

function list(): HTMLElement {
  return scroller.querySelector<HTMLElement>('.virtual-list')!;
}

function offsetInList(el: Element): number {
  let top = 0;
  let previous: Element | null = null;
  for (const child of list().children) {
    if (child.classList.contains('row') && previous?.classList.contains('row')) top += GAP;
    if (child === el) return top;
    top += child.classList.contains('virtual-space') ? parseFloat((child as HTMLElement).style.height) : SIZE;
    previous = child;
  }
  return top;
}

function listHeight(): number {
  const last = list().lastElementChild;
  return last ? offsetInList(last) + (last.classList.contains('virtual-space') ? parseFloat((last as HTMLElement).style.height) : SIZE) : 0;
}

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, left: 0, right: 200, width: 200, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

function rectOf(el: Element): DOMRect {
  if (el === scroller) return rect(0, VIEWPORT);
  if (el === list()) return rect(-rawTop, listHeight());
  if (el.parentElement === list()) return rect(-rawTop + offsetInList(el), el.classList.contains('row') ? SIZE : parseFloat((el as HTMLElement).style.height));
  return rect(0, 0);
}

function rows(): string[] {
  return [...scroller.querySelectorAll<HTMLElement>('.row')].map(el => el.dataset.key!);
}

function row(key: string): HTMLElement | null {
  return scroller.querySelector<HTMLElement>(`.row[data-key="${key}"]`);
}

async function scrollTo(top: number): Promise<void> {
  rawTop = top;
  scroller.dispatchEvent(new Event('scroll'));
  await nextTick();
}

beforeEach(async () => {
  rawTop = 0;
  state.count = 200;
  state.enabled = true;
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return rectOf(this);
  });
  scroller = document.createElement('div');
  scroller.className = 'scroll-root';
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, get: () => VIEWPORT },
    scrollTop: { configurable: true, get: () => rawTop, set: (value: number) => { rawTop = value; } },
  });
  document.body.append(scroller);
  app = createApp(defineComponent(() => () => h(VirtualList<number>, {
    ref: listRef,
    items: Array.from({ length: state.count }, (_, i) => i),
    itemKey: (item: number) => `k${item}`,
    itemSize: SIZE,
    gap: GAP,
    enabled: state.enabled,
    scrollRoot: '.scroll-root',
  }, {
    default: ({ item }: { item: number }) => h('button', { class: 'row', 'data-key': `k${item}` }, String(item)),
  })));
  app.mount(scroller);
  await nextTick();
});

afterEach(() => {
  app?.unmount();
  app = null;
  scroller.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('VirtualList', () => {
  it('renders only the rows around the viewport with exact spacers', async () => {
    const stride = SIZE + GAP;
    const total = 199 * stride + SIZE;
    expect(rows().length).toBeLessThan(40);
    expect(rows()[0]).toBe('k0');
    expect(listHeight()).toBe(total);

    await scrollTo(100 * stride);
    expect(rows()).toContain('k100');
    expect(rows()).not.toContain('k0');
    expect(listHeight()).toBe(total);
    expect(rectOf(row('k100')!).top).toBe(0);
    expect(rectOf(row('k104')!).top).toBe(4 * stride);
  });

  it('reveals a distant row without scrolling and drops it after release', async () => {
    const stride = SIZE + GAP;
    await listRef.value!.reveal('k180');
    expect(rawTop).toBe(0);
    expect(row('k180')).not.toBeNull();
    expect(rectOf(row('k180')!).top).toBe(180 * stride);
    expect(listHeight()).toBe(199 * stride + SIZE);

    listRef.value!.release();
    await nextTick();
    expect(row('k180')).toBeNull();
  });

  it('keeps the focused row mounted after it scrolls out of range', async () => {
    row('k2')!.focus();
    row('k2')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await Promise.resolve();
    await scrollTo(150 * (SIZE + GAP));
    expect(row('k2')).not.toBeNull();
    expect(document.activeElement).toBe(row('k2'));
  });

  it('renders every row without spacers when disabled', async () => {
    state.count = 30;
    state.enabled = false;
    await nextTick();
    expect(rows()).toHaveLength(30);
    expect(scroller.querySelector('.virtual-list, .virtual-space')).toBeNull();
  });
});
