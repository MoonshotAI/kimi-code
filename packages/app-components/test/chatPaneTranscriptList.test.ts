// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
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
import type { ChatTurn } from '@moonshot-ai/app-core/client/types';
import { useTranscriptScroll, useTurnFolding, type TranscriptScroll } from '@moonshot-ai/app-client/composables';
import ChatPane from '../src/chat/ChatPane.vue';

const turns = [
  { id: 'u1', role: 'user', no: 1, text: 'Question' },
  {
    id: 'a1', role: 'assistant', no: 1, daemonTurnId: 1, daemonTurnState: 'completed',
    thinking: 'Reasoning', text: 'Final answer',
    tools: [{ id: 'tool-1', name: 'write', arg: '{"path":"a.ts"}', status: 'ok', output: ['done'] }],
  },
] as unknown as ChatTurn[];

let app: App | null = null;
let host: HTMLDivElement;
let scroll: TranscriptScroll;

function mount(windowed: boolean): void {
  app = createApp({
    setup() {
      if (windowed) scroll = useTranscriptScroll({ sessionId: () => 's1' });
      return () => h('div', { ref: (el: unknown) => windowed && scroll.bindScroller(el as HTMLElement | null) }, [
        h('div', [h(ChatPane, { turns, sessionId: 's1', windowHistory: true, historyState: new Map() })]),
      ]);
    },
  });
  app.use(createKimiI18n({ locale: 'en' }));
  app.mount(host);
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  useTurnFolding().setTurnFolding(true);
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = null;
  host.remove();
  vi.unstubAllGlobals();
});

describe('ChatPane with the transcript list', () => {
  it('renders one virtual list with static block lists and row and block keys', async () => {
    mount(true);
    await nextTick();
    await nextTick();
    expect(host.querySelectorAll('.transcript-list')).toHaveLength(1);
    const nested = [...host.querySelectorAll<HTMLElement>('.history-window')];
    expect(nested.length).toBeGreaterThan(0);
    for (const list of nested) {
      expect(list.getAttribute('role')).toBe('list');
      expect(list.querySelector('.history-space, .history-navigation')).toBeNull();
    }
    const rows = [...host.querySelectorAll<HTMLElement>('[data-row-key]')].map(el => el.dataset.rowKey);
    expect(rows).toEqual(['u1', 'a1']);
    const assistant = host.querySelector('[data-row-key="a1"]')!;
    expect(assistant.querySelector('[data-turn-id="a1"]')).not.toBeNull();
    const blocks = [...assistant.querySelectorAll<HTMLElement>('[data-block-key]')].map(el => el.dataset.blockKey);
    expect(blocks).toContain('fold');
    expect(blocks).toContain('footer');
    expect(blocks.some(key => key?.startsWith('text-'))).toBe(true);
  });

  it('holds the clicked fold header through the scroll controller', async () => {
    mount(true);
    await nextTick();
    await nextTick();
    const hold = vi.spyOn(scroll.host.controller.value!, 'hold');
    host.querySelector<HTMLElement>('.tf-head')!.click();
    await nextTick();
    expect(hold).toHaveBeenCalledTimes(1);
  });

  it('waits for web fonts before the scroll controller first measures', async () => {
    let fontsReady!: () => void;
    const ready = new Promise<void>((resolve) => { fontsReady = resolve; });
    const fonts = { status: 'loading', ready };
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
    try {
      mount(true);
      await nextTick();
      expect(scroll.host.controller.value).toBeNull();
      fonts.status = 'loaded';
      fontsReady();
      await ready;
      await nextTick();
      expect(scroll.host.controller.value).not.toBeNull();
    } finally {
      delete (document as { fonts?: unknown }).fonts;
    }
  });

  it('keeps the virtualized history windows without a transcript host', async () => {
    mount(false);
    await nextTick();
    expect(host.querySelector('.transcript-list')).toBeNull();
    expect(host.querySelectorAll('.history-window').length).toBeGreaterThan(1);
    expect(host.querySelector('.history-window [data-history-key][tabindex="-1"]')).not.toBeNull();
  });
});
