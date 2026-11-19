// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, type App } from 'vue';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '@moonshot-ai/app-core/client/types';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import SessionRow from '../src/SessionRow.vue';

let app: App | null = null;
let host: HTMLDivElement;

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'a very long session title that will not fit in the sidebar',
    time: '1m',
    busy: false,
    pendingInteraction: 'none',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as Session;
}

function mountRow(state: { row: Session }): void {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({
    setup() {
      return () => h(SessionRow, { session: state.row, active: false });
    },
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
}

function titleEls(): { row: HTMLElement; box: HTMLElement; inner: HTMLElement } {
  const row = host.querySelector<HTMLElement>('.se');
  const box = host.querySelector<HTMLElement>('.t');
  const inner = host.querySelector<HTMLElement>('.t-inner');
  if (row === null || box === null || inner === null) throw new Error('title not rendered');
  return { row, box, inner };
}

function mockWidths(clientWidth: number, scrollWidth: number): void {
  const { box, inner } = titleEls();
  Object.defineProperty(box, 'clientWidth', { value: clientWidth, configurable: true });
  Object.defineProperty(inner, 'scrollWidth', { value: scrollWidth, configurable: true });
}

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
});

describe('SessionRow hover scroll', () => {
  it('marks the title scrollable and injects the scroll vars on hover', async () => {
    mountRow({ row: session() });
    await nextTick();
    mockWidths(100, 260);
    const { row, box } = titleEls();

    row.dispatchEvent(new MouseEvent('mouseenter'));

    expect(box.classList.contains('scrollable')).toBe(true);
    expect(box.style.getPropertyValue('--sb-scroll-d')).toBe('-168px');
    expect(box.style.getPropertyValue('--sb-scroll-dur')).toBe('4200ms');
  });

  it('stays put when the title fits the sidebar', async () => {
    mountRow({ row: session() });
    await nextTick();
    mockWidths(260, 260);
    const { row, box } = titleEls();

    row.dispatchEvent(new MouseEvent('mouseenter'));

    expect(box.classList.contains('scrollable')).toBe(false);
    expect(box.style.getPropertyValue('--sb-scroll-d')).toBe('');
  });

  it('re-measures on the next hover after the title shrinks', async () => {
    const state = reactive({ row: session() });
    mountRow(state);
    await nextTick();
    mockWidths(100, 260);
    const { row, box } = titleEls();

    row.dispatchEvent(new MouseEvent('mouseenter'));
    expect(box.classList.contains('scrollable')).toBe(true);

    state.row = session({ title: 'short' });
    await nextTick();
    mockWidths(200, 120);
    row.dispatchEvent(new MouseEvent('mouseenter'));

    expect(box.classList.contains('scrollable')).toBe(false);
  });
});
