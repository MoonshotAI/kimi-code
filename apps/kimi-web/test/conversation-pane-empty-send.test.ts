import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import ConversationPane from '../src/components/ConversationPane.vue';
import type { ChatTurn, ConversationStatus } from '../src/types';

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

let resizeCallbacks: ResizeObserverCallback[] = [];
class MockResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    resizeCallbacks.push(cb);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function mountPane(extraProps: Record<string, unknown> = {}) {
  resizeCallbacks = [];
  vi.stubGlobal('ResizeObserver', MockResizeObserver);

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
      fileReloadKey: 'no-session',
      sessionLoading: false,
      running: false,
      ...extraProps,
    },
    global: {
      plugins: [i18n],
      stubs: {
        ChatHeader: true,
        ChatPane: true,
        GoalStrip: true,
        TasksPane: true,
        TodoCard: true,
        Terminal: true,
        SwarmCard: true,
      },
    },
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  try { localStorage.clear(); } catch { /* ignore */ }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ConversationPane empty-session send', () => {
  it('clears the empty composer and keeps the new-session draft empty after send', async () => {
    const wrapper = mountPane({ sessionId: '' });
    await nextTick();

    const textarea = wrapper.find('textarea.ph');
    expect(textarea.exists()).toBe(true);
    const el = textarea.element as HTMLTextAreaElement;

    // Type in the empty-session composer.
    await textarea.setValue('hello world');
    expect(el.value).toBe('hello world');
    expect(localStorage.getItem('kimi-web.draft.__new__')).toBe('hello world');

    // Simulate the parent handling submit: no active session -> create session and send.
    // The composer clears itself synchronously before emitting submit.
    await textarea.trigger('keydown', { key: 'Enter' });

    // Composer should be empty immediately after submit.
    expect(el.value).toBe('');
    expect(localStorage.getItem('kimi-web.draft.__new__')).toBe(null);

    // Parent now creates/selects a new session and switches to loading.
    await wrapper.setProps({ sessionId: 'sess_new', sessionLoading: true, fileReloadKey: 'sess_new' });
    await nextTick();

    // Loading state: the dock composer is shown; its value must be empty.
    const dockDuringLoading = wrapper.find('textarea.ph');
    expect(dockDuringLoading.exists()).toBe(true);
    expect((dockDuringLoading.element as HTMLTextAreaElement).value).toBe('');

    // Snapshot returns: still no turns, loading cleared.
    await wrapper.setProps({ sessionLoading: false });
    await nextTick();

    // Empty composer remounts for the new session before the optimistic message lands.
    const remounted = wrapper.find('textarea.ph');
    expect(remounted.exists()).toBe(true);
    expect((remounted.element as HTMLTextAreaElement).value).toBe('');
    expect(localStorage.getItem('kimi-web.draft.sess_new')).toBe(null);

    // Optimistic user message lands.
    const turn: ChatTurn = {
      id: 'msg_1',
      role: 'user',
      text: 'hello world',
      blocks: [{ kind: 'text', text: 'hello world' }],
    };
    await wrapper.setProps({ turns: [turn] });
    await nextTick();

    // Chat dock composer mounts; its draft for the new session must also be empty.
    const dockTextarea = wrapper.find('textarea.ph');
    expect(dockTextarea.exists()).toBe(true);
    expect((dockTextarea.element as HTMLTextAreaElement).value).toBe('');
    expect(localStorage.getItem('kimi-web.draft.sess_new')).toBe(null);
  });
});
