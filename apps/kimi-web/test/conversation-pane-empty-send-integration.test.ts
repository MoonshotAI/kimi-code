// apps/kimi-web/test/conversation-pane-empty-send-integration.test.ts
//
// Integration test that drives the real useKimiWebClient + ConversationPane
// through the empty-session -> send -> new session flow. We want to verify that
// the composer text is cleared and does not reappear in the docked composer.

import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import type { AppSession, KimiEventHandlers, KimiWebApi } from '../src/api/types';
import ConversationPane from '../src/components/ConversationPane.vue';
import { defineComponent, h, type VNode } from 'vue';

const now = '2026-06-11T00:00:00.000Z';

function makeSession(id: string, overrides?: Partial<AppSession>): AppSession {
  return {
    id,
    title: id,
    createdAt: now,
    updatedAt: now,
    status: 'idle',
    cwd: '/repo',
    model: 'kimi-test',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextLimit: 128_000,
      turnCount: 0,
    },
    messageCount: 0,
    lastSeq: 0,
    ...overrides,
  };
}

async function setup() {
  vi.resetModules();
  vi.stubGlobal('WebSocket', class WebSocket {});

  let handlers: KimiEventHandlers | undefined;
  const eventConn = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    bindNextPromptId: vi.fn(),
    seedSnapshot: vi.fn(),
    abort: vi.fn(),
    close: vi.fn(),
  };

  const created = makeSession('sess_new');
  const api = {
    createSession: vi.fn(async () => created),
    submitPrompt: vi.fn(async () => ({ promptId: 'pr_1', userMessageId: 'msg_real' })),
    addWorkspace: vi.fn(async () => ({ id: 'ws_repo', root: '/repo', name: 'repo', isGitRepo: false, sessionCount: 0 })),
    deleteWorkspace: vi.fn(async () => ({ deleted: true })),
    listWorkspaces: vi.fn(async () => []),
    browseFs: vi.fn(async (path?: string) => ({ path: path ?? '/home/user', parent: null, entries: [] })),
    getFsHome: vi.fn(async () => ({ home: '/home/user', recentRoots: [] })),
    listSessions: vi.fn(async () => ({ items: [], hasMore: false })),
    getHealth: vi.fn(async () => ({ ok: true })),
    getMeta: vi.fn(async () => ({ daemonVersion: '0.0.1' })),
    getSessionStatus: vi.fn(async () => ({
      model: 'kimi-test',
      thinkingLevel: 'high',
      permission: 'manual',
      planMode: false,
      swarmMode: false,
      contextTokens: 0,
      maxContextTokens: 128_000,
      contextUsage: 0,
    })),
    getSessionSnapshot: vi.fn(async () => ({
      asOfSeq: 0,
      epoch: 'ep_test',
      session: created,
      messages: [],
      hasMoreMessages: false,
      inFlightTurn: null,
      pendingApprovals: [],
      pendingQuestions: [],
    })),
    listTasks: vi.fn(async () => []),
    getGitStatus: vi.fn(async () => ({ branch: 'main', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0 })),
    connectEvents: vi.fn((nextHandlers: KimiEventHandlers) => {
      handlers = nextHandlers;
      return eventConn;
    }),
    getFileUrl: vi.fn((fileId: string) => `/files/${fileId}`),
  } as unknown as KimiWebApi;

  vi.doMock('../src/api', () => ({ getKimiWebApi: () => api }));
  const { useKimiWebClient } = await import('../src/composables/useKimiWebClient');

  return {
    api,
    client: useKimiWebClient(),
    eventConn,
    getHandlers: () => {
      if (!handlers) throw new Error('connectEvents was not called');
      return handlers;
    },
  };
}

let resizeCallbacks: ResizeObserverCallback[] = [];
class MockResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    resizeCallbacks.push(cb);
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

afterEach(() => {
  document.body.innerHTML = '';
  try { localStorage.clear(); } catch { /* ignore */ }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resizeCallbacks = [];
});

describe('ConversationPane empty-session send integration', () => {
  it('clears the composer through the real client flow', async () => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    const { client } = await setup();
    await client.addWorkspaceByPath('/repo');
    client.openWorkspaceDraft('ws_repo');

    const i18n = createI18n({
      legacy: false,
      locale: 'en',
      messages: { en: {} },
      missingWarn: false,
      fallbackWarn: false,
    });

    async function handleSubmit(payload: { text: string; attachments: { fileId: string; kind: 'image' | 'video' }[] }): Promise<void> {
      const wsId = client.activeWorkspaceId.value;
      if (!client.activeSessionId.value && wsId) {
        await client.startSessionAndSendPrompt(wsId, payload.text, payload.attachments);
      }
    }

    const TestWrapper = defineComponent({
      setup() {
        return () =>
          h(ConversationPane, {
            mobile: true,
            turns: client.turns.value,
            sessionId: client.activeSessionId.value,
            tasks: client.tasks.value,
            status: client.status.value,
            sessionLoading: client.sessionLoading.value,
            running: client.activity.value !== 'idle',
            queued: client.queued.value,
            sending: client.isSending.value,
            models: client.models.value,
            skills: client.skills.value,
            workspaces: client.workspacesView.value,
            activeWorkspaceId: client.activeWorkspaceId.value,
            workspaceName: client.visibleWorkspace.value?.name,
            workspaceRoot: client.visibleWorkspace.value?.root ?? client.status.value.cwd,
            fileReloadKey: client.activeSessionId.value,
            onSubmit: handleSubmit,
          } as Record<string, unknown>);
      },
    });

    const wrapper = mount(TestWrapper, {
      attachTo: document.body,
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

    await nextTick();

    const textarea = wrapper.find('textarea.ph');
    expect(textarea.exists()).toBe(true);

    // Type in the empty-session composer.
    await textarea.setValue('hello integration');
    expect((textarea.element as HTMLTextAreaElement).value).toBe('hello integration');

    // Submit with Enter.
    await textarea.trigger('keydown', { key: 'Enter' });

    // Composer should be empty immediately.
    expect((wrapper.find('textarea.ph').element as HTMLTextAreaElement).value).toBe('');
    expect(localStorage.getItem('kimi-web.draft.__new__')).toBe(null);

    // Let the client flow finish.
    await vi.waitFor(() => expect(client.activeSessionId.value).toBe('sess_new'));
    await vi.waitFor(() => expect(client.sessionLoading.value).toBe(false));

    // No matter which composer is mounted now, its textarea must be empty.
    const final = wrapper.find('textarea.ph');
    expect(final.exists()).toBe(true);
    expect((final.element as HTMLTextAreaElement).value).toBe('');
    expect(localStorage.getItem('kimi-web.draft.sess_new')).toBe(null);
  });
});
