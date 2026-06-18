import { describe, expect, it, beforeEach, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';
import { readGoalQueue, removeGoalQueueItem, restoreGoalQueueItem } from '#/tui/goal-queue-store';

vi.mock('#/tui/goal-queue-store', () => ({
  readGoalQueue: vi.fn(async () => ({
    goals: [{ id: 'q1', objective: 'Ship queued goal', createdAt: '', updatedAt: '' }],
  })),
  removeGoalQueueItem: vi.fn(async () => ({ goals: [] })),
  restoreGoalQueueItem: vi.fn(async () => ({
    goals: [{ id: 'q1', objective: 'Ship queued goal', createdAt: '', updatedAt: '' }],
  })),
}));

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

function makeHost(options: { createGoalRejects?: boolean } = {}) {
  const session = {
    createGoal: vi.fn(async () => {
      if (options.createGoalRejects === true) throw new Error('create failed');
      return fakeGoalSnapshot('Ship queued goal', 'active');
    }),
    cancelGoal: vi.fn(async () => fakeGoalSnapshot('Ship queued goal', 'active')),
  };
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        streamingPhase: 'waiting',
        model: 'kimi-model',
        permissionMode: 'auto',
      },
      queuedMessages: [],
      theme: { palette: getBuiltInPalette('dark') },
      toolOutputExpanded: false,
      todoPanel: { getTodos: vi.fn(() => []) },
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session,
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
    requireSession: vi.fn(() => session),
    setAppState: vi.fn(),
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
  host.streamingUI.finalizeTurn.mockImplementation(() => {
    host.setAppState({ streamingPhase: 'idle' });
  });
  return { host: host as any, session };
}

function sendQueuedViaHost(host: ReturnType<typeof makeHost>['host'], session: unknown) {
  return (item: unknown) => {
    host.sendQueuedMessage(session as never, item as never);
  };
}

function completionEvent() {
  return {
    type: 'goal.updated',
    sessionId: 's1',
    agentId: 'main',
    snapshot: fakeGoalSnapshot('Current goal', 'complete'),
    change: {
      kind: 'completion',
      status: 'complete',
      stats: { turnsUsed: 1, tokensUsed: 10, wallClockMs: 100 },
    },
  } as const;
}

function clearedEvent() {
  return {
    type: 'goal.updated',
    sessionId: 's1',
    agentId: 'main',
    snapshot: null,
  } as const;
}

function turnEndedEvent() {
  return {
    type: 'turn.ended',
    sessionId: 's1',
    agentId: 'main',
    turnId: 1,
    reason: 'completed',
  } as const;
}

function modelBlockedEvent() {
  return {
    type: 'goal.updated',
    sessionId: 's1',
    agentId: 'main',
    snapshot: fakeGoalSnapshot('Blocked goal', 'blocked'),
    change: { kind: 'lifecycle', status: 'blocked' },
  } as const;
}

function addedTranscriptText(host: ReturnType<typeof makeHost>['host']): string {
  const component = host.state.transcriptContainer.addChild.mock.calls.at(-1)?.[0];
  return component.render(80).join('\n').replaceAll(/\[[0-9;]*m/g, '');
}

describe('SessionEventHandler goal queue promotion', () => {
  beforeEach(() => {
    vi.mocked(readGoalQueue).mockClear();
    vi.mocked(removeGoalQueueItem).mockClear();
    vi.mocked(restoreGoalQueueItem).mockClear();
  });

  it('starts the next queued goal after the completion turn ends', async () => {
    const { host, session } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(completionEvent(), vi.fn());
    expect(session.createGoal).not.toHaveBeenCalled();
    handler.handleEvent(clearedEvent(), vi.fn());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.createGoal).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();

    handler.handleEvent(turnEndedEvent(), sendQueuedViaHost(host, session));

    await vi.waitFor(() => {
      expect(session.createGoal).toHaveBeenCalledWith({
        objective: 'Ship queued goal',
        replace: false,
      });
    });
    expect(removeGoalQueueItem).toHaveBeenCalledWith(session, { goalId: 'q1' });
    expect(host.sendQueuedMessage).toHaveBeenCalledWith(session, {
      text: 'Ship queued goal',
    });
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('waits for queued user input to drain before promoting the next queued goal', async () => {
    const { host, session } = makeHost();
    host.state.queuedMessages = [{ text: 'queued user turn' }];
    host.setAppState.mockImplementation((patch: Record<string, unknown>) => {
      Object.assign(host.state.appState, patch);
    });
    host.shiftQueuedMessage.mockImplementation(() => host.state.queuedMessages.shift());
    host.streamingUI.finalizeTurn.mockImplementation((sendQueued: (item: unknown) => void) => {
      const next = host.shiftQueuedMessage();
      if (next !== undefined) {
        host.setAppState({ streamingPhase: 'idle' });
        setTimeout(() => {
          sendQueued(next);
        }, 0);
        return;
      }
      host.setAppState({ streamingPhase: 'idle' });
    });
    host.sendQueuedMessage.mockImplementation((_session: unknown, item: { text: string }) => {
      if (item.text === 'queued user turn') {
        host.setAppState({ streamingPhase: 'waiting' });
      }
    });
    const handler = new SessionEventHandler(host);
    const sendQueued = sendQueuedViaHost(host, session);

    handler.handleEvent(completionEvent(), sendQueued);
    handler.handleEvent(clearedEvent(), sendQueued);
    handler.handleEvent(turnEndedEvent(), sendQueued);

    await vi.waitFor(() => {
      expect(host.sendQueuedMessage).toHaveBeenCalledWith(session, { text: 'queued user turn' });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.createGoal).not.toHaveBeenCalled();

    handler.handleEvent(turnEndedEvent(), sendQueued);

    await vi.waitFor(() => {
      expect(session.createGoal).toHaveBeenCalledWith({
        objective: 'Ship queued goal',
        replace: false,
      });
    });
    expect(host.sendQueuedMessage).toHaveBeenLastCalledWith(session, { text: 'Ship queued goal' });
  });

  it('leaves the queued goal in place when the next goal cannot start', async () => {
    const { host, session } = makeHost({ createGoalRejects: true });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(completionEvent(), vi.fn());
    handler.handleEvent(clearedEvent(), vi.fn());
    handler.handleEvent(turnEndedEvent(), vi.fn());

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('create failed'));
    });
    expect(removeGoalQueueItem).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.sendQueuedMessage).not.toHaveBeenCalled();
    expect(session.createGoal).toHaveBeenCalledOnce();
  });

  it('retries the queued goal on a later idle event after startup fails', async () => {
    const { host, session } = makeHost();
    session.createGoal.mockRejectedValueOnce(new Error('create failed'));
    const handler = new SessionEventHandler(host);
    const sendQueued = sendQueuedViaHost(host, session);

    handler.handleEvent(completionEvent(), sendQueued);
    handler.handleEvent(clearedEvent(), sendQueued);
    handler.handleEvent(turnEndedEvent(), sendQueued);

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('create failed'));
    });
    expect(removeGoalQueueItem).not.toHaveBeenCalled();
    expect(host.sendQueuedMessage).not.toHaveBeenCalled();

    handler.handleEvent(turnEndedEvent(), sendQueued);

    await vi.waitFor(() => {
      expect(session.createGoal).toHaveBeenCalledTimes(2);
    });
    expect(removeGoalQueueItem).toHaveBeenCalledWith(session, { goalId: 'q1' });
    expect(host.sendQueuedMessage).toHaveBeenCalledWith(session, { text: 'Ship queued goal' });
  });

  it('does not send the queued objective when removal fails after goal creation', async () => {
    vi.mocked(removeGoalQueueItem).mockRejectedValueOnce(new Error('remove failed'));
    const { host, session } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(completionEvent(), vi.fn());
    handler.handleEvent(clearedEvent(), vi.fn());
    handler.handleEvent(turnEndedEvent(), vi.fn());

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('could not be removed'));
    });
    expect(session.createGoal).toHaveBeenCalledWith({
      objective: 'Ship queued goal',
      replace: false,
    });
    expect(session.cancelGoal).toHaveBeenCalledOnce();
    expect(restoreGoalQueueItem).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.sendQueuedMessage).not.toHaveBeenCalled();
  });

  it('restores the queued goal and cancels the started goal when the session changes before send', async () => {
    const { host, session } = makeHost();
    vi.mocked(removeGoalQueueItem).mockImplementationOnce(async () => {
      host.session = undefined;
      return { goals: [] };
    });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(completionEvent(), vi.fn());
    handler.handleEvent(clearedEvent(), vi.fn());
    handler.handleEvent(turnEndedEvent(), sendQueuedViaHost(host, session));

    await vi.waitFor(() => {
      expect(restoreGoalQueueItem).toHaveBeenCalledWith(session, {
        id: 'q1',
        objective: 'Ship queued goal',
        createdAt: '',
        updatedAt: '',
      });
    });
    expect(session.cancelGoal).toHaveBeenCalledOnce();
    expect(host.sendQueuedMessage).not.toHaveBeenCalled();
  });

  it('restores and cancels when the host becomes busy before sending the promoted goal', async () => {
    const { host, session } = makeHost();
    vi.mocked(removeGoalQueueItem).mockImplementationOnce(async () => {
      host.setAppState({ streamingPhase: 'waiting' });
      return { goals: [] };
    });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(completionEvent(), vi.fn());
    handler.handleEvent(clearedEvent(), vi.fn());
    handler.handleEvent(turnEndedEvent(), sendQueuedViaHost(host, session));

    await vi.waitFor(() => {
      expect(restoreGoalQueueItem).toHaveBeenCalledWith(session, {
        id: 'q1',
        objective: 'Ship queued goal',
        createdAt: '',
        updatedAt: '',
      });
    });
    expect(session.cancelGoal).toHaveBeenCalledOnce();
    expect(host.sendQueuedMessage).not.toHaveBeenCalled();
  });

  it('shows a notice when a blocked goal has queued goals', async () => {
    const { host, session } = makeHost();
    const handler = new SessionEventHandler(host);
    const event = {
      type: 'goal.updated',
      sessionId: 's1',
      agentId: 'main',
      snapshot: fakeGoalSnapshot('Blocked goal', 'blocked'),
      change: { kind: 'lifecycle', status: 'blocked', reason: 'waiting for access' },
    } as const;

    handler.handleEvent(event, vi.fn());

    await vi.waitFor(() => {
      expect(host.showNotice).toHaveBeenCalledWith(
        'Goal blocked.',
        'The next queued goal will start only after this goal is complete.',
      );
    });
    expect(session.createGoal).not.toHaveBeenCalled();
  });

  it('does not render a duplicate marker for a model-reported blocked goal', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(modelBlockedEvent(), vi.fn());

    expect(host.state.transcriptContainer.addChild).not.toHaveBeenCalled();
  });

  it('renders a blocked fallback when the model does not explain the blocked goal', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(modelBlockedEvent(), vi.fn());
    handler.handleEvent(turnEndedEvent(), vi.fn());

    expect(addedTranscriptText(host)).toBe('  ◦ Goal blocked');
  });

  it('does not render a blocked fallback after the model explains the blocked goal', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(modelBlockedEvent(), vi.fn());
    handler.handleEvent(
      {
        type: 'assistant.delta',
        sessionId: 's1',
        agentId: 'main',
        turnId: 1,
        delta: 'I am blocked because I need credentials.',
      },
      vi.fn(),
    );
    handler.handleEvent(turnEndedEvent(), vi.fn());

    expect(host.state.transcriptContainer.addChild).not.toHaveBeenCalled();
  });

  it('does not render a blocked fallback after earlier assistant text in the same turn', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      {
        type: 'assistant.delta',
        sessionId: 's1',
        agentId: 'main',
        turnId: 1,
        delta: 'I am blocked because I need credentials.',
      },
      vi.fn(),
    );
    handler.handleEvent(modelBlockedEvent(), vi.fn());
    handler.handleEvent(turnEndedEvent(), vi.fn());

    expect(host.state.transcriptContainer.addChild).not.toHaveBeenCalled();
  });

  it('does not promote on paused or cancelled updates', async () => {
    const { host, session } = makeHost();
    const handler = new SessionEventHandler(host);
    const paused = {
      type: 'goal.updated',
      sessionId: 's1',
      agentId: 'main',
      snapshot: fakeGoalSnapshot('Paused goal', 'paused'),
      change: { kind: 'lifecycle', status: 'paused' },
    } as const;

    handler.handleEvent(paused, vi.fn());
    handler.handleEvent(clearedEvent(), vi.fn());

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.createGoal).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.sendQueuedMessage).not.toHaveBeenCalled();
  });
});
