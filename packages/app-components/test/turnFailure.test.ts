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
import CompactionPanel from '../src/chat/CompactionPanel.vue';

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

describe('ChatPane quota auto-continue card', () => {
  const quotaError = {
    code: 'provider.auth_error',
    message: "You've reached your 5-hour usage limit.",
    statusCode: 403,
  };

  function mountQuotaCard(
    quotaAutoContinue: { enabled: boolean; resetAt: string | null } | null,
    locale: 'en' | 'zh' = 'en',
  ) {
    app?.unmount();
    const onSetQuotaAutoContinue = vi.fn();
    app = createApp({
      setup() {
        provide(SessionRatingKey, ratingBinding);
        return () =>
          h(ChatPane, {
            turns: [userTurn],
            sessionId: 's1',
            turnFailed: true,
            turnError: quotaError,
            quotaAutoContinue,
            onSetQuotaAutoContinue,
          } as never);
      },
    });
    app.use(createKimiI18n({ locale }));
    app.mount(host);
    return onSetQuotaAutoContinue;
  }

  it('renders no inline toggle when quotaAutoContinue is null', async () => {
    mountQuotaCard(null);
    await nextTick();
    expect(host.querySelector('.tf-auto-continue')).toBeNull();
    expect(host.querySelector('.tf-resume-at')).toBeNull();
  });

  it('renders checked toggle with localized same-day resume time and emits changes', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-27T11:00:00.000Z'));
      const resetAt = new Date('2026-11-27T19:34:00.000Z').toISOString();
      const onSetQuotaAutoContinue = mountQuotaCard({ enabled: true, resetAt }, 'en');
      await nextTick();
      const checkbox = host.querySelector<HTMLInputElement>('.tf-auto-continue input[type="checkbox"]');
      expect(checkbox?.checked).toBe(true);
      expect(host.querySelector('.tf-auto-continue')?.textContent?.trim()).toBe('Auto-continue when limits reset');
      expect(host.querySelector('.tf-resume-at')?.textContent?.trim()).toBe('Auto-resuming at 7:34 PM');

      checkbox!.click();
      await nextTick();
      expect(onSetQuotaAutoContinue).toHaveBeenCalledExactlyOnceWith(false);

      mountQuotaCard({ enabled: true, resetAt }, 'zh');
      await nextTick();
      expect(host.querySelector('.tf-auto-continue')?.textContent?.trim()).toBe('额度恢复后自动继续');
      expect(host.querySelector('.tf-resume-at')?.textContent?.trim()).toBe('将于 19:34 自动继续');
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders unchecked toggle without a resume time when unscheduled', async () => {
    const onSetQuotaAutoContinue = mountQuotaCard({ enabled: false, resetAt: null });
    await nextTick();
    const checkbox = host.querySelector<HTMLInputElement>('.tf-auto-continue input[type="checkbox"]');
    expect(checkbox?.checked).toBe(false);
    expect(host.querySelector('.tf-resume-at')).toBeNull();

    checkbox!.click();
    await nextTick();
    expect(onSetQuotaAutoContinue).toHaveBeenCalledExactlyOnceWith(true);
  });
});

describe('ChatPane compaction checkpoint card', () => {
  it('renders a borderless-line checkpoint card with chevron-only indicator and toggles open state', async () => {
    const state = reactive({ openTurnId: null as string | null });
    const openCompaction = vi.fn(({ turnId }: { turnId: string }) => {
      state.openTurnId = state.openTurnId === turnId ? null : turnId;
    });
    const isCompactionOpen = (turnId: string) => state.openTurnId === turnId;
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
        provide(panelApiKey, { openCompaction, isCompactionOpen } as unknown as PanelApi);
        return () => h(ChatPane, { turns: [userTurn, compactionTurn], sessionId: 's1' } as never);
      },
    });
    app.use(createKimiI18n({ locale: 'zh' }));
    app.mount(host);
    await nextTick();

    const divider = host.querySelector<HTMLElement>('.compact-divider--compacted');
    expect(divider?.querySelector('.cd-line')).toBeNull();
    const card = host.querySelector<HTMLButtonElement>('.compact-divider--compacted button.cd-card.cd-btn');
    expect(card).not.toBeNull();
    expect(card?.querySelector('.cd-body > .cd-title')?.textContent).toBe('上下文已压缩');
    expect(card?.querySelector('.cd-body > .cd-metrics > .cd-tokens')?.textContent).toBe('93.2k → 81k tokens');
    expect(card?.querySelector('.cd-body > .cd-metrics > .cd-saved')?.textContent).toBe('-12.2k');
    expect(card?.querySelector('.cd-view')).toBeNull();
    expect(card?.querySelector(':scope > .cd-chevron')).not.toBeNull();
    expect(card?.getAttribute('aria-expanded')).toBe('false');
    expect(card?.classList.contains('cd-open')).toBe(false);

    card!.click();
    await nextTick();
    expect(openCompaction).toHaveBeenCalledExactlyOnceWith({ turnId: 'c1' });
    expect(card?.getAttribute('aria-expanded')).toBe('true');
    expect(card?.classList.contains('cd-open')).toBe(true);

    card!.click();
    await nextTick();
    expect(openCompaction).toHaveBeenCalledTimes(2);
    expect(card?.getAttribute('aria-expanded')).toBe('false');
    expect(card?.classList.contains('cd-open')).toBe(false);
  });

  it('omits savings badge and chevron when tokens did not decrease or summary cannot open', async () => {
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
    expect(card?.querySelector('.cd-chevron')).toBeNull();
  });
});

describe('CompactionPanel', () => {
  it('strips legacy wrappers, renders markdown, and shows EmptyState when unavailable', async () => {
    const state = reactive({
      text: 'The conversation so far has been compacted to free up context. What follows is your own working summary.\n\n## Handoff\n- Updated `src/App.vue`\n\n<system-reminder>wire pointer</system-reminder>' as string | null,
    });
    app = createApp({
      setup() {
        return () => h(CompactionPanel, { turnId: 'c1', text: state.text, cwd: '/workspace' });
      },
    });
    app.use(createKimiI18n({ locale: 'zh' }));
    app.mount(host);
    await nextTick();

    const bodyText = host.querySelector('.cp-doc .msg')?.textContent ?? '';
    expect(bodyText).toContain('## Handoff');
    expect(bodyText).not.toContain('The conversation so far has been compacted');
    expect(bodyText).not.toContain('system-reminder');

    state.text = null;
    await nextTick();
    expect(host.querySelector('.cp-empty')).not.toBeNull();
    expect(host.textContent).toContain('摘要内容尚未加载');
  });
});
