import { Container } from '@moonshot-ai/pi-tui';
import { NotifyPanelComponent } from '#/tui/components/chrome/notify-panel';
import type { Event } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

function makeHost() {
  const host = {
    state: {
      notifyPanel: new NotifyPanelComponent(),
      notifyPanelContainer: new Container(),
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
  it.each(['user', 'cron_job', 'background_task'])('clears old updates at a new main %s turn', (kind) => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.notifications.setEnabled(true);
    handler.notifications.handleEvent({ type: 'tool.call.started', sessionId: 's1', agentId: 'main', turnId: 0, toolCallId: 'n1', name: 'NotifyUser', args: { message: 'Earlier finding' } } as Event);
    handler.notifications.handleEvent({ type: 'tool.result', sessionId: 's1', agentId: 'main', turnId: 0, toolCallId: 'n1', output: 'Update shown to the user.' } as Event);
    handler.handleEvent(turnStarted({ kind }), vi.fn());
    handler.handleEvent(turnEnded(), vi.fn());
    expect(host.state.notifyPanel.getEntries().map((entry: { text: string }) => entry.text)).toEqual([]);
    expect(host.streamingUI.clearNotifyPanel).not.toHaveBeenCalled();
  });

  it('collects child notifications before child routing without changing the main turn', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.notifications.setEnabled(true);
    handler.handleEvent({ type: 'tool.call.started', sessionId: 's1', agentId: 'worker-1', turnId: 9, toolCallId: 'n1', name: 'NotifyUser', args: { message: 'Child finding' } } as Event, vi.fn());
    handler.handleEvent({ type: 'tool.result', sessionId: 's1', agentId: 'worker-1', turnId: 9, toolCallId: 'n1', output: 'Update shown to the user.' } as Event, vi.fn());
    expect(host.state.notifyPanel.getEntries()[0]).toMatchObject({ agentId: 'worker-1', text: 'Child finding' });
    expect(host.streamingUI.setTurnId).not.toHaveBeenCalled();
    expect(host.streamingUI.completeToolResult).not.toHaveBeenCalled();
  });
});
