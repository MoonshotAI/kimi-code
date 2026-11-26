// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clipboard = vi.hoisted(() => ({ copy: vi.fn<(text: string) => Promise<boolean>>() }));

vi.mock('@moonshot-ai/app-core/lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  copyTextToClipboard: (text: string) => clipboard.copy(text),
}));

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
      skills: vue.ref([{ name: 'review', path: '/work/A/review/SKILL.md' }]),
      notify: vi.fn(),
      detachTask: vi.fn(),
      unqueue: vi.fn(),
    }),
    getKimiWebApi: () => ({}),
  };
});

import { createKimiI18n } from '@moonshot-ai/app-i18n';
import { IconResolverKey } from '@moonshot-ai/app-ui';
import { sessionWorktree } from '@moonshot-ai/app-client/testing';
import type { AppSessionWorktree } from '@moonshot-ai/app-core/api';
import type { ChatTurn, QueuedPromptView } from '@moonshot-ai/app-core/client/types';
import ChatPane from '../src/chat/ChatPane.vue';
import { forgetCreateRuns } from '../src/worktree/createBlockMemory';

function turn(over: Partial<ChatTurn>): ChatTurn {
  return { id: 't1', role: 'user', no: 1, text: '', ...over } as ChatTurn;
}

const firstPrompt = turn({ id: 'u1', text: 'Hello' });
const reply = turn({ id: 'a1', role: 'assistant', no: 2, text: 'Hi', daemonTurnId: 1, daemonTurnState: 'completed' });
const secondPrompt = turn({ id: 'u2', no: 3, text: 'Again' });

let app: App | null = null;
let host: HTMLDivElement;

async function mount(props: Record<string, unknown> | (() => Record<string, unknown>)): Promise<void> {
  const read = typeof props === 'function' ? props : () => props;
  app = createApp({ render: () => h(ChatPane, { sessionId: 's1', ...read() }) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(IconResolverKey, (name: string) => ({ render: () => h('svg', { 'data-icon': name }) }));
  app.mount(host);
  await nextTick();
}

const blocks = () => [...host.querySelectorAll<HTMLElement>('[data-worktree-create-block]')];

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
  forgetCreateRuns();
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.unstubAllGlobals();
});

describe('ChatPane worktree creation block', () => {
  it('renders one block directly below the first user message', async () => {
    await mount({ turns: [firstPrompt, reply, secondPrompt], worktree: sessionWorktree('ready', { path: '/w' }) });

    expect(blocks()).toHaveLength(1);
    const first = host.querySelector<HTMLElement>('[data-turn-id="u1"]')!.closest('.u-turn')!;
    expect(first.contains(blocks()[0]!)).toBe(true);
    expect(first.lastElementChild).toBe(blocks()[0]);
    expect(blocks()[0]?.querySelector('.wcb-title')?.textContent).toBe('Worktree created');
  });

  it('renders no block for a local session or before the start of the history is loaded', async () => {
    await mount({ turns: [firstPrompt, reply] });
    expect(blocks()).toHaveLength(0);
    app?.unmount();

    await mount({ turns: [secondPrompt], worktree: sessionWorktree('ready', { path: '/w' }), hasMoreMessages: true });
    expect(blocks()).toHaveLength(0);
  });

  it('hides the queue steer control while the worktree holds prompts', async () => {
    const queued: QueuedPromptView[] = [{ id: 'q1', text: 'Next', attachmentCount: 0 }];
    const held = ref<AppSessionWorktree>(sessionWorktree('failed', {}, { failure: { kind: 'fetch_failed' } }));
    await mount(() => ({ turns: [firstPrompt], queued, worktree: held.value }));
    expect(host.querySelector('.q-turn')).not.toBeNull();
    expect(host.querySelector('.q-send')).toBeNull();

    held.value = sessionWorktree('ready', { path: '/w' });
    await nextTick();
    expect(host.querySelector('.q-send')).not.toBeNull();
  });
});
