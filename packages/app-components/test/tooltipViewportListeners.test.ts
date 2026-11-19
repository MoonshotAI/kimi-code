// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IconButton } from '@moonshot-ai/app-ui';

let app: App | null = null;
let host: HTMLDivElement;

const MoveEvent: typeof MouseEvent = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;

function move(target: Element, x: number, y: number): void {
  target.dispatchEvent(new MoveEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
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
