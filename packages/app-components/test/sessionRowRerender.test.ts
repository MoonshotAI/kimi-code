// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '@moonshot-ai/app-core/client/types';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import SessionRow from '../src/SessionRow.vue';

let app: App | null = null;
let host: HTMLDivElement;

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'first session',
    time: '1m',
    busy: false,
    pendingInteraction: 'none',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as Session;
}

function countRenders(): () => number {
  const component = SessionRow as unknown as { render?: (...args: unknown[]) => unknown };
  const original = component.render;
  if (typeof original !== 'function') throw new Error('SessionRow has no standalone render function');
  let count = 0;
  component.render = function (this: unknown, ...args: unknown[]) {
    count += 1;
    return original.apply(this, args);
  };
  return () => count;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
});

describe('SessionRow re-render isolation', () => {
  it('does not re-render when the parent re-renders with fresh inline drag handlers', async () => {
    const renders = countRenders();
    const tick = ref(0);
    const dragged: string[] = [];
    const row = session();
    app = createApp({
      setup() {
        return () =>
          h('div', { 'data-tick': tick.value }, [
            h(SessionRow, {
              session: row,
              active: false,
              onDragstart: (id: string, _event: DragEvent) => {
                dragged.push(id);
              },
              onRenameStateChange: () => {},
            }),
          ]);
      },
    });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await nextTick();
    const afterMount = renders();
    expect(afterMount).toBeGreaterThan(0);

    tick.value += 1;
    await nextTick();
    tick.value += 1;
    await nextTick();

    expect(renders()).toBe(afterMount);
  });

  it('emits dragstart with the session id so parents can bind a stable handler', () => {
    const dragged: [string, Event][] = [];
    app = createApp({
      render: () =>
        h(SessionRow, {
          session: session({ id: 'row-7' }),
          active: false,
          onDragstart: (id: string, event: DragEvent) => {
            dragged.push([id, event]);
          },
        }),
    });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);

    const row = host.querySelector('.se');
    expect(row).not.toBeNull();
    const event = new Event('dragstart', { bubbles: true });
    row!.dispatchEvent(event);

    expect(dragged).toHaveLength(1);
    expect(dragged[0][0]).toBe('row-7');
    expect(dragged[0][1]).toBe(event);
  });

  it('marks rows that show a status badge with a class instead of relying on :has()', () => {
    app = createApp({
      render: () =>
        h('div', [
          h(SessionRow, { session: session({ id: 'plain' }), active: false }),
          h(SessionRow, { session: session({ id: 'waiting' }), active: false, approvalCount: 1 }),
        ]),
    });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);

    const rows = host.querySelectorAll('.se');
    expect(rows).toHaveLength(2);
    expect(rows[0].classList.contains('has-badge')).toBe(false);
    expect(rows[1].querySelector('.ui-badge')).not.toBeNull();
    expect(rows[1].classList.contains('has-badge')).toBe(true);
  });
});
