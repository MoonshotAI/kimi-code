// @vitest-environment jsdom
import { createApp, h, nextTick, provide, ref, type App } from 'vue';
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
import type { AppSessionRatingView } from '@moonshot-ai/app-core/api';
import ChatPane from '../src/chat/ChatPane.vue';

const OPEN_RATING: AppSessionRatingView = { phase: 'open', appearanceId: 'a1', survey: 'session' };

function turn(over: Partial<ChatTurn>): ChatTurn {
  return { id: 't1', role: 'user', no: 1, text: '', ...over } as ChatTurn;
}

const userTurn = turn({ id: 'u1', role: 'user', text: 'hi', createdAt: '2025-01-01T10:00:00.000Z' });
const answeredTurn = turn({
  id: 'a1',
  role: 'assistant',
  no: 2,
  text: 'hello there',
  createdAt: '2025-01-01T10:00:01.000Z',
  endedAt: '2025-01-01T10:00:02.000Z',
});
const failedTurn = turn({
  id: 'a2',
  role: 'assistant',
  no: 2,
  text: '',
  createdAt: '2025-01-01T10:00:01.000Z',
  endedAt: '2025-01-01T10:00:02.000Z',
});

let app: App | null = null;
let host: HTMLDivElement;
const ratingBinding: SessionRatingBinding = {
  view: () => OPEN_RATING,
  shown: vi.fn(),
  select: vi.fn(),
  undo: vi.fn(),
};

function mount(turns: ChatTurn[], extra: Record<string, unknown> = {}): void {
  app = createApp({
    setup() {
      provide(SessionRatingKey, ratingBinding);
      return () => h(ChatPane, { turns, sessionId: 's1', ...extra });
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

describe('ChatPane session rating placement', () => {
  it('attaches the rating row to the reply footer when the last turn has output', async () => {
    mount([userTurn, answeredTurn]);
    await nextTick();
    expect(host.querySelector('.a-msg-ft .session-rating')).not.toBeNull();
    expect(host.querySelector('.sr-tailrow')).toBeNull();
  });

  it('renders the rating row standalone only when the failed turn has no footer', async () => {
    mount([userTurn, failedTurn], { turnFailed: true, turnError: { message: 'boom' } });
    await nextTick();
    expect(host.querySelector('.a-msg-ft')).toBeNull();
    expect(host.querySelector('.turn-failed')).not.toBeNull();
    const tailrow = host.querySelector('.sr-tailrow');
    expect(tailrow).not.toBeNull();
    expect(tailrow!.querySelector('.session-rating')).not.toBeNull();
    const failed = host.querySelector('.turn-failed')!;
    expect(failed.compareDocumentPosition(tailrow!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    app?.unmount();
    mount([userTurn, turn({ ...failedTurn, daemonTurnId: 2, forkTurnIndex: 2, daemonTurnState: 'failed' })], {
      turnFailed: true,
      turnError: { message: 'boom' },
      forkEnabled: true,
    });
    await nextTick();
    expect(host.querySelectorAll('.session-rating')).toHaveLength(1);
    expect(host.querySelector('.a-msg-ft .session-rating')).not.toBeNull();
    expect(host.querySelector('.sr-tailrow')).toBeNull();
  });

  it('shows the rating after a failed turn that produced no assistant message', async () => {
    mount([userTurn], { turnFailed: true, turnError: { message: 'No response' } });
    await nextTick();
    expect(host.querySelector('.sr-tailrow .sr-question')?.textContent).toBe('How’s Kimi doing in this session?');
    expect(ratingBinding.shown).toHaveBeenCalledWith('s1', 'a1');
  });

  it('keeps the rating in the footer when the failed turn still produced output', async () => {
    mount([userTurn, answeredTurn], { turnFailed: true, turnError: { message: 'boom' } });
    await nextTick();
    expect(host.querySelector('.a-msg-ft .session-rating')).not.toBeNull();
    expect(host.querySelector('.sr-tailrow')).toBeNull();
  });

  it('drops the left separator in the standalone row and removes the row once the rating closes', async () => {
    const view = ref<AppSessionRatingView>(OPEN_RATING);
    const binding: SessionRatingBinding = { view: () => view.value, shown: vi.fn(), select: vi.fn(), undo: vi.fn() };
    app = createApp({
      setup() {
        provide(SessionRatingKey, binding);
        return () => h(ChatPane, { turns: [userTurn, failedTurn], sessionId: 's1', turnFailed: true });
      },
    });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await nextTick();
    const row = host.querySelector('.sr-tailrow .session-rating');
    expect(row).not.toBeNull();
    expect(row!.classList.contains('standalone')).toBe(true);
    view.value = { phase: 'closed' };
    await nextTick();
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.querySelector('.sr-tailrow')).toBeNull();
  });
});
