import { describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

function fakeGoalSnapshot(objective: string, status: 'active' | 'blocked' | 'paused' | 'complete') {
  return {
    goalId: 'g1',
    objective,
    status,
    turnsUsed: 1,
    tokensUsed: 10,
    wallClockMs: 100,
    budget: {
      tokenBudget: null,
      turnBudget: 20,
      wallClockBudgetMs: null,
      remainingTokens: null,
      remainingTurns: 19,
      remainingWallClockMs: null,
      tokenBudgetReached: false,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: false,
    },
  };
}

function makeHost(options: { goal?: ReturnType<typeof fakeGoalSnapshot> } = {}) {
  const terminalWrites: string[] = [];
  const appState: Record<string, unknown> = {
    sessionId: 's1',
    streamingPhase: 'waiting',
    streamingStartTime: 1,
    model: 'kimi-model',
    permissionMode: 'auto',
    sessionTitle: 'Test session',
    goal: options.goal ?? null,
    notifications: {
      enabled: true,
      condition: 'unfocused',
    },
  };
  const state = {
    appState,
    queuedMessages: [],
    theme: { palette: getBuiltInPalette('dark') },
    toolOutputExpanded: false,
    todoPanel: { getTodos: vi.fn(() => []) },
    transcriptContainer: { addChild: vi.fn() },
    ui: { requestRender: vi.fn() },
    terminalState: {
      notificationKeys: new Set<string>(),
      focused: false,
      supportsOsc9: true,
      insideTmux: false,
    },
    terminal: {
      write: (text: string) => {
        terminalWrites.push(text);
      },
    },
  };
  const session = {
    createGoal: vi.fn(),
    cancelGoal: vi.fn(),
  };
  const host = {
    state,
    session,
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI: {
      setTurnId: vi.fn(),
      setStep: vi.fn(),
      flushNow: vi.fn(),
      resetToolUi: vi.fn(),
      finalizeTurn: vi.fn(() => {
        appState['streamingPhase'] = 'idle';
        return false;
      }),
      hasThinkingDraft: vi.fn(() => false),
      flushThinkingToTranscript: vi.fn(),
      appendAssistantDelta: vi.fn(),
      scheduleFlush: vi.fn(),
      getTurnContext: vi.fn(() => ({ turnId: 't1', step: 0 })),
    },
    requireSession: vi.fn(() => session),
    setAppState: vi.fn((patch: Record<string, unknown>) => {
      Object.assign(appState, patch);
    }),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    updateActivityPane: vi.fn(),
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
    shiftQueuedMessage: vi.fn(() => undefined),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    tasksBrowserController: {},
  };
  return { host: host as any, session, terminalWrites };
}

function turnStartedEvent() {
  return { type: 'turn.started', sessionId: 's1', agentId: 'main', turnId: 1, origin: { kind: 'user' } } as const;
}

function turnEndedEvent(reason: 'completed' | 'cancelled' | 'failed' | 'filtered' = 'completed') {
  return { type: 'turn.ended', sessionId: 's1', agentId: 'main', turnId: 1, reason } as const;
}

function goalUpdatedEvent(
  snapshot: ReturnType<typeof fakeGoalSnapshot> | null,
  change?: { kind: 'lifecycle' | 'completion'; status: 'active' | 'paused' | 'blocked' | 'complete' },
) {
  return {
    type: 'goal.updated',
    sessionId: 's1',
    agentId: 'main',
    snapshot,
    change,
  } as const;
}

describe('SessionEventHandler terminal notifications', () => {
  it('notifies when a normal turn ends without a goal', () => {
    const { host, terminalWrites } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStartedEvent(), vi.fn());
    handler.handleEvent(turnEndedEvent(), vi.fn());

    expect(terminalWrites.length).toBe(1);
    expect(terminalWrites[0]).toContain('Kimi Code task complete');
  });

  it('does not notify during an active goal continuation turn', () => {
    const { host, terminalWrites } = makeHost({ goal: fakeGoalSnapshot('Ship feature X', 'active') });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStartedEvent(), vi.fn());
    handler.handleEvent(turnEndedEvent(), vi.fn());

    expect(terminalWrites.length).toBe(0);
  });

  it('notifies when a goal completes inside a turn', () => {
    const { host, terminalWrites } = makeHost({ goal: fakeGoalSnapshot('Ship feature X', 'active') });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStartedEvent(), vi.fn());
    // Model-driven: goal.complete arrives before turn.ended while the turn is still running.
    handler.handleEvent(
      goalUpdatedEvent(fakeGoalSnapshot('Ship feature X', 'complete'), {
        kind: 'completion',
        status: 'complete',
      }),
      vi.fn(),
    );
    handler.handleEvent(goalUpdatedEvent(null), vi.fn());
    handler.handleEvent(turnEndedEvent(), vi.fn());

    expect(terminalWrites.length).toBe(1);
    expect(terminalWrites[0]).toContain('Kimi Code task complete');
  });

  it('notifies when a goal is paused after the turn ends', () => {
    const { host, terminalWrites } = makeHost({ goal: fakeGoalSnapshot('Ship feature X', 'active') });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStartedEvent(), vi.fn());
    handler.handleEvent(turnEndedEvent('failed'), vi.fn());
    // Runtime-driven pause arrives after turn.ended.
    handler.handleEvent(
      goalUpdatedEvent(fakeGoalSnapshot('Ship feature X', 'paused'), {
        kind: 'lifecycle',
        status: 'paused',
      }),
      vi.fn(),
    );

    expect(terminalWrites.length).toBe(1);
    expect(terminalWrites[0]).toContain('Kimi Code task complete');
  });

  it('notifies when a goal is blocked after the turn ends', () => {
    const { host, terminalWrites } = makeHost({ goal: fakeGoalSnapshot('Ship feature X', 'active') });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStartedEvent(), vi.fn());
    handler.handleEvent(turnEndedEvent(), vi.fn());
    handler.handleEvent(
      goalUpdatedEvent(fakeGoalSnapshot('Ship feature X', 'blocked'), {
        kind: 'lifecycle',
        status: 'blocked',
      }),
      vi.fn(),
    );

    expect(terminalWrites.length).toBe(1);
    expect(terminalWrites[0]).toContain('Kimi Code task complete');
  });

  it('does not notify when a queued message will be sent next', () => {
    const { host, terminalWrites } = makeHost();
    host.state.queuedMessages = [{ text: 'continue' }] as never[];
    host.streamingUI.finalizeTurn.mockImplementation((sendQueued: (item: unknown) => void) => {
      host.setAppState({ streamingPhase: 'idle' });
      setTimeout(() => {
        sendQueued(host.state.queuedMessages.shift());
      }, 0);
      return true;
    });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStartedEvent(), vi.fn());
    handler.handleEvent(turnEndedEvent(), vi.fn());

    expect(terminalWrites.length).toBe(0);
  });

  it('does not double-notify for the same turn', () => {
    const { host, terminalWrites } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(turnStartedEvent(), vi.fn());
    handler.handleEvent(turnEndedEvent(), vi.fn());
    handler.handleEvent(turnEndedEvent(), vi.fn());

    expect(terminalWrites.length).toBe(1);
  });
});
