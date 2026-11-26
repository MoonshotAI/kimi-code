import { BUSINESS_MEMBERSHIP_REVOKED_MESSAGE } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';
import { TurnTimeline } from '#/tui/utils/turn-timeline';

function makeHost() {
  const setAuthRequired = vi.fn();
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        streamingPhase: 'idle',
        isCompacting: false,
        model: 'kimi-model',
        permissionMode: 'auto',
        stepRetry: null,
        managedWorkspace: {
          hasBusinessWorkspace: true,
          statusWorkspaceLine: 'Alice · Acme Corp',
          planLabel: 'Premium',
        },
      },
      queuedMessages: [],
      queuedMessageDispatchPending: false,
      theme: { palette: getBuiltInPalette('dark') },
      toolOutputExpanded: false,
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: { id: 's1' },
    aborted: false,
    sessionEventUnsubscribe: undefined,
    programStatus: {
      setAuthRequired,
      failRequest: vi.fn(),
    },
    streamingUI: {
      timeline: new TurnTimeline(),
      setTurnId: vi.fn(),
      setStep: vi.fn(),
      flushNow: vi.fn(),
      resetToolUi: vi.fn(),
      clearNotifyPanel: vi.fn(),
      markNotifyPanelEnded: vi.fn(),
      finalizeTurn: vi.fn(),
      finalizeLiveTextBuffers: vi.fn(),
      completeToolResult: vi.fn(),
    },
    requireSession: vi.fn(),
    setAppState: vi.fn((patch: Record<string, unknown>) =>
      Object.assign(host.state.appState, patch),
    ),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
    recordSessionActivity: vi.fn(),
    noteCompactionFinished: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    sendNormalUserInput: vi.fn(),
    sendQueuedMessage: vi.fn(),
    shiftQueuedMessage: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    tasksBrowserController: {},
    surveyController: {
      notifyToolCallStarted: vi.fn(),
      notifyToolCallEnded: vi.fn(),
      notifySubagentSpawned: vi.fn(),
    },
  };
  return { host: host as any, setAuthRequired };
}

describe('SessionEventHandler business membership revoked errors', () => {
  it.each(['REASON_BUSINESS_MEMBER_REMOVED', 'REASON_BUSINESS_MEMBER_DISABLED'])(
    'clears managed workspace badge, requires re-login, and shows exact PRD message on %s',
    (providerErrorCode) => {
      const { host, setAuthRequired } = makeHost();
      const handler = new SessionEventHandler(host);

      handler.handleEvent(
        {
          type: 'error',
          sessionId: 's1',
          agentId: 'main',
          code: 'provider.auth',
          message: 'Upstream 401 unauthorized',
          details: { providerErrorCode },
        } as any,
        vi.fn(),
      );

      expect(host.state.appState.managedWorkspace).toBeNull();
      expect(setAuthRequired).toHaveBeenCalledWith(true);
      expect(host.showError).toHaveBeenCalledTimes(1);
      expect(host.showError).toHaveBeenCalledWith(BUSINESS_MEMBERSHIP_REVOKED_MESSAGE);
      expect(host.showStatus).not.toHaveBeenCalled();
    },
  );
});
