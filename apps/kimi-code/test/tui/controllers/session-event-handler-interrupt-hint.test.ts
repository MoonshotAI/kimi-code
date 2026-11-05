import { describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

function makeHost() {
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        streamingPhase: 'waiting',
        isCompacting: false,
        model: 'kimi-model',
        permissionMode: 'auto',
        stepRetry: null,
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
    },
    requireSession: vi.fn(),
    setAppState: vi.fn((patch: Record<string, unknown>) =>
      Object.assign(host.state.appState, patch),
    ),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    updateActivityPane: vi.fn(),
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
  return { host: host as any };
}

type MockFn = ReturnType<typeof vi.fn>;

function runTurn(
  handler: SessionEventHandler,
  showStatus: MockFn,
  origin: object | undefined,
  endReason: string,
): void {
  handler.handleEvent(
    { type: 'turn.started', sessionId: 's1', agentId: 'main', turnId: 1, origin } as any,
    vi.fn(),
  );
  showStatus.mockClear();
  handler.handleEvent(
    { type: 'turn.ended', sessionId: 's1', agentId: 'main', turnId: 1, reason: endReason } as any,
    vi.fn(),
  );
}

const hintCalls = (showStatus: MockFn) =>
  showStatus.mock.calls.filter(([message]) => String(message).includes('/undo'));

describe('SessionEventHandler interrupted-turn hint', () => {
  it('shows the undo hint when a user-submitted turn ends cancelled', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    runTurn(handler, host.showStatus, { kind: 'user' }, 'cancelled');
    expect(hintCalls(host.showStatus)).toHaveLength(1);
    expect(hintCalls(host.showStatus)[0]?.[0]).toContain('stays in the context');
    expect(hintCalls(host.showStatus)[0]?.[1]).toBe('textMuted');
  });

  it.each([
    [{ kind: 'cron_job', jobId: 'job-1', cron: '*/5 * * * *', recurring: true }, 'cron'],
    [{ kind: 'system_trigger' }, 'system_trigger'],
    [{ kind: 'task', taskId: 't1', status: 'completed' }, 'task'],
    [undefined, 'missing origin'],
  ])('shows no hint for a cancelled %s turn', (origin, _label) => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    runTurn(handler, host.showStatus, origin as object | undefined, 'cancelled');
    expect(hintCalls(host.showStatus)).toHaveLength(0);
  });

  it.each(['completed', 'failed', 'blocked'])(
    'shows no hint when a user turn ends %s',
    (reason) => {
      const { host } = makeHost();
      const handler = new SessionEventHandler(host);
      runTurn(handler, host.showStatus, { kind: 'user' }, reason);
      expect(hintCalls(host.showStatus)).toHaveLength(0);
    },
  );

  it('forgets the origin once the turn ends, so a later bare turn.ended shows no hint', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(
      {
        type: 'turn.started',
        sessionId: 's1',
        agentId: 'main',
        turnId: 1,
        origin: { kind: 'user' },
      } as any,
      vi.fn(),
    );
    handler.handleEvent(
      { type: 'turn.ended', sessionId: 's1', agentId: 'main', turnId: 1, reason: 'completed' } as any,
      vi.fn(),
    );
    host.showStatus.mockClear();
    handler.handleEvent(
      { type: 'turn.ended', sessionId: 's1', agentId: 'main', turnId: 2, reason: 'cancelled' } as any,
      vi.fn(),
    );
    expect(hintCalls(host.showStatus)).toHaveLength(0);
  });
});
