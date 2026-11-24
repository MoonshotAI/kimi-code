// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { KimiWebApi } from '@moonshot-ai/app-core/api';
import {
  onToast,
  resetKimiClientDeps,
  setKimiClientDeps,
  toast,
  useKimiWebClient,
  type ToastEvent,
} from '@moonshot-ai/app-client/client';
import { warningsStore } from '@moonshot-ai/app-client/stores';
import AppToasts from '../src/AppToasts.vue';

const clientApiMock: Record<string, unknown> = {};
let app: App | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  setKimiClientDeps({ api: () => clientApiMock as unknown as KimiWebApi, t: (key) => key });
  for (const key of Object.keys(clientApiMock)) delete clientApiMock[key];
  clientApiMock.connectEvents = vi.fn(() => ({
    subscribeConversation: vi.fn(),
    unsubscribeConversation: vi.fn(),
    health: () => ({ connected: true, open: true, stale: false }),
    reconnect: vi.fn(),
    close: vi.fn(),
  }));
  clientApiMock.listSessions = vi.fn(async () => ({ items: [], total: 0 }));
  vi.stubGlobal('WebSocket', class {});
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  warningsStore().setWarnings([]);
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({ render: () => h(AppToasts) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  warningsStore().setWarnings([]);
  vi.unstubAllGlobals();
  resetKimiClientDeps();
});

describe('action toast replacement', () => {
  it('does not restore pending batch feedback replaced by a direct toast', async () => {
    let finishRestore!: (value: {
      results: Array<{ id: string; ok: boolean }>;
      succeeded: number;
      failed: number;
    }) => void;
    clientApiMock.restoreSessions = vi.fn(() => new Promise((resolve) => { finishRestore = resolve; }));
    const events: ToastEvent[] = [];
    const off = onToast((event) => events.push(event));
    const client = useKimiWebClient();

    client.showActionToast({
      kind: 'adminBatch',
      plan: { direction: 'archive', ids: ['s1'], succeeded: 1, failed: 0 },
    });
    await nextTick();
    const action = events.find((event) => event.type === 'show');
    const pending = action!.options!.actions![0]!.onClick({ dismiss: vi.fn() });
    toast({ layout: 'bar', mode: 'replace', title: 'conversation.undone', duration: 0 });
    await nextTick();
    finishRestore({ results: [{ id: 's1', ok: true }], succeeded: 1, failed: 0 });
    await pending;
    off();

    const shown = events.filter((event) => event.type === 'show');
    expect(shown.map((event) => event.options?.title)).toEqual([
      'admin.batchDoneToast',
      'conversation.undone',
    ]);
  });
});
