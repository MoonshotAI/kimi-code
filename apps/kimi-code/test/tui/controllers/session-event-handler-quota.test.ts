import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_OAUTH_PROVIDER_NAME } from '#/constant/app';
import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';
import type { AppState, QuotaInfo } from '#/tui/types';

function makeHost(options: { quotas?: QuotaInfo[]; fetchError?: boolean } = {}) {
  const appState: Partial<AppState> = {
    sessionId: 's1',
    streamingPhase: 'idle',
    model: 'kimi-k2',
    permissionMode: 'manual',
    availableModels: {
      'kimi-k2': {
        model: 'kimi-k2',
        provider: DEFAULT_OAUTH_PROVIDER_NAME,
      } as any,
      openai: {
        model: 'openai',
        provider: 'openai',
      } as any,
    },
    quotas: undefined,
  };

  const host = {
    state: {
      appState,
      queuedMessages: [],
      theme: { palette: getBuiltInPalette('dark') },
      toolOutputExpanded: false,
      todoPanel: { getTodos: vi.fn(() => []) },
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: undefined,
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI: {
      setTurnId: vi.fn(),
      flushNow: vi.fn(),
      resetToolUi: vi.fn(),
      finalizeTurn: vi.fn(),
      hasThinkingDraft: vi.fn(() => false),
      flushThinkingToTranscript: vi.fn(),
      appendAssistantDelta: vi.fn(),
      scheduleFlush: vi.fn(),
    },
    requireSession: vi.fn(),
    setAppState: vi.fn(),
    fetchManagedQuotas: vi.fn(async () =>
      options.fetchError === true ? undefined : options.quotas,
    ),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    sendNormalUserInput: vi.fn(),
    sendQueuedMessage: vi.fn(),
    shiftQueuedMessage: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    tasksBrowserController: {},
  };

  host.setAppState.mockImplementation((patch: Record<string, unknown>) => {
    Object.assign(host.state.appState, patch);
  });

  return { host: host as any };
}

describe('SessionEventHandler quotas', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('fetches managed quotas on session start', async () => {
    const quotas: QuotaInfo[] = [{ label: 'Weekly limit', used: 10, limit: 100 }];
    const { host } = makeHost({ quotas });
    const handler = new SessionEventHandler(host);

    (handler as any).scheduleQuotaRefresh();
    await vi.runOnlyPendingTimersAsync();

    expect(host.fetchManagedQuotas).toHaveBeenCalled();
    expect(host.state.appState.quotas).toEqual(quotas);
  });

  it('keeps last known quotas when the fetch fails', async () => {
    const quotas: QuotaInfo[] = [{ label: 'Weekly limit', used: 10, limit: 100 }];
    const { host } = makeHost({ quotas });
    const handler = new SessionEventHandler(host);

    (handler as any).scheduleQuotaRefresh();
    await vi.runOnlyPendingTimersAsync();
    expect(host.state.appState.quotas).toEqual(quotas);

    host.fetchManagedQuotas = vi.fn(async () => undefined);
    await (handler as any).refreshQuota();

    expect(host.state.appState.quotas).toEqual(quotas);
  });

  it('does not add current-turn usage to server quotas', async () => {
    const quotas: QuotaInfo[] = [{ label: 'Weekly limit', used: 10, limit: 100 }];
    const { host } = makeHost({ quotas });
    const handler = new SessionEventHandler(host);

    (handler as any).scheduleQuotaRefresh();
    await vi.runOnlyPendingTimersAsync();

    handler.handleEvent(
      {
        type: 'agent.status.updated',
        agentId: 'main',
        usage: {
          currentTurn: { inputOther: 5, inputCacheRead: 0, inputCacheCreation: 0, output: 3 },
        },
      } as any,
      () => {},
    );

    expect(host.state.appState.quotas).toEqual(quotas);
  });

  it('starts polling when the active model switches to a managed provider', async () => {
    const quotas: QuotaInfo[] = [{ label: 'Weekly limit', used: 10, limit: 100 }];
    const { host } = makeHost({ quotas });
    host.state.appState.model = 'openai';
    const handler = new SessionEventHandler(host);

    (handler as any).scheduleQuotaRefresh();
    await vi.runOnlyPendingTimersAsync();
    expect(host.fetchManagedQuotas).not.toHaveBeenCalled();

    handler.handleEvent(
      { type: 'agent.status.updated', agentId: 'main', model: 'kimi-k2' } as any,
      () => {},
    );
    await vi.runOnlyPendingTimersAsync();

    expect(host.fetchManagedQuotas).toHaveBeenCalled();
    expect(host.state.appState.quotas).toEqual(quotas);
  });
});
