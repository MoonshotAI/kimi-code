import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const retryingEvent = {
  type: 'turn.step.retrying',
  sessionId: 's1',
  agentId: 'main',
  turnId: 1,
  step: 1,
  failedAttempt: 1,
  nextAttempt: 2,
  maxAttempts: 10,
  delayMs: 4000,
  errorName: 'APIStatusError',
  errorMessage: 'rate limited',
  statusCode: 429,
} as const;

describe('SessionEventHandler step retry state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores the retry snapshot when a step starts retrying', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(retryingEvent as any, vi.fn());
    expect(host.state.appState.stepRetry).toEqual({
      nextAttempt: 2,
      maxAttempts: 10,
      delayMs: 4000,
      errorName: 'APIStatusError',
      errorMessage: 'rate limited',
      statusCode: 429,
      phase: 'backoff',
    });
  });

  it('drives the pane back to waiting so mid-stream retries render', () => {
    const { host } = makeHost();
    host.state.appState.streamingPhase = 'composing';
    const handler = new SessionEventHandler(host);
    handler.handleEvent(retryingEvent as any, vi.fn());
    expect(host.patchLivePane).toHaveBeenCalledWith({ mode: 'waiting' });
    expect(host.state.appState.streamingPhase).toBe('waiting');
  });

  it.each([
    [{ type: 'turn.step.completed', turnId: 1, step: 1 }, 'turn.step.completed'],
    [
      { type: 'turn.step.interrupted', turnId: 1, step: 1, reason: 'error' },
      'turn.step.interrupted',
    ],
    [{ type: 'turn.ended', turnId: 1, reason: 'completed' }, 'turn.ended'],
    [
      { type: 'tool.result', turnId: 1, toolCallId: 'tc1', output: 'ok', isError: false },
      'tool.result',
    ],
  ])('clears the retry snapshot on %s', (event, _label) => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(retryingEvent as any, vi.fn());
    expect(host.state.appState.stepRetry).not.toBeNull();
    handler.handleEvent(
      { sessionId: 's1', agentId: 'main', ...event } as any,
      vi.fn(),
    );
    expect(host.state.appState.stepRetry).toBeNull();
  });

  it('flips to attempt phase once the backoff delay elapses', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(retryingEvent as any, vi.fn());
    expect(host.state.appState.stepRetry).toMatchObject({ phase: 'backoff' });
    vi.advanceTimersByTime(4000);
    expect(host.state.appState.stepRetry).toMatchObject({ nextAttempt: 2, phase: 'attempt' });
  });

  it('cancels the phase flip when the retry is cleared during the backoff', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(retryingEvent as any, vi.fn());
    handler.handleEvent(
      {
        type: 'turn.step.interrupted',
        sessionId: 's1',
        agentId: 'main',
        turnId: 1,
        step: 1,
        reason: 'error',
      } as any,
      vi.fn(),
    );
    vi.advanceTimersByTime(10_000);
    expect(host.state.appState.stepRetry).toBeNull();
  });

  it('keeps the retry snapshot on turn.step.started (v2 re-emits it per attempt)', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(retryingEvent as any, vi.fn());
    handler.handleEvent(
      { type: 'turn.step.started', sessionId: 's1', agentId: 'main', turnId: 1, step: 1 } as any,
      vi.fn(),
    );
    expect(host.state.appState.stepRetry).toMatchObject({ nextAttempt: 2, phase: 'backoff' });
  });

  it('cancels the pending phase flip via clearStepRetryAttemptTimer (TUI shutdown path)', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(retryingEvent as any, vi.fn());
    handler.clearStepRetryAttemptTimer();
    vi.advanceTimersByTime(10_000);
    expect(host.state.appState.stepRetry).toMatchObject({ phase: 'backoff' });
  });
});
