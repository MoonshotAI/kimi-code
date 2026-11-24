// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IconButton, Tooltip } from '@moonshot-ai/app-ui';

let app: App | null = null;
let host: HTMLDivElement;

const MoveEvent: typeof MouseEvent = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;

function move(target: Element, x: number, y: number, pointerType = 'mouse'): void {
  const event = new MoveEvent('pointermove', { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  target.dispatchEvent(event);
}

function mountButtons(count: number): void {
  app = createApp({
    render: () =>
      h(
        'div',
        Array.from({ length: count }, (_, i) =>
          h(IconButton, { label: `button ${i}`, tooltip: `tip ${i}` }, () => 'x'),
        ),
      ),
  });
  app.mount(host);
}

function typeCalls(spy: ReturnType<typeof vi.spyOn>, type: string): number {
  return spy.mock.calls.filter(([eventType]) => eventType === type).length;
}

async function settle(): Promise<void> {
  await nextTick();
  await nextTick();
}

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('tooltip viewport listeners', () => {
  it('does not register window scroll/resize listeners per closed tooltip', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    mountButtons(40);
    await settle();

    expect(typeCalls(add, 'scroll')).toBe(0);
    expect(typeCalls(add, 'resize')).toBe(0);
  });

  it('listens to resize only while a tooltip is open and ignores scroll', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    mountButtons(3);
    await settle();

    const button = host.querySelector('button')!;
    move(button, 5, 5);
    move(button, 12, 9);
    await vi.advanceTimersByTimeAsync(200);
    await settle();

    expect(document.body.querySelector('.ui-tip__bubble')).not.toBeNull();
    expect(typeCalls(add, 'scroll')).toBe(0);
    expect(typeCalls(add, 'resize')).toBe(1);

    window.dispatchEvent(new Event('scroll'));
    await settle();

    expect(document.body.querySelector('.ui-tip__bubble')).not.toBeNull();
    expect(typeCalls(remove, 'scroll')).toBe(0);
    expect(typeCalls(remove, 'resize')).toBe(0);

    window.dispatchEvent(new Event('resize'));
    await settle();

    expect(document.body.querySelector('.ui-tip__bubble')).toBeNull();
    expect(typeCalls(remove, 'scroll')).toBe(0);
    expect(typeCalls(remove, 'resize')).toBe(1);
  });
});

describe('tooltip hover input', () => {
  it('ignores touch pointer moves on direct targets and still responds to mouse hover', async () => {
    mountButtons(1);
    await settle();

    const button = host.querySelector('button')!;
    move(button, 5, 5, 'touch');
    move(button, 12, 9, 'touch');
    await vi.advanceTimersByTimeAsync(200);
    await settle();

    expect(document.body.querySelector('.ui-tip__bubble')).toBeNull();

    move(button, 20, 12);
    await vi.advanceTimersByTimeAsync(200);
    await settle();

    expect(document.body.querySelector('.ui-tip__bubble')?.textContent).toBe('tip 0');
  });

  it('ignores touch pointer moves on delegated triggers', async () => {
    app = createApp({
      render: () => h(Tooltip, { text: 'summary' }, () => h('button', 'summary')),
    });
    app.mount(host);
    await settle();

    const button = host.querySelector('button')!;
    move(button, 5, 5, 'touch');
    move(button, 12, 9, 'touch');
    await vi.advanceTimersByTimeAsync(200);
    await settle();

    expect(document.body.querySelector('.ui-tip__bubble')).toBeNull();
  });

  it('ignores non-mouse pointer moves when no input can hover', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(any-hover: none)',
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    mountButtons(1);
    await settle();

    const button = host.querySelector('button')!;
    move(button, 5, 5, 'pen');
    move(button, 12, 9, 'pen');
    await vi.advanceTimersByTimeAsync(200);
    await settle();

    expect(document.body.querySelector('.ui-tip__bubble')).toBeNull();
  });

  it('preserves mouse hover when the primary pointer cannot hover', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(hover: none)',
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    mountButtons(1);
    await settle();

    const button = host.querySelector('button')!;
    move(button, 5, 5);
    move(button, 12, 9);
    await vi.advanceTimersByTimeAsync(200);
    await settle();

    expect(document.body.querySelector('.ui-tip__bubble')?.textContent).toBe('tip 0');
  });

  it('cancels a pending mouse hover when a touch press lands without moving', async () => {
    mountButtons(1);
    await settle();

    const button = host.querySelector('button')!;
    move(button, 5, 5);
    move(button, 12, 9);
    await vi.advanceTimersByTimeAsync(100);

    const down = new MoveEvent('pointerdown', { bubbles: true, clientX: 12, clientY: 9 });
    Object.defineProperty(down, 'pointerType', { value: 'touch' });
    button.dispatchEvent(down);

    await vi.advanceTimersByTimeAsync(200);
    await settle();

    expect(document.body.querySelector('.ui-tip__bubble')).toBeNull();
  });

  it('closes an open delegated tooltip when touch takes over from a stationary mouse', async () => {
    app = createApp({
      render: () => h(Tooltip, { text: 'summary' }, () => h('button', 'summary')),
    });
    app.mount(host);
    await settle();

    const button = host.querySelector('button')!;
    move(button, 5, 5);
    move(button, 12, 9);
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(document.body.querySelector('.ui-tip__bubble')).not.toBeNull();

    move(button, 12, 9, 'touch');
    await settle();

    expect(document.body.querySelector('.ui-tip__bubble')).toBeNull();
  });
});
