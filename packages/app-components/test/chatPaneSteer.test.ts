// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App, type Ref } from 'vue';
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
import { createComposerSnapshot, textToDoc, type ComposerDocumentSnapshot } from '@moonshot-ai/app-composer/model';
import { useConfirmDialog, useTranscriptScroll, useTurnFolding, type TranscriptScroll } from '@moonshot-ai/app-client/composables';
import ChatPane from '../src/chat/ChatPane.vue';
import { resetInMemorySettledSteerTurnIds } from '../src/chat/steerContinuationState';
import { forgetCreateRuns } from '../src/worktree/createBlockMemory';
import { getByRole, getByText, iconStub, msg, queryByRole } from './helpers/dom';

function turn(over: Partial<ChatTurn>): ChatTurn {
  return { id: 't1', role: 'user', no: 1, text: '', ...over } as ChatTurn;
}

const previousAssistant = turn({
  id: 'a-before',
  role: 'assistant',
  no: 1,
  text: 'Previous step',
  daemonTurnId: 7,
  forkTurnIndex: 7,
  daemonTurnState: 'completed',
});
const injectedSteer = turn({
  id: 'u-steer',
  role: 'user',
  no: 2,
  text: 'Focus on the regression test',
  steered: true,
  steerPhase: 'injected',
});

let app: App | null = null;
let host: HTMLDivElement;
const forkTurn = vi.fn();

type ChatPaneExpose = {
  copyFinalSummary: (onCopied?: (ok: boolean) => void) => void;
};

function mount(
  turns: Ref<ChatTurn[]>,
  paneRef?: Ref<ChatPaneExpose | null>,
  working: Ref<boolean> | boolean = true,
  onEditMessage?: (payload: { text: string; turnId?: string }) => void,
): void {
  app = createApp({
    setup() {
      return () => {
        const active = typeof working === 'boolean' ? working : working.value;
        return h(ChatPane, {
          turns: turns.value,
          working: active,
          turnActive: active,
          forkEnabled: true,
          undoable: onEditMessage !== undefined,
          onForkTurn: forkTurn,
          onEditMessage,
          ref: paneRef,
        });
      };
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

describe('ChatPane steer progress', () => {
  it('hides the read receipt and returns to the regular working label when continuation output arrives', async () => {
    const turns = ref<ChatTurn[]>([previousAssistant, injectedSteer]);
    const active = ref(true);
    mount(turns, undefined, active);
    await nextTick();
    expect(host.querySelector('.wi-label')?.textContent).toBe('Inserted — continuing');
    expect(host.querySelector('.u-steer-receipt')?.textContent).toBe('Read');
    expect(host.querySelectorAll('button[aria-label="Fork from here"]')).toHaveLength(1);

    const emptyContinuation = turn({
      id: 'a-after',
      role: 'assistant',
      no: 3,
      text: '',
      daemonTurnId: 8,
      forkTurnIndex: 8,
      daemonTurnState: 'running',
    });
    turns.value = [previousAssistant, injectedSteer, emptyContinuation];
    await nextTick();
    expect(host.querySelector('.wi-label')?.textContent).toBe('Inserted — continuing');
    expect(host.querySelector('.u-steer-receipt')?.textContent).toBe('Read');

    const continuation = turn({ ...emptyContinuation, id: 'a-after-final', text: 'Continuing' });
    turns.value = [previousAssistant, injectedSteer, emptyContinuation, continuation];
    await nextTick();
    expect(host.querySelector('.wi-label')?.textContent).toBe('Working…');
    expect(host.querySelector('.u-steer-receipt')).toBeNull();
    expect(host.querySelectorAll('button[aria-label="Fork from here"]')).toHaveLength(1);

    active.value = false;
    turns.value = [previousAssistant, injectedSteer, emptyContinuation, turn({ ...continuation, daemonTurnState: 'completed' })];
    await nextTick();
    const forkButtons = host.querySelectorAll<HTMLButtonElement>('button[aria-label="Fork from here"]');
    expect(forkButtons).toHaveLength(2);
    forkButtons[0]!.click();
    expect(forkTurn).toHaveBeenNthCalledWith(1, { turnIndex: 7 });
    forkButtons[1]!.click();
    expect(forkTurn).toHaveBeenNthCalledWith(2, { turnIndex: 8 });
  });

  it('keeps earlier steer receipts dismissed when consecutive steers interrupt transient thinking output', async () => {
    const opener = turn({ id: 'u-open', role: 'user', no: 1, text: 'Refactor auth module' });
    const steer1 = turn({
      id: 'u-steer-1',
      role: 'user',
      no: 2,
      text: 'Check token refresh first',
      steered: true,
      steerPhase: 'injected',
    });
    const turns = ref<ChatTurn[]>([opener, steer1]);
    mount(turns, undefined, true);
    await nextTick();
    expect([...host.querySelectorAll('.u-steer-receipt')].map((el) => el.textContent)).toEqual(['Read']);

    const step2Thinking = turn({
      id: 'a-step-2-thinking',
      role: 'assistant',
      no: 3,
      text: '',
      thinking: 'Inspecting token refresh race conditions…',
      blocks: [{ kind: 'thinking', thinking: 'Inspecting token refresh race conditions…', streaming: true }],
      daemonTurnId: 1,
      daemonTurnState: 'running',
    });
    turns.value = [opener, steer1, step2Thinking];
    await nextTick();
    expect(host.querySelectorAll('.u-steer-receipt')).toHaveLength(0);
    expect(host.querySelector('.wi-label')?.textContent).toBe('Working…');

    const steer2Sending = turn({
      id: 'opt-steer-2',
      role: 'user',
      no: 3,
      text: 'Keep legacy cookie support too',
      steered: true,
      steerPhase: 'accepted',
    });
    turns.value = [opener, steer1, steer2Sending];
    await nextTick();
    expect([...host.querySelectorAll('.u-steer-receipt')].map((el) => el.textContent)).toEqual(['Unread']);
    expect(host.querySelectorAll('.u-turn')[1]?.querySelector('.u-steer-receipt')).toBeNull();
    expect(host.querySelectorAll('.u-turn')[2]?.querySelector('.u-steer-receipt')?.textContent).toBe('Unread');

    const steer2Injected = turn({
      ...steer2Sending,
      id: 'u-steer-2',
      steerPhase: 'injected',
    });
    turns.value = [opener, steer1, steer2Injected];
    await nextTick();
    expect([...host.querySelectorAll('.u-steer-receipt')].map((el) => el.textContent)).toEqual(['Read']);
    expect(host.querySelectorAll('.u-turn')[1]?.querySelector('.u-steer-receipt')).toBeNull();
    expect(host.querySelectorAll('.u-turn')[2]?.querySelector('.u-steer-receipt')?.textContent).toBe('Read');

    const step3Thinking = turn({
      id: 'a-step-3-thinking',
      role: 'assistant',
      no: 4,
      text: '',
      thinking: 'Checking cookie fallback…',
      blocks: [{ kind: 'thinking', thinking: 'Checking cookie fallback…', streaming: true }],
      daemonTurnId: 1,
      daemonTurnState: 'running',
    });
    turns.value = [opener, steer1, steer2Injected, step3Thinking];
    await nextTick();
    expect(host.querySelectorAll('.u-steer-receipt')).toHaveLength(0);

    const steer3Injected = turn({
      id: 'u-steer-3',
      role: 'user',
      no: 4,
      text: 'Also add regression tests',
      steered: true,
      steerPhase: 'injected',
    });
    turns.value = [opener, steer1, steer2Injected, steer3Injected];
    await nextTick();
    expect([...host.querySelectorAll('.u-steer-receipt')].map((el) => el.textContent)).toEqual(['Read']);
    expect(host.querySelectorAll('.u-turn')[1]?.querySelector('.u-steer-receipt')).toBeNull();
    expect(host.querySelectorAll('.u-turn')[2]?.querySelector('.u-steer-receipt')).toBeNull();
    expect(host.querySelectorAll('.u-turn')[3]?.querySelector('.u-steer-receipt')?.textContent).toBe('Read');
  });

  it('preserves dismissed steer receipts when ChatPane remounts across session switches', async () => {
    const opener = turn({ id: 'u-open-remount', role: 'user', no: 1, text: 'Refactor auth module' });
    const steer1 = turn({
      id: 'u-steer-remount-1',
      role: 'user',
      no: 2,
      text: 'Check token refresh first',
      steered: true,
      steerPhase: 'injected',
    });
    const step2Thinking = turn({
      id: 'a-step-2-remount-thinking',
      role: 'assistant',
      no: 3,
      text: '',
      thinking: 'Inspecting token refresh…',
      blocks: [{ kind: 'thinking', thinking: 'Inspecting token refresh…', streaming: true }],
      daemonTurnId: 1,
      daemonTurnState: 'running',
    });
    const steer2 = turn({
      id: 'u-steer-remount-2',
      role: 'user',
      no: 3,
      text: 'Keep legacy cookie support too',
      steered: true,
      steerPhase: 'injected',
    });

    const sessionId = ref('sess-remount-a');
    const sessionLoading = ref(false);
    const turns = ref<ChatTurn[]>([opener, steer1, step2Thinking]);

    app = createApp({
      setup() {
        return () =>
          h(ChatPane, {
            key: sessionId.value,
            sessionId: sessionId.value,
            sessionLoading: sessionLoading.value,
            turns: turns.value,
            working: true,
            turnActive: true,
          });
      },
    });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await nextTick();
    expect(host.querySelectorAll('.u-steer-receipt')).toHaveLength(0);

    turns.value = [opener, steer1, steer2];
    await nextTick();
    expect([...host.querySelectorAll('.u-steer-receipt')].map((el) => el.textContent)).toEqual(['Read']);

    sessionId.value = 'sess-remount-b';
    turns.value = [];
    await nextTick();
    expect(host.querySelectorAll('.u-steer-receipt')).toHaveLength(0);

    sessionLoading.value = true;
    sessionId.value = 'sess-remount-a';
    turns.value = [];
    await nextTick();

    sessionLoading.value = false;
    turns.value = [opener, steer1, steer2];
    await nextTick();
    expect([...host.querySelectorAll('.u-steer-receipt')].map((el) => el.textContent)).toEqual(['Read']);
    expect(host.querySelectorAll('.u-turn')[1]?.querySelector('.u-steer-receipt')).toBeNull();
    expect(host.querySelectorAll('.u-turn')[2]?.querySelector('.u-steer-receipt')?.textContent).toBe('Read');

    app.unmount();
    app = null;
    host.innerHTML = '';
    resetInMemorySettledSteerTurnIds();

    app = createApp({
      setup() {
        return () =>
          h(ChatPane, {
            key: 'sess-remount-a',
            sessionId: 'sess-remount-a',
            sessionLoading: false,
            turns: [opener, steer1, steer2],
            working: true,
            turnActive: true,
          });
      },
    });
    app.use(createKimiI18n({ locale: 'en' }));
    app.mount(host);
    await nextTick();
    expect([...host.querySelectorAll('.u-steer-receipt')].map((el) => el.textContent)).toEqual(['Read']);
    expect(host.querySelectorAll('.u-turn')[1]?.querySelector('.u-steer-receipt')).toBeNull();
    expect(host.querySelectorAll('.u-turn')[2]?.querySelector('.u-steer-receipt')?.textContent).toBe('Read');
  });
});

describe('ChatPane skill editing', () => {
  it('restores a hand-typed default skill command after confirming undo', async () => {
    const editMessage = vi.fn<(payload: { text: string; turnId?: string }) => void>();
    const skillTurn = turn({
      id: 'u-skill',
      undoTurnId: 'turn-u-skill',
      text: 'src/app.ts',
      skillActivation: {
        name: 'review',
        args: 'src/app.ts',
        path: '/work/A/review/SKILL.md',
      },
    });
    mount(ref([skillTurn]), undefined, false, editMessage);
    await nextTick();

    host.querySelector<HTMLButtonElement>('.u-edit')!.click();
    await useConfirmDialog().runAction();

    await vi.waitFor(() => {
      expect(editMessage).toHaveBeenCalledWith(expect.objectContaining({
        text: '/skill:review src/app.ts',
        turnId: 'turn-u-skill',
      }));
    });
  });

  it('restores bundled legacy and current default pills after confirming undo', async () => {
    const editMessage = vi.fn<(payload: { text: string; turnId?: string }) => void>();
    const legacy = '[review](kimi-code://skill/review)';
    const selected = '[review](kimi-code://skill/review?path=%2Fwork%2FA%2Freview%2FSKILL.md)';
    const skillTurn = turn({
      id: 'u-bundled-skill',
      undoTurnId: 'turn-u-bundled-skill',
      text: `${legacy} then ${selected}`,
      skillActivations: [{ name: 'review', path: '/work/A/review/SKILL.md' }],
    });
    mount(ref([skillTurn]), undefined, false, editMessage);
    await nextTick();

    host.querySelector<HTMLButtonElement>('.u-edit')!.click();
    await useConfirmDialog().runAction();

    await vi.waitFor(() => {
      expect(editMessage).toHaveBeenCalledWith(expect.objectContaining({
        text: skillTurn.text,
        turnId: 'turn-u-bundled-skill',
      }));
    });
  });

  it('pins a legacy single-skill echo to the actual variant path', async () => {
    const legacy = '[review](kimi-code://skill/review)';
    const secondary = '[review](kimi-code://skill/review?path=%2Fwork%2FB%2Freview%2FSKILL.md)';
    const skillTurn = turn({
      id: 'u-legacy-skill',
      text: legacy,
      skillActivation: { name: 'review', args: legacy, path: '/work/B/review/SKILL.md' },
    });
    mount(ref([skillTurn]), undefined, false);
    await nextTick();

    expect(host.querySelector('.u-text')?.textContent).toBe(secondary);
  });

  it('pins legacy snapshot pills in both echo and edit restoration', async () => {
    const legacy = '[review](kimi-code://skill/review)';
    const secondary = '[review](kimi-code://skill/review?path=%2Fwork%2FB%2Freview%2FSKILL.md)';
    const snapshot = createComposerSnapshot(textToDoc(legacy, { reviveMentions: true }), [], []);
    const editMessage = vi.fn<(payload: { text: string; turnId?: string; snapshot?: ComposerDocumentSnapshot }) => void>();
    const skillTurn = turn({
      id: 'u-legacy-snapshot-skill',
      undoTurnId: 'turn-u-legacy-snapshot-skill',
      text: legacy,
      clientMetadata: [{ kimi_code_composer: snapshot }],
      skillActivation: { name: 'review', args: legacy, path: '/work/B/review/SKILL.md' },
    });
    mount(ref([skillTurn]), undefined, false, editMessage);
    await nextTick();
    expect(host.querySelector('.u-text')?.textContent).toBe(secondary);

    host.querySelector<HTMLButtonElement>('.u-edit')!.click();
    await useConfirmDialog().runAction();

    await vi.waitFor(() => {
      expect(editMessage).toHaveBeenCalledWith(expect.objectContaining({
        text: secondary,
        turnId: 'turn-u-legacy-snapshot-skill',
      }));
    });
    const restored = editMessage.mock.calls[0]?.[0].snapshot;
    expect(restored?.doc.content?.[0]?.content?.[0]?.attrs?.path).toBe('/work/B/review/SKILL.md');
  });

  it('pins bundled legacy skill echoes to their known non-default variant', async () => {
    const legacy = '[review](kimi-code://skill/review)';
    const secondary = '[review](kimi-code://skill/review?path=%2Fwork%2FB%2Freview%2FSKILL.md)';
    const skillTurn = turn({
      id: 'u-bundled-legacy-skill',
      text: `${legacy} then ${legacy}`,
      skillActivations: [{ name: 'review', path: '/work/B/review/SKILL.md' }],
    });
    mount(ref([skillTurn]), undefined, false);
    await nextTick();

    expect(host.querySelector('.u-text')?.textContent).toBe(`${secondary} then ${secondary}`);
  });
});

describe('ChatPane final summary', () => {
  it('copies only the latest final answer across an assistant run', async () => {
    clipboard.copy.mockResolvedValue(true);
    const first = turn({
      id: 'a-first',
      role: 'assistant',
      no: 1,
      text: 'First final',
      blocks: [{ kind: 'text', text: 'First final', final: true }],
    });
    const latest = turn({
      id: 'a-latest',
      role: 'assistant',
      no: 2,
      text: 'Latest final',
      blocks: [{ kind: 'text', text: 'Latest final' }],
    });
    const paneRef = ref<ChatPaneExpose | null>(null);
    mount(ref([first, latest]), paneRef);
    await nextTick();

    const onCopied = vi.fn();
    paneRef.value?.copyFinalSummary(onCopied);

    await vi.waitFor(() => expect(clipboard.copy).toHaveBeenCalledWith('Latest final'));
    expect(onCopied).toHaveBeenCalledWith(true);
  });
});

describe('ChatPane assistant footers', () => {
  const before = turn({
    id: 'a-footer-before',
    role: 'assistant',
    no: 1,
    text: 'Before steer',
    createdAt: '2026-01-01T00:00:00.000Z',
    blocks: [{ kind: 'text', text: 'Before steer', final: true }],
  });
  const after = turn({
    id: 'a-footer-after',
    role: 'assistant',
    no: 3,
    text: 'After steer',
    createdAt: '2026-01-01T00:01:00.000Z',
    blocks: [{ kind: 'text', text: 'After steer' }],
  });

  it('hides only the footer before a steered user message', async () => {
    mount(ref([before, injectedSteer, after]), undefined, false);
    await nextTick();

    expect(host.querySelectorAll('.a-msg-ft')).toHaveLength(1);
    expect(host.querySelectorAll('.a-time')).toHaveLength(1);
    expect(host.querySelectorAll('.a-cpbtn')).toHaveLength(1);
    expect(host.querySelector('.a-msg-ft')?.closest('.a-msg')?.textContent).toContain('After steer');
  });

  it('keeps footers around a normal user message', async () => {
    const normalUser = turn({ id: 'u-normal', role: 'user', no: 2, text: 'Next request' });
    mount(ref([before, normalUser, after]), undefined, false);
    await nextTick();

    expect(host.querySelectorAll('.a-msg-ft')).toHaveLength(2);
    expect(host.querySelectorAll('.a-time')).toHaveLength(2);
    expect(host.querySelectorAll('.a-cpbtn')).toHaveLength(2);
  });

  it('estimates folded assistant turns by their collapsed header and visible blocks instead of hidden progress text', async () => {
    const { setTurnFolding } = useTurnFolding();
    setTurnFolding(true);
    try {
      host.className = 'panes';
      const foldedHeavy = turn({
        id: 'a-folded-heavy',
        role: 'assistant',
        no: 1,
        text: `${'progress '.repeat(600)}\nDone`,
        blocks: [
          { kind: 'text', text: 'progress '.repeat(600) },
          { kind: 'tool', tool: { id: 'tool-1', name: 'Read', arg: '{}', status: 'ok' } },
          { kind: 'text', text: 'Done', final: true },
        ],
      });
      const tailTurns = Array.from({ length: 4 }, (_, index) =>
        turn({ id: `u-tail-${index}`, role: 'user', no: index + 2, text: `q${index}` }),
      );
      let scroll!: TranscriptScroll;
      app = createApp({
        setup() {
          scroll = useTranscriptScroll({ sessionId: () => 's-fold' });
          return () => h('div', { ref: (el: unknown) => scroll.bindScroller(el as HTMLElement | null) }, [
            h(ChatPane, { turns: [foldedHeavy, ...tailTurns], sessionId: 's-fold', windowHistory: true }),
          ]);
        },
      });
      app.use(createKimiI18n({ locale: 'en' }));
      app.mount(host);
      await nextTick();
      await nextTick();

      const model = scroll.host.model;
      const index = model.indexOf('a-folded-heavy');
      expect(index).toBe(0);
      expect(model.isMeasured(index)).toBe(false);
      expect(model.height(index)).toBeLessThan(500);
    } finally {
      setTurnFolding(false);
    }
  });
});

describe('ChatPane worktree creation block', () => {
  const firstPrompt = turn({ id: 'u1', text: 'Hello' });
  const reply = turn({ id: 'a1', role: 'assistant', no: 2, text: 'Hi', daemonTurnId: 1, daemonTurnState: 'completed' });
  const secondPrompt = turn({ id: 'u2', no: 3, text: 'Again' });
  const blocks = () => [...host.querySelectorAll<HTMLElement>('[data-worktree-create-block]')];
  const steerButton = () => queryByRole(host, 'button', { name: msg('composer.queueSteer') });

  async function mountPane(props: Record<string, unknown> | (() => Record<string, unknown>)): Promise<void> {
    const read = typeof props === 'function' ? props : () => props;
    app = createApp({ render: () => h(ChatPane, { sessionId: 's1', ...read() }) });
    app.use(createKimiI18n({ locale: 'en' }));
    app.provide(IconResolverKey, iconStub);
    app.mount(host);
    await nextTick();
  }

  beforeEach(() => {
    forgetCreateRuns();
  });

  it('renders one block right after the first user message', async () => {
    await mountPane({ turns: [firstPrompt, reply, secondPrompt], worktree: sessionWorktree('ready', { path: '/w' }) });

    expect(blocks()).toHaveLength(1);
    const bubble = host.querySelector<HTMLElement>('[data-turn-id="u1"]')!;
    expect(bubble.parentElement!.lastElementChild).toBe(blocks()[0]);
    expect(getByRole(blocks()[0]!, 'status', { name: msg('worktreeCreate.block.created') })).toBeTruthy();
  });

  it('renders no block for a local session or before the start of the history is loaded', async () => {
    await mountPane({ turns: [firstPrompt, reply] });
    expect(blocks()).toHaveLength(0);
    app?.unmount();

    await mountPane({ turns: [secondPrompt], worktree: sessionWorktree('ready', { path: '/w' }), hasMoreMessages: true });
    expect(blocks()).toHaveLength(0);
  });

  it('withholds the queue steer control while the worktree holds prompts', async () => {
    const queued: QueuedPromptView[] = [{ id: 'q1', text: 'Next', attachmentCount: 0 }];
    const held = ref<AppSessionWorktree>(sessionWorktree('failed', {}, { failure: { kind: 'fetch_failed' } }));
    const onSteerQueued = vi.fn();
    await mountPane(() => ({ turns: [firstPrompt], queued, worktree: held.value, onSteerQueued }));
    expect(getByText(host, 'Next')).toBeTruthy();
    expect(steerButton()).toBeNull();

    held.value = sessionWorktree('ready', { path: '/w' });
    await nextTick();
    steerButton()!.click();
    expect(onSteerQueued).toHaveBeenCalledExactlyOnceWith(0);
  });
});
