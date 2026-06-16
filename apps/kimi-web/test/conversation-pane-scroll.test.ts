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
      fileReloadKey: 'sess_1',
      sessionLoading: false,
      running: false,
      ...extraProps,
    },
    global: {
      plugins: [i18n],
      stubs: {
        ChatHeader: true,
        ChatPane: true,
        Composer: true,
        GoalStrip: true,
        TasksPane: true,
        TodoCard: true,
        Terminal: true,
        SwarmCard: true,
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
      fileReloadKey: 'sess_1',
      sessionLoading: false,
      running: false,
      ...extraProps,
    },
    global: {
      plugins: [i18n],
      stubs: {
        ChatHeader: true,
        ChatPane: true,
        Composer: true,
        GoalStrip: true,
        ChatDock: true,
        SwarmCard: true,
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
    panesEl.dispatchEvent(new Event('scroll'));
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
    panesEl.dispatchEvent(new Event('scroll'));

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
