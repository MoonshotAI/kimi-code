// @vitest-environment jsdom
import { createApp, h, nextTick, provide, reactive, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@moonshot-ai/app-markdown', async () => {
  const vue = await import('vue');
  return {
    Markdown: vue.defineComponent({
      name: 'Markdown',
      props: ['text'],
      setup: (props) => () => vue.h('div', { class: 'msg' }, String(props.text ?? '')),
    }),
    createHistoryImageCache: () => ({}),
    HistoryImageCacheKey: Symbol('historyImageCache'),
  };
});

vi.mock('@moonshot-ai/app-composer/transcript', async () => {
  const vue = await import('vue');
  return {
    ComposerText: vue.defineComponent({
      name: 'ComposerText',
      props: ['text'],
      setup: (props) => () => vue.h('span', { class: 'u-text' }, String(props.text ?? '')),
    }),
    copyComposerSnapshot: vi.fn(),
    copyTextWithFlavor: vi.fn(),
    isBubbleInternalScroll: () => false,
  };
});

vi.mock('@moonshot-ai/app-client/client', async () => {
  const vue = await import('vue');
  return {
    useKimiWebClient: () => ({
      experimentalFlags: vue.ref({}),
      activeSessionId: vue.ref(null),
      resolveImageUrl: (src: string) => src,
      notify: vi.fn(),
      detachTask: vi.fn(),
      unqueue: vi.fn(),
    }),
    getKimiWebApi: () => ({}),
  };
});

import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { SessionRatingKey } from '@moonshot-ai/app-client/contracts';
import type { SessionRatingBinding } from '@moonshot-ai/app-client/contracts';
import { panelApiKey, type PanelApi } from '@moonshot-ai/app-client/panel';
import type { ChatTurn } from '@moonshot-ai/app-core/client/types';
import ChatPane from '../src/chat/ChatPane.vue';

const raw = `{
  "error": {
    "code": 400,
    "message": "Request contains an invalid argument.",
    "status": "INVALID_ARGUMENT"
  }
}`;
const compact = JSON.stringify(JSON.parse(raw));

interface TurnError {
  code?: string;
  message?: string;
  statusCode?: number;
}

const userTurn = { id: 'u1', role: 'user', no: 1, text: 'hi', createdAt: '2025-01-01T10:00:00.000Z' } as ChatTurn;
const ratingBinding: SessionRatingBinding = {
  view: () => ({ phase: 'closed' }),
  shown: vi.fn(),
  select: vi.fn(),
  undo: vi.fn(),
};

let app: App | null = null;
let host: HTMLDivElement;
let props: {
  turns: ChatTurn[];
  sessionId: string;
  turnFailed: boolean;
  turnError: TurnError | null;
};

function mount(turnError: TurnError | null): void {
  props = reactive({
    turns: [userTurn],
    sessionId: 's1',
    turnFailed: true,
    turnError,
  });
  app = createApp({
    setup() {
      provide(SessionRatingKey, ratingBinding);
      return () => h(ChatPane, props as never);
    },
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.unstubAllGlobals();
});

describe('ChatPane turn failure', () => {
  it('minifies provider JSON in the existing message row', async () => {
    mount({ code: 'provider.api_error', message: raw, statusCode: 400 });
    await nextTick();

    expect(host.querySelector('.tf-sub')?.textContent).toBe(compact);
    expect(host.querySelector('.tf-meta')?.textContent).toBe('provider.api_error · HTTP 400');
    expect(host.querySelector('.tf-details-toggle')).toBeNull();
    expect(host.querySelector('.tf-details')).toBeNull();
  });

  it('keeps plain and malformed errors unchanged', async () => {
    for (const message of ['stub error 500', '{not json']) {
      app?.unmount();
      mount({ code: 'provider.api_error', message, statusCode: 500 });
      await nextTick();
      expect(host.querySelector('.tf-sub')?.textContent).toBe(message);
      expect(host.querySelector('.tf-details-toggle')).toBeNull();
    }
  });

  it('does not render an empty message row', async () => {
    mount({ code: 'provider.api_error', message: '', statusCode: 400 });
    await nextTick();
    expect(host.querySelector('.tf-sub')).toBeNull();
  });
});

describe('ChatPane compaction checkpoint card', () => {
  it('renders a distinct checkpoint card with token reduction badge and opens summary on click', async () => {
    const openCompaction = vi.fn();
    const compactionTurn: ChatTurn = {
      id: 'c1',
      role: 'compaction',
      text: 'Summary markdown',
      compaction: { trigger: 'manual', tokensBefore: 95437, tokensAfter: 82944 },
      createdAt: '2025-01-01T10:01:00.000Z',
    };
    app = createApp({
      setup() {
        provide(SessionRatingKey, ratingBinding);
        provide(panelApiKey, { openCompaction } as unknown as PanelApi);
        return () => h(ChatPane, { turns: [userTurn, compactionTurn], sessionId: 's1' } as never);
      },
    });
    app.use(createKimiI18n({ locale: 'zh' }));
    app.mount(host);
    await nextTick();

    const card = host.querySelector<HTMLButtonElement>('.compact-divider--compacted button.cd-card.cd-btn');
    expect(card).not.toBeNull();
    expect(card?.querySelector('.cd-title')?.textContent).toBe('上下文已压缩');
    expect(card?.querySelector('.cd-tokens')?.textContent).toBe('93.2k → 81k tokens');
    expect(card?.querySelector('.cd-saved')?.textContent).toBe('-12.2k');
    expect(card?.querySelector('.cd-view')?.textContent).toBe('查看摘要');
    expect(host.querySelector('.cd-meter')).toBeNull();

    card!.click();
    expect(openCompaction).toHaveBeenCalledExactlyOnceWith({ turnId: 'c1' });
  });

  it('omits savings badge and summary button when tokens did not decrease or summary cannot open', async () => {
    const compactionTurn: ChatTurn = {
      id: 'c2',
      role: 'compaction',
      text: '',
      compaction: { trigger: 'auto', tokensBefore: 4096, tokensAfter: 4608 },
      createdAt: '2025-01-01T10:02:00.000Z',
    };
    app = createApp({
      setup() {
        provide(SessionRatingKey, ratingBinding);
        return () => h(ChatPane, { turns: [userTurn, compactionTurn], sessionId: 's1' } as never);
      },
    });
    app.use(createKimiI18n({ locale: 'zh' }));
    app.mount(host);
    await nextTick();

    const card = host.querySelector<HTMLElement>('.compact-divider--compacted span.cd-card');
    expect(card).not.toBeNull();
    expect(card?.classList.contains('cd-btn')).toBe(false);
    expect(card?.querySelector('.cd-title')?.textContent).toBe('已自动压缩上下文');
    expect(card?.querySelector('.cd-tokens')?.textContent).toBe('4k → 4.5k tokens');
    expect(card?.querySelector('.cd-saved')).toBeNull();
    expect(card?.querySelector('.cd-action')).toBeNull();
  });
});
