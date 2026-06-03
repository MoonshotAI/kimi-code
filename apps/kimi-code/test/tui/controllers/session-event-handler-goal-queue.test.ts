import { describe, expect, it, beforeEach, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getColorPalette } from '#/tui/theme/colors';
import { readGoalQueue, removeGoalQueueItem } from '#/tui/goal-queue-store';

vi.mock('#/tui/goal-queue-store', () => ({
  readGoalQueue: vi.fn(async () => ({
    goals: [{ id: 'q1', objective: 'Ship queued goal', createdAt: '', updatedAt: '' }],
  })),
  removeGoalQueueItem: vi.fn(async () => ({ goals: [] })),
}));

function fakeGoalSnapshot(objective: string, status: 'active' | 'blocked' | 'paused' | 'complete') {
  return {
    goalId: 'g1',
    objective,
    status,
    createdAt: '',
    updatedAt: '',
    startedBy: 'user' as const,
    updatedBy: status === 'complete' || status === 'blocked' ? 'model' as const : 'user' as const,
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
  };
  const host = {
    state: {
      appState: { sessionId: 's1' },
      theme: { colors: getColorPalette('dark') },
      toolOutputExpanded: false,
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session,
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI: { setTurnId: vi.fn() },
    requireSession: vi.fn(() => session),
    setAppState: vi.fn(),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    sendNormalUserInput: vi.fn(),
    sendQueuedMessage: vi.fn(),
    shiftQueuedMessage: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    tasksBrowserController: {},
  };
  return { host: host as any, session };
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

describe('SessionEventHandler goal queue promotion', () => {
  beforeEach(() => {
    vi.mocked(readGoalQueue).mockClear();
    vi.mocked(removeGoalQueueItem).mockClear();
  });

  it('starts the next queued goal after completion and the follow-up clear event', async () => {
    const { host, session } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(completionEvent(), vi.fn());
    expect(session.createGoal).not.toHaveBeenCalled();
    handler.handleEvent(clearedEvent(), vi.fn());

    await vi.waitFor(() => {
      expect(session.createGoal).toHaveBeenCalledWith({ objective: 'Ship queued goal' });
    });
    expect(removeGoalQueueItem).toHaveBeenCalledWith(session, { goalId: 'q1' });
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship queued goal');
  });

  it('leaves the queued goal in place when the next goal cannot start', async () => {
    const { host, session } = makeHost({ createGoalRejects: true });
    const handler = new SessionEventHandler(host);

    handler.handleEvent(completionEvent(), vi.fn());
    handler.handleEvent(clearedEvent(), vi.fn());

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('Failed to start queued goal'));
    });
    expect(removeGoalQueueItem).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(session.createGoal).toHaveBeenCalledOnce();
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
  });
});
