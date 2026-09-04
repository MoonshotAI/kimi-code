import type { Event } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

function makeHost() {
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        streamingPhase: 'idle',
        isCompacting: false,
        model: 'kimi-model',
        permissionMode: 'auto',
        stepRetry: null,
      },
      queuedMessages: [],
      queuedMessageDispatchPending: false,
      theme: { palette: getBuiltInPalette('dark') },
      toolOutputExpanded: false,
      todoPanel: { getTodos: vi.fn(() => []) },
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: { id: 's1' },
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI: {
      setTurnId: vi.fn(),
      setStep: vi.fn(),
      flushNow: vi.fn(),
      resetToolUi: vi.fn(),
      clearNotifyPanel: vi.fn(),
      markNotifyPanelEnded: vi.fn(),
      finalizeTurn: vi.fn(),
      finalizeLiveTextBuffers: vi.fn(),
      completeToolResult: vi.fn(),
      getTurnContext: vi.fn(() => ({ turnId: '1', step: 0 })),
    },
    requireSession: vi.fn(),
    setAppState: vi.fn((patch: Record<string, unknown>) =>
      Object.assign(host.state.appState, patch),
    ),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    updateActivityPane: vi.fn(),
    updateQueueDisplay: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
    recordSessionActivity: vi.fn(),
    noteStepUsage: vi.fn(),
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
  };
  return { host: host as any };
}

function turnStarted(origin: Record<string, unknown>): Event {
  return {
    sessionId: 's1',
    agentId: 'main',
    type: 'turn.started',
    turnId: 1,
    origin,
  } as unknown as Event;
}

function turnEnded(): Event {
  return {
    sessionId: 's1',
    agentId: 'main',
    type: 'turn.ended',
    turnId: 1,
    reason: 'completed',
  } as unknown as Event;
}

describe('SessionEventHandler — update panel lifecycle', () => {
  it('closes the panel when a user turn starts', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStarted({ kind: 'user' }), vi.fn());

    expect(host.streamingUI.clearNotifyPanel).toHaveBeenCalledOnce();
    expect(host.streamingUI.markNotifyPanelEnded).not.toHaveBeenCalled();
  });

  it('closes the panel on a cron-fired turn too, so it reopens fresh', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      turnStarted({ kind: 'cron_job', jobId: 'j1', cron: '* * * * *', recurring: true }),
      vi.fn(),
    );

    expect(host.streamingUI.clearNotifyPanel).toHaveBeenCalledOnce();
  });

  it('keeps the panel but marks it ended when the turn ends', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStarted({ kind: 'user' }), vi.fn());
    host.streamingUI.clearNotifyPanel.mockClear();
    handler.handleEvent(turnEnded(), vi.fn());

    expect(host.streamingUI.markNotifyPanelEnded).toHaveBeenCalledOnce();
    expect(host.streamingUI.clearNotifyPanel).not.toHaveBeenCalled();
  });
});
