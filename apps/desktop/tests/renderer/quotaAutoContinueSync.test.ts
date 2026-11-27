// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import type {
  AppSession,
  KimiEventConnection,
  KimiEventHandlers,
  KimiWebApi,
  ManagedQuotaResult,
  PromptSubmission,
  PromptSubmitResult,
} from '@moonshot-ai/app-core/api';
import { MANAGED_KIMI_CODE_PROVIDER_ID } from '@moonshot-ai/app-core/api';
import type { ConversationTurnHeader } from '@moonshot-ai/app-core/conversation';
import { STORAGE_KEYS } from '@moonshot-ai/app-core/lib';

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
    tableSelectionContextText: () => '',
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

const BASE_MS = Date.parse('2026-11-27T11:00:00.000Z');
const QUOTA_403 = {
  code: 'provider.auth_error',
  status_code: 403,
  message: "You've reached your 5-hour usage limit.",
};

function sessionFixture(id: string): AppSession {
  return {
    id,
    title: id,
    createdAt: '2026-11-27T09:00:00.000Z',
    updatedAt: '2026-11-27T09:00:00.000Z',
    busy: false,
    mainTurnActive: false,
    pendingInteraction: 'none',
    archived: false,
    cwd: '/workspace',
    model: 'k2',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextLimit: 0,
      turnCount: 0,
    },
    messageCount: 0,
    workspaceId: 'ws1',
  };
}

describe('quota auto-continue sync across session error cards and Settings', () => {
  let app: App | null = null;
  let host: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_MS);
    localStorage.clear();
    vi.stubGlobal('WebSocket', function () {});
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
    localStorage.clear();
  });

  it('syncs toggles across two failed sessions and Settings, cancels pending on off, and re-arms on on', async () => {
    const resetAt = new Date(BASE_MS + 45 * 60 * 1000).toISOString();
    localStorage.setItem(STORAGE_KEYS.quotaAutoResume, 'true');
    localStorage.setItem(STORAGE_KEYS.quotaAutoContinue, 'false');

    const sessions = [sessionFixture('s1'), sessionFixture('s2')];
    let handlers: KimiEventHandlers | undefined;
    const failedHeader: ConversationTurnHeader = {
      turn_id: 't0',
      ordinal: 0,
      kind: 'agent',
      status: 'ended',
      outcome: 'failed',
      started_at: '2026-11-27T10:59:00.000Z',
      steps: [],
      error: QUOTA_403,
    };
    const connection: KimiEventConnection = {
      subscribeConversation: vi.fn((sid: string) => {
        queueMicrotask(() => {
          handlers?.onConversation?.(sid, 'main', { type: 'turns', turns: [], has_more: false });
        });
      }),
      unsubscribeConversation: vi.fn(),
      watchTaskOutput: vi.fn(),
      unwatchTaskOutput: vi.fn(),
      stopTask: vi.fn(),
      backgroundTask: vi.fn(),
      health: () => ({ connected: true, open: true, stale: false }),
      reconnect: vi.fn(),
      close: vi.fn(),
    };
    const usage: ManagedQuotaResult = {
      kind: 'ok',
      quota: { usages: { limit5h: { usedRatio: 1, resetAt } }, extraUsage: null },
    };
    const getUsage = vi.fn(async () => usage);
    const submitPrompt = vi.fn<(sid: string, input: PromptSubmission) => Promise<PromptSubmitResult>>(
      async (_sid, input) => ({ promptId: input.promptId!, userMessageId: input.promptId!, status: 'running' }),
    );
    const workspaces = [{ id: 'ws1', root: '/workspace', name: 'Workspace', kind: 'managed' as const, additionalDirs: [], sessionCount: 2 }];
    const api: Partial<KimiWebApi> = {
      getAuth: vi.fn(async () => ({ modelsReady: true, providersCount: 1, managedProvider: null })),
      getHealth: vi.fn(async () => ({ status: 'ok' as const, uptimeSec: 1 })),
      getMeta: vi.fn(async () => ({
        protocolVersion: '1',
        serverVersion: '0.0.0',
        serverId: 'server-1',
        startedAt: '2026-11-27T09:00:00.000Z',
        homeDir: '/home/test/.kimi-code',
        webTitle: 'Kimi Code',
        capabilities: {},
        openInApps: [],
        dangerousBypassAuth: false,
        experimentalFlags: {},
        backend: 'v2' as const,
      })),
      getConfig: vi.fn(async () => ({ providers: {}, defaultModel: 'k2' })),
      listModels: vi.fn(async () => [
        { id: 'k2', provider: MANAGED_KIMI_CODE_PROVIDER_ID, model: 'k2', maxContextSize: 200000 },
      ]),
      listProviders: vi.fn(async () => []),
      listCatalogProviders: vi.fn(async () => []),
      listHosts: vi.fn(async () => []),
      listWorkspaces: vi.fn(async () => workspaces),
      getWorkspaceTrust: vi.fn(async () => ({ trusted: true })),
      getFsHome: vi.fn(async () => ({ home: '/home/test', recentRoots: [] })),
      listSessions: vi.fn(async () => ({ items: sessions, hasMore: false, nextPageToken: null, total: sessions.length })),
      listSessionGroups: vi.fn(async () => ({
        groups: [{ workspaceId: 'ws1', sessions: sessions.map((s) => ({ ...s, lastPrompt: 'hi' })), total: sessions.length }],
        hasMore: false,
        nextPageToken: null,
        total: sessions.length,
      })),
      getSession: vi.fn(async (id: string) => sessions.find((s) => s.id === id) ?? sessionFixture(id)),
      getSessionWarnings: vi.fn(async () => []),
      getGitStatus: vi.fn(async () => ({ branch: '', ahead: 0, behind: 0, entries: {}, additions: 0, deletions: 0, pullRequest: null })),
      listSkills: vi.fn(async () => []),
      listSkillsForWorkspace: vi.fn(async () => []),
      generateSessionTitle: vi.fn(async () => null),
      predictNextPrompt: vi.fn(async () => null),
      cancelPromptPrediction: vi.fn(async () => true),
      getFileUrl: (fileId: string) => `file:${fileId}`,
      getUsage,
      getAgentTurns: vi.fn(async () => ({ turns: [{ ...failedHeader, items: [] }], has_more: false })),
      submitPrompt,
      connectEvents: vi.fn((next: KimiEventHandlers) => {
        handlers = next;
        return connection;
      }),
    };

    const { setKimiClientDeps, resetKimiClientDeps, useKimiWebClient } = await import('@moonshot-ai/app-client/client');
    const agentState = (status: 'idle' | 'running') => ({
      status,
      compacting: false,
      planMode: false,
      swarmMode: false,
      towerMode: false,
    });
    const { clientPinia } = await import('@moonshot-ai/app-client/stores');
    const { SessionRatingKey } = await import('@moonshot-ai/app-client/contracts');
    const { IconResolverKey } = await import('@moonshot-ai/app-ui');
    const { ChatPane } = await import('@moonshot-ai/app-components');
    const { createKimiI18n } = await import('@moonshot-ai/app-i18n');
    const { default: SettingsDialog } = await import('../../src/renderer/components/settings/SettingsDialog.vue');

    const i18n = createKimiI18n({ locale: 'en' });
    setKimiClientDeps({ api: () => api as KimiWebApi, t: (key) => i18n.global.t(key) });
    const client = useKimiWebClient();
    await client.load();
    await client.selectSession('s1');
    await vi.waitFor(() => expect(client.sessionLoading.value).toBe(false));

    const failSession = (sid: string, turnId: string) => {
      handlers!.onAgentState?.(sid, 'main', agentState('running'));
      handlers!.onConversation?.(sid, 'main', {
        type: 'turn.started',
        turn: { ...failedHeader, turn_id: turnId, status: 'running', outcome: undefined, error: undefined },
      });
      handlers!.onConversation?.(sid, 'main', {
        type: 'turn.ended',
        turn: { ...failedHeader, turn_id: turnId, error: QUOTA_403 },
      });
      handlers!.onAgentState?.(sid, 'main', agentState('idle'));
    };
    failSession('s1', 't1');
    await client.selectSession('s2');
    await vi.waitFor(() => expect(client.sessionLoading.value).toBe(false));
    failSession('s2', 't2');
    await vi.advanceTimersByTimeAsync(0);
    expect(getUsage).not.toHaveBeenCalled();

    const cardError = {
      code: QUOTA_403.code,
      message: QUOTA_403.message,
      statusCode: QUOTA_403.status_code,
    };
    const userTurn = { id: 'u1', role: 'user', no: 1, text: 'hi', createdAt: '2026-11-27T10:59:00.000Z' } as never;

    app = createApp({
      setup() {
        return () =>
          h('div', [
            h(
              'section',
              { 'data-session': 's1' },
              [
                h(ChatPane, {
                  turns: [userTurn],
                  sessionId: 's1',
                  turnFailed: true,
                  turnError: cardError,
                  quotaAutoContinue: client.quotaAutoContinueFor('s1', cardError),
                  onSetQuotaAutoContinue: (on: boolean) => client.setQuotaAutoContinuePreference(on, 's1'),
                }),
              ],
            ),
            h(
              'section',
              { 'data-session': 's2' },
              [
                h(ChatPane, {
                  turns: [userTurn],
                  sessionId: 's2',
                  turnFailed: true,
                  turnError: cardError,
                  quotaAutoContinue: client.quotaAutoContinueFor('s2', cardError),
                  onSetQuotaAutoContinue: (on: boolean) => client.setQuotaAutoContinuePreference(on, 's2'),
                }),
              ],
            ),
            h(SettingsDialog, {
              colorScheme: 'light',
              fontScale: 'medium',
              notify: false,
              notifySound: false,
              initialTab: 'agent',
              onFetchUsage: async () => usage,
            }),
          ]);
      },
    });
    const { panelApiKey } = await import('@moonshot-ai/app-client/panel');
    app.provide(panelApiKey, undefined);
    app.provide(SessionRatingKey, { view: () => ({ phase: 'closed' }), shown: vi.fn(), select: vi.fn(), undo: vi.fn() });
    app.provide(IconResolverKey, () => defineComponent({ render: () => h('svg') }));
    app.use(i18n);
    app.use(clientPinia);
    app.mount(host);
    await nextTick();
    await nextTick();

    const cards = () => [...host.querySelectorAll<HTMLElement>('.turn-failed')];
    const checkboxes = () => [...host.querySelectorAll<HTMLInputElement>('.tf-auto-continue input[type="checkbox"]')];
    const settingsSwitch = () =>
      document.querySelector<HTMLButtonElement>('[data-testid="quota-auto-continue-setting"] [role="switch"]')!;

    expect(cards()).toHaveLength(2);
    expect(checkboxes().map((box) => box.checked)).toEqual([false, false]);
    expect(settingsSwitch().getAttribute('aria-checked')).toBe('false');
    const settingsRow = document.querySelector('[data-testid="quota-auto-continue-setting"]')!;
    const settingsGroup = settingsRow.closest('.settings-group');
    expect(settingsGroup?.querySelector('[aria-label="Plan mode by default"]')).toBeNull();
    const settingsSection = settingsRow.closest('section.sec');
    expect(settingsSection?.querySelector('.sec-title')).toBeNull();
    expect(settingsSection?.textContent).toContain('synced with the toggle on error cards');
    expect(host.querySelector('.tf-resume-at')).toBeNull();

    checkboxes()[0]!.click();
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    expect(checkboxes().map((box) => box.checked)).toEqual([true, true]);
    expect(settingsSwitch().getAttribute('aria-checked')).toBe('true');
    expect(getUsage).toHaveBeenCalledTimes(1);
    expect(cards()[0]!.querySelector('.tf-resume-at')?.textContent?.trim()).toBe('Auto-resuming at 11:45 AM');
    expect(cards()[1]!.querySelector('.tf-resume-at')).toBeNull();

    checkboxes()[1]!.click();
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    expect(checkboxes().map((box) => box.checked)).toEqual([false, false]);
    expect(settingsSwitch().getAttribute('aria-checked')).toBe('false');
    expect(host.querySelector('.tf-resume-at')).toBeNull();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(submitPrompt).not.toHaveBeenCalled();

    settingsSwitch().click();
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    expect(checkboxes().map((box) => box.checked)).toEqual([true, true]);
    expect(settingsSwitch().getAttribute('aria-checked')).toBe('true');
    expect(cards()[0]!.querySelector('.tf-resume-at')).toBeNull();
    expect(cards()[1]!.querySelector('.tf-resume-at')?.textContent?.trim()).toBe('Auto-resuming at 11:45 AM');
    resetKimiClientDeps();
  }, 60_000);
});
