// @vitest-environment jsdom
import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import ConversationToc, { type ConversationTocItem } from '../src/chat/ConversationToc.vue';

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed = new Set<Element>();
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(element: Element): void { this.observed.add(element); }
  unobserve(element: Element): void { this.observed.delete(element); }
  disconnect(): void { this.observed.clear(); }
  trigger(): void { this.callback([], this as unknown as ResizeObserver); }
}

const geometry = new Map<Element, { left?: number; right?: number }>();

function rectFor(element: Element): DOMRect {
  const box = geometry.get(element) ?? {};
  const left = box.left ?? 0;
  const right = box.right ?? 0;
  return {
    left,
    right,
    top: 0,
    bottom: 0,
    x: left,
    y: 0,
    width: right - left,
    height: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

const originalRectDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect');
const originalOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');

function restorePrototypeProperty(key: 'getBoundingClientRect' | 'offsetParent', descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
}

function turn(no: number, title = `Turn ${no}`): ConversationTocItem {
  return { id: `t${no}`, role: 'user', no, title };
}

describe('ConversationToc adaptive layout', () => {
  let app: App | null = null;
  let container: HTMLElement;

  function nav(): HTMLElement | null {
    return container.querySelector<HTMLElement>('.conversation-toc');
  }

  function rows(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('.toc-row')];
  }

  function setRoom(room: number): void {
    const el = nav();
    if (el) geometry.set(el, { left: 100 });
    geometry.set(container, { right: 100 + room + 44 + 12 });
  }

  async function mountToc(props: () => Record<string, unknown>, room = 400): Promise<void> {
    container = document.createElement('div');
    document.body.append(container);
    app = createApp(defineComponent({
      setup() {
        return () => h(ConversationToc, props());
      },
    }));
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(container);
    setRoom(room);
    await nextTick();
  }

  async function resizeTo(room: number): Promise<void> {
    setRoom(room);
    for (const instance of FakeResizeObserver.instances) instance.trigger();
    await nextTick();
  }

  function expandedWidth(): string {
    return nav()!.style.getPropertyValue('--toc-expanded-width');
  }

  beforeEach(() => {
    localStorage.clear();
    FakeResizeObserver.instances = [];
    geometry.clear();
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement): DOMRect {
      return rectFor(this);
    };
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get(this: HTMLElement) {
        return this.parentElement;
      },
    });
  });

  afterEach(() => {
    app?.unmount();
    app = null;
    container.remove();
    restorePrototypeProperty('getBoundingClientRect', originalRectDescriptor);
    restorePrototypeProperty('offsetParent', originalOffsetParent);
    vi.unstubAllGlobals();
  });

  it('shows with the expanded width capped at 260px when there is plenty of room', async () => {
    await mountToc(() => ({ items: [turn(1), turn(2), turn(3)], activeTurnId: null }), 400);

    expect(nav()!.classList.contains('toc-clipped')).toBe(false);
    expect(nav()!.getAttribute('aria-hidden')).toBeNull();
    expect(expandedWidth()).toBe('260px');
    expect(FakeResizeObserver.instances[0]!.observed.has(container)).toBe(true);
  });

  it('narrows the expanded width to the room left before the window edge', async () => {
    await mountToc(() => ({ items: [turn(1), turn(2), turn(3)], activeTurnId: null }), 179);

    expect(nav()!.classList.contains('toc-clipped')).toBe(false);
    expect(expandedWidth()).toBe('179px');
  });

  it('hides once the room drops below 160px and comes back when it grows again', async () => {
    await mountToc(() => ({ items: [turn(1), turn(2), turn(3)], activeTurnId: null }), 179);
    expect(nav()!.classList.contains('toc-clipped')).toBe(false);

    await resizeTo(139);
    expect(nav()!.classList.contains('toc-clipped')).toBe(true);
    expect(nav()!.getAttribute('aria-hidden')).toBe('true');
    expect(expandedWidth()).toBe('139px');

    await resizeTo(160);
    expect(nav()!.classList.contains('toc-clipped')).toBe(false);
    expect(nav()!.getAttribute('aria-hidden')).toBeNull();
    expect(expandedWidth()).toBe('160px');
  });

  it('hides the rail when it would cover chat content and restores it once the gutter fits', async () => {
    await mountToc(() => ({ items: [turn(1), turn(2), turn(3)], activeTurnId: null }));
    const content = document.createElement('div');
    content.className = 'content-wrap';
    const chat = document.createElement('div');
    chat.className = 'chat';
    chat.style.paddingLeft = '20px';
    content.append(chat);
    container.append(content);
    geometry.set(chat, { left: 100 });
    await resizeTo(400);
    expect(nav()!.classList.contains('toc-clipped')).toBe(true);
    expect(nav()!.getAttribute('aria-hidden')).toBe('true');

    geometry.set(chat, { left: 124 });
    await resizeTo(400);
    expect(nav()!.classList.contains('toc-clipped')).toBe(false);
    expect(nav()!.getAttribute('aria-hidden')).toBeNull();
  });

  it('renders every turn as a titled row and emits select with the turn id on click', async () => {
    const onSelect = vi.fn();
    const longTitle = 'A very long turn title that will definitely overflow the narrow strip';
    await mountToc(() => ({
      items: [turn(1, longTitle), turn(2), turn(3)],
      activeTurnId: 't2',
      onSelect,
    }));

    expect(rows()).toHaveLength(3);
    expect(rows()[0]!.getAttribute('aria-label')).toBe(longTitle);
    expect(rows()[1]!.getAttribute('aria-label')).toBe('Turn 2');
    expect(rows()[1]!.classList.contains('active')).toBe(true);

    rows()[1]!.click();
    expect(onSelect).toHaveBeenCalledWith('t2');
  });

  it('opens every title immediately on entering the directory and dismisses on leave or Escape', async () => {
    await mountToc(() => ({ items: [turn(1), turn(2), turn(3)], activeTurnId: 't1' }));
    expect(container.querySelector('.toc-directory')).toBeNull();
    nav()!.dispatchEvent(new MouseEvent('mouseenter'));
    await nextTick();
    expect([...container.querySelectorAll('.toc-title')].map(el => el.textContent)).toEqual(['Turn 1', 'Turn 2', 'Turn 3']);
    expect(rows()[0]!.getAttribute('aria-expanded')).toBe('true');
    expect(rows()[0]!.getAttribute('aria-controls')).toBe(container.querySelector('.toc-directory')!.id);
    container.querySelector('.toc-list')!.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(container.querySelector('.toc-directory')).not.toBeNull();
    nav()!.dispatchEvent(new MouseEvent('mouseleave'));
    await nextTick();
    expect(container.querySelector('.toc-directory')).toBeNull();
    rows()[0]!.focus();
    await nextTick();
    expect(container.querySelectorAll('.toc-title')).toHaveLength(3);
    rows()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(container.querySelector('.toc-directory')).toBeNull();
    expect(rows()[0]!.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows edge fades only where content remains and updates after resizing', async () => {
    await mountToc(() => ({ items: Array.from({ length: 20 }, (_, i) => turn(i + 1)), activeTurnId: null }));
    nav()!.dispatchEvent(new MouseEvent('mouseenter'));
    await nextTick();
    const list = container.querySelector<HTMLElement>('.toc-list')!;
    const directory = container.querySelector<HTMLElement>('.toc-directory')!;
    let contentHeight = 400;
    Object.defineProperty(list, 'clientHeight', { value: 150 });
    Object.defineProperty(list, 'scrollHeight', { get: () => contentHeight });
    const resize = FakeResizeObserver.instances.find(instance => instance.observed.has(list))!;
    resize.trigger();
    await nextTick();
    expect(directory.classList.contains('can-scroll-up')).toBe(false);
    expect(directory.classList.contains('can-scroll-down')).toBe(true);

    list.scrollTop = 100;
    list.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(directory.classList.contains('can-scroll-up')).toBe(true);
    expect(directory.classList.contains('can-scroll-down')).toBe(true);

    list.scrollTop = 250;
    list.dispatchEvent(new Event('scroll'));
    await nextTick();
    expect(directory.classList.contains('can-scroll-up')).toBe(true);
    expect(directory.classList.contains('can-scroll-down')).toBe(false);

    contentHeight = 150;
    list.scrollTop = 0;
    resize.trigger();
    await nextTick();
    expect(directory.classList.contains('can-scroll-up')).toBe(false);
    expect(directory.classList.contains('can-scroll-down')).toBe(false);
  });

  it('smoothly shifts the rail wave within a marker without selecting a turn', async () => {
    const onSelect = vi.fn();
    await mountToc(() => ({ items: Array.from({ length: 8 }, (_, i) => turn(i + 1)), activeTurnId: null, onSelect }));
    const marker = rows()[3]!;
    marker.getBoundingClientRect = () => ({ top: 24, bottom: 32, height: 8 } as DOMRect);
    marker.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 28 }));
    await nextTick();
    const centered = Number(marker.style.getPropertyValue('--toc-bar-scale'));
    const neighbor = Number(rows()[4]!.style.getPropertyValue('--toc-bar-scale'));
    expect(centered).toBe(3.5);

    marker.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 30 }));
    await nextTick();
    expect(Number(marker.style.getPropertyValue('--toc-bar-scale'))).toBeLessThan(centered);
    expect(Number(rows()[4]!.style.getPropertyValue('--toc-bar-scale'))).toBeGreaterThan(neighbor);
    expect(container.querySelector('.toc-entry.hovered .toc-link')?.getAttribute('aria-label')).toBe('Turn 4');
    expect(onSelect).not.toHaveBeenCalled();

    nav()!.dispatchEvent(new MouseEvent('mouseleave'));
    await nextTick();
    expect(rows().every(row => Number(row.style.getPropertyValue('--toc-bar-scale')) === 1)).toBe(true);
  });

  it('keeps all entries available in long conversations and selects a title', async () => {
    const onSelect = vi.fn();
    await mountToc(() => ({ items: Array.from({ length: 80 }, (_, i) => turn(i + 1)), activeTurnId: 't2', onSelect }));
    nav()!.dispatchEvent(new MouseEvent('mouseenter'));
    await nextTick();
    const links = container.querySelectorAll<HTMLButtonElement>('.toc-link');
    expect(links).toHaveLength(80);
    expect(links[1]!.getAttribute('aria-current')).toBe('location');
    links[79]!.click();
    expect(onSelect).toHaveBeenCalledWith('t80');
    expect(localStorage.length).toBe(0);
  });

  it('scrolls the directory from the rail even when the rail itself does not overflow', async () => {
    await mountToc(() => ({ items: Array.from({ length: 20 }, (_, i) => turn(i + 1)), activeTurnId: null }));
    nav()!.dispatchEvent(new MouseEvent('mouseenter'));
    await nextTick();
    const rail = container.querySelector<HTMLElement>('.toc-scroll')!;
    const list = container.querySelector<HTMLElement>('.toc-list')!;
    Object.defineProperty(rail, 'clientHeight', { value: 56 });
    Object.defineProperty(list, 'clientHeight', { value: 120 });
    list.getBoundingClientRect = () => ({ top: 0, bottom: 120, height: 120 } as DOMRect);
    [...container.querySelectorAll<HTMLElement>('.toc-entry')].forEach((entry, index) => {
      entry.getBoundingClientRect = () => ({ top: index * 40 - list.scrollTop, bottom: (index + 1) * 40 - list.scrollTop, height: 40 } as DOMRect);
    });
    const wheel = new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true });
    rail.dispatchEvent(wheel);
    await nextTick();
    await nextTick();
    expect(wheel.defaultPrevented).toBe(true);
    expect(list.scrollTop).toBe(120);
    expect(rail.scrollTop).toBe(16);
    list.scrollTop = 240;
    list.dispatchEvent(new Event('scroll'));
    expect(rail.scrollTop).toBe(40);
    rail.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, deltaMode: 1, cancelable: true }));
    await nextTick();
    await nextTick();
    expect(list.scrollTop).toBe(200);
  });

  it('virtualizes thousands of entries and reveals the current item when opening', async () => {
    HTMLElement.prototype.getBoundingClientRect = function(this: HTMLElement): DOMRect {
      const rect = rectFor(this);
      const list = this.closest<HTMLElement>('.toc-list');
      return list && this.classList.contains('history-window') ? new DOMRect(rect.x, -list.scrollTop, rect.width, rect.height) : rect;
    };
    await mountToc(() => ({
      items: Array.from({ length: 1000 }, (_, i) => turn(i + 1)),
      activeTurnId: 't950', windowHistory: true,
    }));
    nav()!.dispatchEvent(new MouseEvent('mouseenter'));
    for (let i = 0; i < 6; i++) await nextTick();
    const links = [...container.querySelectorAll<HTMLElement>('.toc-link')];
    expect(links.length).toBeLessThan(100);
    expect(links.some(link => link.getAttribute('aria-label') === 'Turn 950')).toBe(true);
    expect(container.querySelector<HTMLElement>('.toc-list')!.scrollTop).toBeGreaterThan(0);
  });

  it('follows pointer movement across rail markers and highlights the matching title without selecting', async () => {
    const onSelect = vi.fn();
    await mountToc(() => ({ items: Array.from({ length: 8 }, (_, i) => turn(i + 1)), activeTurnId: 't1', onSelect }));
    rows()[1]!.dispatchEvent(new MouseEvent('mouseenter', { clientX: 10, clientY: 20 }));
    await nextTick();
    expect(container.querySelector('.toc-entry.hovered .toc-link')?.getAttribute('aria-label')).toBe('Turn 2');
    rows()[6]!.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 90 }));
    await nextTick();
    expect(container.querySelector('.toc-entry.hovered .toc-link')?.getAttribute('aria-label')).toBe('Turn 7');
    expect(container.querySelectorAll('.toc-title')).toHaveLength(8);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('reveals the hovered title without moving rail markers and ignores stationary pointer entries', async () => {
    await mountToc(() => ({ items: Array.from({ length: 20 }, (_, i) => turn(i + 1)), activeTurnId: null }));
    nav()!.dispatchEvent(new MouseEvent('mouseenter'));
    await nextTick();
    const rail = container.querySelector<HTMLElement>('.toc-scroll')!;
    const list = container.querySelector<HTMLElement>('.toc-list')!;
    Object.defineProperty(rail, 'clientHeight', { value: 56 });
    Object.defineProperty(list, 'clientHeight', { value: 120 });
    list.getBoundingClientRect = () => ({ top: 0, bottom: 120, height: 120 } as DOMRect);
    [...container.querySelectorAll<HTMLElement>('.toc-entry')].forEach((entry, index) => {
      entry.getBoundingClientRect = () => ({ top: index * 40 - list.scrollTop, bottom: (index + 1) * 40 - list.scrollTop, height: 40 } as DOMRect);
    });
    rows()[12]!.dispatchEvent(new MouseEvent('mouseenter', { clientX: 10, clientY: 50 }));
    for (let i = 0; i < 3; i++) await nextTick();
    expect(list.scrollTop).toBe(440);
    expect(rail.scrollTop).toBe(0);
    list.dispatchEvent(new Event('scroll'));
    expect(rail.scrollTop).toBe(0);
    rows()[14]!.dispatchEvent(new MouseEvent('mouseenter', { clientX: 10, clientY: 50 }));
    for (let i = 0; i < 3; i++) await nextTick();
    expect(list.scrollTop).toBe(440);
    expect(container.querySelector('.toc-entry.hovered .toc-link')?.getAttribute('aria-label')).toBe('Turn 13');
    rows()[14]!.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 70 }));
    for (let i = 0; i < 3; i++) await nextTick();
    expect(list.scrollTop).toBe(520);
    expect(container.querySelector('.toc-entry.hovered .toc-link')?.getAttribute('aria-label')).toBe('Turn 15');
  });

  it('does not move the directory back to the active item while the user scrolls', async () => {
    const active = ref<string | null>(null);
    await mountToc(() => ({ items: Array.from({ length: 20 }, (_, i) => turn(i + 1)), activeTurnId: active.value }));
    nav()!.dispatchEvent(new MouseEvent('mouseenter'));
    await nextTick();
    const list = container.querySelector<HTMLElement>('.toc-list')!;
    list.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
    list.scrollTop = 100;
    active.value = 't15';
    for (let i = 0; i < 3; i++) await nextTick();
    expect(list.scrollTop).toBe(100);
  });

  it('closes the directory when switching sessions', async () => {
    const sessionId = ref('session-a');
    await mountToc(() => ({ items: [turn(1), turn(2), turn(3)], activeTurnId: null, sessionId: sessionId.value }));
    rows()[0]!.dispatchEvent(new MouseEvent('mouseenter'));
    await nextTick();
    expect(container.querySelector('.toc-directory')).not.toBeNull();
    sessionId.value = 'session-b';
    await nextTick();
    expect(container.querySelector('.toc-directory')).toBeNull();
    expect(rows()[0]!.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the list open when focus moves into it and closes when focus leaves', async () => {
    await mountToc(() => ({ items: [turn(1), turn(2), turn(3)], activeTurnId: null, sessionId: 'session-a' }));
    rows()[0]!.focus();
    await nextTick();
    container.querySelector<HTMLButtonElement>('.toc-link')!.focus();
    await nextTick();
    expect(container.querySelector('.toc-directory')).not.toBeNull();
    container.querySelector<HTMLButtonElement>('.toc-link')!.blur();
    await nextTick();
    expect(container.querySelector('.toc-directory')).toBeNull();
  });

  it('steps aside while a wide table is expanded', async () => {
    const tableExpanded = ref(true);
    await mountToc(() => ({
      items: [turn(1), turn(2), turn(3)],
      activeTurnId: null,
      tableExpanded: tableExpanded.value,
    }));

    expect(nav()!.classList.contains('toc-clipped')).toBe(true);
    expect(nav()!.getAttribute('aria-hidden')).toBe('true');

    tableExpanded.value = false;
    await nextTick();
    expect(nav()!.classList.contains('toc-clipped')).toBe(false);
    expect(nav()!.getAttribute('aria-hidden')).toBeNull();
  });

  it('stays away while the session is loading and reappears once loaded', async () => {
    const sessionLoading = ref(true);
    await mountToc(() => ({
      items: [turn(1), turn(2), turn(3)],
      activeTurnId: null,
      sessionLoading: sessionLoading.value,
    }));
    expect(nav()).toBeNull();
    expect(FakeResizeObserver.instances).toHaveLength(0);

    sessionLoading.value = false;
    await nextTick();
    await nextTick();
    expect(nav()).not.toBeNull();
    expect(nav()!.classList.contains('toc-clipped')).toBe(false);

    sessionLoading.value = true;
    await nextTick();
    expect(nav()).toBeNull();
    expect(FakeResizeObserver.instances[0]!.observed.size).toBe(0);
  });

  it('stays away on mobile', async () => {
    await mountToc(() => ({ items: [turn(1), turn(2), turn(3)], activeTurnId: null, mobile: true }));
    expect(nav()).toBeNull();
  });

  it('stays away with fewer than three turns and reappears when a third turn arrives', async () => {
    const items = ref([turn(1)]);
    await mountToc(() => ({ items: items.value, activeTurnId: null }));
    expect(nav()).toBeNull();

    items.value = [turn(1), turn(2)];
    await nextTick();
    expect(nav()).toBeNull();

    items.value = [turn(1), turn(2), turn(3)];
    await nextTick();
    await nextTick();
    expect(nav()).not.toBeNull();
    expect(rows()).toHaveLength(3);
  });
});
