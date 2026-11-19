// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, ref, type App } from 'vue';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { getIcon, type IconName } from '@moonshot-ai/app-client/icons';
import type { SessionContextItemsResponse } from '@moonshot-ai/app-core/api';

const TOTAL_ITEMS = 650;

const mocks = vi.hoisted(() => ({
  getSessionContextItems: vi.fn(),
  getSessionContextItem: vi.fn(),
  client: null as unknown,
}));

vi.mock('@moonshot-ai/app-client/client', () => ({
  getKimiWebApi: () => ({
    getSessionContextItems: mocks.getSessionContextItems,
    getSessionContextItem: mocks.getSessionContextItem,
  }),
  useKimiWebClient: () => mocks.client,
}));

import ContextPanel from '../../src/renderer/inspector/ContextPanel.vue';

function itemsResponse(query: { offset: number; limit: number }): SessionContextItemsResponse {
  const count = Math.max(0, Math.min(query.limit, TOTAL_ITEMS - query.offset));
  return {
    summary: {
      session_id: 's1',
      agent_id: 'main',
      captured_at: 1000,
      tokens: { used: 1000, max: 10000 },
      total_chars: TOTAL_ITEMS * 10,
      groups: [{ role: 'user', count: TOTAL_ITEMS, chars: TOTAL_ITEMS * 10 }],
    },
    tools: [],
    items: Array.from({ length: count }, (_, index) => ({
      id: `message-${query.offset + index}`,
      role: 'user',
      sequence: query.offset + index,
      preview: `item ${query.offset + index}`,
      chars: 10,
      has_media: false,
    })),
    total: TOTAL_ITEMS,
    has_more: query.offset + count < TOTAL_ITEMS,
  };
}

let app: App | undefined;
let host: HTMLDivElement | undefined;
const status = ref({ ctxUsed: 1000, ctxMax: 10000 });
const activity = ref('running');

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  status.value = { ctxUsed: 1000, ctxMax: 10000 };
  activity.value = 'running';
  mocks.client = { status, activity };
  mocks.getSessionContextItems.mockReset();
  mocks.getSessionContextItems.mockImplementation(async (_sid: string, query: { offset: number; limit: number }) =>
    itemsResponse(query),
  );
  mocks.getSessionContextItem.mockReset();
  mocks.getSessionContextItem.mockResolvedValue({ id: 'message-150', role: 'user', chars: 10, parts: [] });
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
  }
}

async function mountPanel(): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp(ContextPanel, { sessionId: 's1' });
  app.use(createKimiI18n({ locale: 'zh' }));
  app.provide(IconResolverKey, (name) => getIcon(name as IconName)?.component);
  app.mount(host);
  await settle();
  return host;
}

async function loadMore(root: HTMLElement): Promise<void> {
  root.querySelector<HTMLButtonElement>('.show-more-wrap button')!.click();
  await settle();
}

function lastQuery(): { offset: number; limit: number } {
  return mocks.getSessionContextItems.mock.calls.at(-1)![1];
}

describe('ContextPanel live refresh', () => {
  it('keeps loaded pages and the open item when context usage changes', async () => {
    const root = await mountPanel();
    expect(lastQuery()).toMatchObject({ offset: 0, limit: 100 });
    await loadMore(root);
    expect(lastQuery()).toMatchObject({ offset: 100, limit: 100 });
    expect(root.querySelectorAll('.context-row')).toHaveLength(200);

    [...root.querySelectorAll<HTMLButtonElement>('.context-row')]
      .find((row) => row.textContent?.includes('item 150'))!
      .click();
    await settle();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(mocks.getSessionContextItem).toHaveBeenCalledTimes(1);

    status.value = { ctxUsed: 2000, ctxMax: 10000 };
    await nextTick();
    expect(root.querySelector('.context-scroll')?.classList.contains('refreshing')).toBe(false);
    await settle();

    expect(lastQuery()).toMatchObject({ offset: 0, limit: 200 });
    expect(root.querySelectorAll('.context-row')).toHaveLength(200);
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(mocks.getSessionContextItem).toHaveBeenCalledTimes(1);
  });

  it('reloads the open item when its slot holds different content after a refresh', async () => {
    const root = await mountPanel();
    root.querySelectorAll<HTMLButtonElement>('.context-row')[20]!.click();
    await settle();
    expect(mocks.getSessionContextItem).toHaveBeenCalledTimes(1);

    mocks.getSessionContextItems.mockImplementation(async (_sid: string, query: { offset: number; limit: number }) => {
      const response = itemsResponse(query);
      return { ...response, items: response.items.map((item) => ({ ...item, chars: item.chars + 5 })) };
    });
    status.value = { ctxUsed: 500, ctxMax: 10000 };
    await settle();

    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(mocks.getSessionContextItem).toHaveBeenCalledTimes(2);
  });

  it('splits a refresh of more loaded items than one request allows', async () => {
    const root = await mountPanel();
    for (let page = 0; page < 5; page += 1) await loadMore(root);
    expect(root.querySelectorAll('.context-row')).toHaveLength(600);

    mocks.getSessionContextItems.mockClear();
    activity.value = 'idle';
    await settle();

    expect(mocks.getSessionContextItems.mock.calls.map((call) => call[1])).toEqual([
      { roles: undefined, offset: 0, limit: 500 },
      { roles: undefined, offset: 500, limit: 100 },
    ]);
    expect(root.querySelectorAll('.context-row')).toHaveLength(600);
    expect(root.querySelector('.show-more-wrap')).not.toBeNull();
  });
});
