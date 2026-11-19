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
