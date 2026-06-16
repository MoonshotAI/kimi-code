import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import ConversationPane from '../src/components/ConversationPane.vue';
import type { ConversationStatus } from '../src/types';

const status: ConversationStatus = {
  model: 'kimi-test',
  modelId: 'kimi-test',
  ctxUsed: 0,
  ctxMax: 0,
  permission: 'manual',
  branch: 'main',
  cwd: '/repo',
  isGitRepo: true,
};

function mountPane(extraProps: Record<string, unknown>) {
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: { en: {} },
    missingWarn: false,
    fallbackWarn: false,
  });
  return mount(ConversationPane, {
    attachTo: document.body,
    props: {
      mobile: true,
      turns: [],
      tasks: [],
      status,
      active: 'chat',
      fileReloadKey: 'sess_1',
      sessionLoading: false,
      running: false,
      ...extraProps,
    },
    global: {
      plugins: [i18n],
      stubs: {
        TabBar: true,
        ChatHeader: true,
        ChatPane: true,
        Composer: true,
        GoalStrip: true,
        TasksPane: true,
        TodoCard: true,
        Terminal: true,
        SwarmCard: true,
        FileTree: true,
        DiffView: true,
        ChangedTree: true,
        FilePreview: true,
      },
    },
  });
}

function mockPaneGeometry(
  el: HTMLElement,
  geometry: { scrollHeight: number; clientHeight: number; scrollTop: number },
): void {
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => geometry.scrollHeight,
  });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => geometry.clientHeight,
  });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    writable: true,
    value: geometry.scrollTop,
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mountDesktopPane(extraProps: Record<string, unknown>) {
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: { en: {} },
    missingWarn: false,
    fallbackWarn: false,
  });
  return mount(ConversationPane, {
    attachTo: document.body,
    props: {
      mobile: false,
      turns: [],
      tasks: [],
      status,
      active: 'chat',
      fileReloadKey: 'sess_1',
      sessionLoading: false,
      running: false,
      ...extraProps,
    },
    global: {
      plugins: [i18n],
      stubs: {
        TabBar: true,
        ChatHeader: true,
        ChatPane: true,
        Composer: true,
        GoalStrip: true,
        ChatDock: true,
        SwarmCard: true,
        FileTree: true,
        DiffView: true,
        ChangedTree: true,
        FilePreview: true,
      },
    },
  });
}

describe('ConversationPane session switch scroll', () => {
  it('scrolls to the bottom when switching to a shorter session', async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockReturnValue(100_000);

    const longTurns = Array.from({ length: 20 }, (_, i) => ({
      id: `t${i}`,
      role: 'user' as const,
      no: i + 1,
      text: `message ${i + 1}`,
    }));

    const wrapper = mountPane({
      turns: longTurns,
      fileReloadKey: 'sess-long',
    });
    await nextTick();

    const panesEl = wrapper.find('.chat-scroll').element as HTMLElement;
    mockPaneGeometry(panesEl, { scrollHeight: 2000, clientHeight: 500, scrollTop: 1500 });

    // Simulate the user having scrolled the long session to the bottom.
    await panesEl.dispatchEvent(new Event('scroll'));
    await nextTick();

    // Switch to a much shorter session. The fileReloadKey watcher resets the
    // scroll baseline synchronously; dispatch the transient clamping scroll
    // event right after setProps resolves but before the async watcher ticks
    // (scrollKey / scheduleStableFollow) run and overwrite lastScrollTop.
    await wrapper.setProps({
      fileReloadKey: 'sess-short',
      turns: [{ id: 't1', role: 'user' as const, no: 1, text: 'hi' }],
    });

    // Transient geometry: scrollHeight still large, scrollTop clamped to 0.
    mockPaneGeometry(panesEl, { scrollHeight: 2000, clientHeight: 500, scrollTop: 0 });
    await panesEl.dispatchEvent(new Event('scroll'));

    // Now let the async watcher ticks run.
    await nextTick();

    // New session finally settles to short geometry.
    mockPaneGeometry(panesEl, { scrollHeight: 300, clientHeight: 500, scrollTop: 0 });
    await nextTick();

    // Let scheduleStableFollow run its rAF ticks.
    vi.advanceTimersByTime(200);
    await nextTick();

    expect(panesEl.scrollTop).toBe(300);
  });
});

describe('ConversationPane split layout follow target', () => {
  it('follows the first chat group, not whichever chat pane mounted last', async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockReturnValue(100_000);

    // Two chat groups open side by side. The follow target must be the FIRST
    // chat group in the layout (deterministic), not whichever group's ref
    // callback fired last (which, in DOM order, is the second group).
    localStorage.setItem(
      'kimi-web.layout',
      JSON.stringify({
        type: 'split',
        id: 'split-1',
        dir: 'row',
        sizes: [1, 1],
        children: [
          { type: 'group', id: 'group-a', views: ['chat', 'files'], active: 'chat' },
          { type: 'group', id: 'group-b', views: ['chat', 'files'], active: 'chat' },
        ],
      }),
    );

    const turns = [{ id: 't1', role: 'user' as const, no: 1, text: 'hello' }];
    const wrapper = mountDesktopPane({ turns });
    await nextTick();
    await nextTick();

    const scrollers = wrapper.findAll('.chat-scroll');
    expect(scrollers).toHaveLength(2);
    const first = scrollers[0]!.element as HTMLElement;
    const second = scrollers[1]!.element as HTMLElement;

    // Both panes are scrolled up (not at the bottom). The follow machinery is
    // still in "following" mode by default.
    mockPaneGeometry(first, { scrollHeight: 2000, clientHeight: 500, scrollTop: 0 });
    mockPaneGeometry(second, { scrollHeight: 2000, clientHeight: 500, scrollTop: 0 });

    // New streaming content arrives on the last turn.
    await wrapper.setProps({
      turns: [...turns, { id: 't2', role: 'assistant' as const, no: 2, text: 'world' }],
    });
    await nextTick();
    vi.advanceTimersByTime(200);
    await nextTick();

    // The first chat group is the deterministic follow target and is pinned to
    // the bottom; the second pane is a mirror and is never yanked.
    expect(first.scrollTop).toBe(2000);
    expect(second.scrollTop).toBe(0);
  });
});
