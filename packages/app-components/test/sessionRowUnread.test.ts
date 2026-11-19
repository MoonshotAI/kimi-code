// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '@moonshot-ai/app-core/client/types';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { clientPinia, sessionViewsStore } from '@moonshot-ai/app-client/stores';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import SessionRow from '../src/SessionRow.vue';

let app: App | null = null;
let host: HTMLDivElement;

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'Session',
    time: '1m',
    busy: false,
    pendingInteraction: 'none',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Session;
}

function mountRow(stateTag?: 'done'): void {
  const state = reactive({ row: session() });
  app = createApp({
    setup() {
      return () => h(SessionRow, {
        session: state.row,
        active: false,
        stateTag,
        unread: sessionViewsStore().unreadBySession[state.row.id] ?? false,
      });
    },
  });
  app.use(clientPinia);
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, (name) => ({
    render: () => h('svg', { 'data-icon': name }),
  }));
  app.mount(host);
}

async function openContextMenu(): Promise<void> {
  host.querySelector<HTMLElement>('.se')!.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 100,
    clientY: 100,
  }));
  await nextTick();
  await nextTick();
}

function menuItem(label: string): HTMLButtonElement {
  const item = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].reverse().find(
    (element) => element.textContent?.trim() === label,
  );
  if (item === undefined) throw new Error(`Menu item not found: ${label}`);
  return item;
}

beforeEach(() => {
  window.localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  sessionViewsStore().clearUnread('s1');
  window.localStorage.clear();
});

describe('SessionRow unread menu', () => {
  it.each([undefined, 'done' as const])('marks a session unread and read from the context menu (stateTag=%s)', async (stateTag) => {
    mountRow(stateTag);
    await openContextMenu();
    menuItem('Mark as unread').click();
    await nextTick();

    expect(sessionViewsStore().unreadBySession.s1).toBe(true);
    expect(JSON.parse(window.localStorage.getItem('kimi-web.manual-unread') ?? '{}')).toEqual({ s1: true });
    expect(host.querySelector('[data-testid="session-unread"]')).not.toBeNull();

    await openContextMenu();
    menuItem('Mark as read').click();
    await nextTick();

    expect(sessionViewsStore().unreadBySession.s1).toBeUndefined();
    expect(JSON.parse(window.localStorage.getItem('kimi-web.manual-unread') ?? '{}')).toEqual({});
    expect(host.querySelector('[data-testid="session-unread"]')).toBeNull();
  });
});
