import type { Event } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import {
  SubAgentEventHandler,
  type SubagentLifecycleEvent,
} from '#/tui/controllers/subagent-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

function makeStreamingUIStub() {
  return {
    getToolComponent: vi.fn(() => undefined),
    getActiveToolCall: vi.fn(() => undefined),
    onToolCallStart: vi.fn(),
    getTurnContext: vi.fn(() => ({ turnId: 1, step: 0 })),
    removeToolComponentIfInactive: vi.fn(),
    applyBackgroundTaskTerminalStatus: vi.fn(),
    markSubagentBackgrounded: vi.fn(),
    setTurnId: vi.fn(),
    setStep: vi.fn(),
    flushNow: vi.fn(),
    setTodoList: vi.fn(),
    resetToolUi: vi.fn(),
    clearNotifyPanel: vi.fn(),
    markNotifyPanelEnded: vi.fn(),
    finalizeTurn: vi.fn(),
  };
}

function makeSubagentHandler() {
  const backgroundTasks = new Map<string, never>();
  const transcriptedTerminal = new Set<string>();
  const host = {
    state: {
      appState: { availableModels: {} },
      ui: { requestRender: vi.fn() },
      transcriptContainer: { addChild: vi.fn() },
    },
    streamingUI: makeStreamingUIStub(),
    appendTranscriptEntry: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    updateActivityPane: vi.fn(),
  };
  const handler = new SubAgentEventHandler(host as never, {
    backgroundTasks,
    backgroundTaskTranscriptedTerminal: transcriptedTerminal,
    backgroundTaskTerminalEntries: new Map(),
    syncBackgroundAgentBadge: vi.fn(),
  });
  return { handler, backgroundTasks, host, transcriptedTerminal };
}

function spawnEvent(subagentId: string, runInBackground: boolean): SubagentLifecycleEvent {
  return {
    sessionId: 's1',
    agentId: 'main',
    type: 'subagent.spawned',
    subagentId,
    subagentName: 'explore',
    parentToolCallId: `tc-${subagentId}`,
    description: `task ${subagentId}`,
    runInBackground,
  } as unknown as SubagentLifecycleEvent;
}

function completedEvent(subagentId: string): SubagentLifecycleEvent {
  return {
    sessionId: 's1',
    agentId: 'main',
    type: 'subagent.completed',
    subagentId,
    parentToolCallId: `tc-${subagentId}`,
    resultSummary: 'done',
  } as unknown as SubagentLifecycleEvent;
}

function cancelledEvent(subagentId: string): SubagentLifecycleEvent {
  return {
    sessionId: 's1',
    agentId: 'main',
    type: 'subagent.cancelled',
    subagentId,
    parentToolCallId: `tc-${subagentId}`,
  } as unknown as SubagentLifecycleEvent;
}

describe('SubAgentEventHandler — background agent cancelled transcript', () => {
  function agentTask(subagentId: string) {
    return {
      taskId: `task-${subagentId}`,
      kind: 'agent',
      agentId: subagentId,
      description: `task ${subagentId}`,
      status: 'running',
      startedAt: 0,
    } as never;
  }

  it('appends a stopped transcript entry when a background agent is cancelled', () => {
    const { handler, backgroundTasks, host, transcriptedTerminal } = makeSubagentHandler();
    backgroundTasks.set('task-a1', agentTask('a1'));
    handler.handleLifecycleEvent(spawnEvent('a1', true));
    (host.appendTranscriptEntry as ReturnType<typeof vi.fn>).mockClear();

    handler.handleLifecycleEvent(cancelledEvent('a1'));

    const appended = (host.appendTranscriptEntry as ReturnType<typeof vi.fn>).mock.calls.map(
      ([entry]) => entry as { content: string },
    );
    expect(appended).toHaveLength(1);
    expect(appended[0]!.content).toContain('stopped');
    expect(transcriptedTerminal.has('task-a1')).toBe(true);
    expect(handler.backgroundAgentMetadata.has('a1')).toBe(false);
    expect(host.streamingUI.applyBackgroundTaskTerminalStatus).toHaveBeenCalledWith({
      agentId: 'a1',
      description: 'task a1',
      status: 'killed',
    });
  });

  it('does not append a second entry when the task was already transcripted', () => {
    const { handler, backgroundTasks, host, transcriptedTerminal } = makeSubagentHandler();
    backgroundTasks.set('task-a1', agentTask('a1'));
    transcriptedTerminal.add('task-a1');
    handler.handleLifecycleEvent(spawnEvent('a1', true));
    (host.appendTranscriptEntry as ReturnType<typeof vi.fn>).mockClear();

    handler.handleLifecycleEvent(cancelledEvent('a1'));

    expect(host.appendTranscriptEntry).not.toHaveBeenCalled();
    expect(handler.backgroundAgentMetadata.has('a1')).toBe(false);
  });

  it('delivers a terminal status to a non-swarm foreground tool card when a subagent is cancelled', () => {
    const { handler, host } = makeSubagentHandler();
    const tc = { onSubagentSpawned: vi.fn(), onSubagentFailed: vi.fn() };
    (host.streamingUI.getToolComponent as ReturnType<typeof vi.fn>).mockReturnValue(tc);
    handler.handleLifecycleEvent(spawnEvent('a1', false));

    handler.handleLifecycleEvent(cancelledEvent('a1'));

    expect(tc.onSubagentFailed).toHaveBeenCalledWith({ error: 'Aborted by the user' });
    expect(host.streamingUI.removeToolComponentIfInactive).toHaveBeenCalledWith('tc-a1');
  });
});

describe('SubAgentEventHandler — activity record pruning', () => {
  it('drops the record of a foreground-only subagent at terminal state', () => {
    const { handler } = makeSubagentHandler();
    handler.handleLifecycleEvent(spawnEvent('a1', false));
    handler.activityStore.applyEvent({
      sessionId: 's1',
      agentId: 'a1',
      type: 'turn.step.started',
      turnId: 1,
      step: 0,
    } as Event);
    expect(handler.activityStore.get('a1')).toBeDefined();

    handler.handleLifecycleEvent(completedEvent('a1'));

    expect(handler.activityStore.get('a1')).toBeUndefined();
  });

  it('keeps the record of a spawn-time background agent even before the task syncs', () => {
    const { handler } = makeSubagentHandler();
    handler.handleLifecycleEvent(spawnEvent('a2', true));
    handler.activityStore.applyEvent({
      sessionId: 's1',
      agentId: 'a2',
      type: 'turn.step.started',
      turnId: 1,
      step: 0,
    } as Event);

    // No background.task.started has populated the task map yet.
    handler.handleLifecycleEvent(completedEvent('a2'));

    const record = handler.activityStore.get('a2');
    expect(record?.status).toBe('completed');
    expect(record?.resultSummary).toBe('done');
  });
});

function makeSessionEventHost() {
  const transcriptEntries: unknown[] = [];
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        workDir: '/tmp/wd',
        streamingPhase: 'idle',
        availableModels: {},
      },
      queuedMessages: [],
      queuedMessageDispatchPending: false,
      theme: { palette: getBuiltInPalette('dark') },
      toolOutputExpanded: false,
      todoPanel: { getTodos: vi.fn(() => []) },
      transcriptContainer: { addChild: vi.fn() },
      transcriptEntries,
      tasksBrowser: undefined,
      footer: { setBackgroundCounts: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: { id: 's1' },
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI: makeStreamingUIStub(),
    requireSession: vi.fn(),
    setAppState: vi.fn(),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
    recordSessionActivity: vi.fn(),
    updateActivityPane: vi.fn(),
    noteStepUsage: vi.fn(),
    noteCompactionFinished: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    appendTranscriptEntry: vi.fn((entry: unknown) => {
      // Mirror the real host: appended entries are retrievable from the
      // transcript window (the anchor scans it for orphaned agent cards).
      transcriptEntries.push(entry);
    }),
    moveTranscriptEntryToEnd: vi.fn(() => true),
    sendNormalUserInput: vi.fn(),
    sendQueuedMessage: vi.fn(),
    shiftQueuedMessage: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    tasksBrowserController: { repaint: vi.fn(), refreshOutputViewer: vi.fn() },
    surveyController: { notifySubagentSpawned: vi.fn() },
  };
  return host as never;
}

describe('SessionEventHandler — background.task.terminated', () => {
  function terminatedEvent(agentId: string, status: string): Event {
    return {
      sessionId: 's1',
      agentId: 'main',
      type: 'background.task.terminated',
      info: {
        taskId: `task-${agentId}`,
        kind: 'agent',
        agentId,
        description: 'bg task',
        status,
        startedAt: 0,
        endedAt: 1,
      },
    } as unknown as Event;
  }

  it('marks a still-running record failed when an agent is stopped without subagent.failed', () => {
    const handler = new SessionEventHandler(makeSessionEventHost());
    handler.subAgentEventHandler.activityStore.ensureRecord({
      agentId: 'agent-9',
      agentName: 'explore',
      parentToolCallId: 'tc-9',
    });

    handler.handleEvent(terminatedEvent('agent-9', 'killed'), vi.fn());

    expect(handler.subAgentEventHandler.activityStore.get('agent-9')?.status).toBe('failed');
  });

  it('does not overwrite a record that already reached terminal state with a summary', () => {
    const handler = new SessionEventHandler(makeSessionEventHost());
    const store = handler.subAgentEventHandler.activityStore;
    store.ensureRecord({ agentId: 'agent-8', agentName: 'explore', parentToolCallId: 'tc-8' });
    store.markCompleted('agent-8', 'final summary');

    handler.handleEvent(terminatedEvent('agent-8', 'completed'), vi.fn());

    const record = store.get('agent-8');
    expect(record?.status).toBe('completed');
    expect(record?.resultSummary).toBe('final summary');
  });

  it('drops foreground-only records when the main turn ends (aborted subagents emit no lifecycle event)', () => {
    const handler = new SessionEventHandler(makeSessionEventHost());
    const store = handler.subAgentEventHandler.activityStore;
    store.ensureRecord({ agentId: 'agent-7', agentName: 'explore', parentToolCallId: 'tc-7' });

    handler.handleEvent(
      {
        sessionId: 's1',
        agentId: 'main',
        type: 'turn.ended',
        turnId: 1,
        reason: 'cancelled',
      } as Event,
      vi.fn(),
    );

    expect(store.get('agent-7')).toBeUndefined();
  });
});

describe('SessionEventHandler — task-notification turn anchoring', () => {
  interface SessionHostMocks {
    appendTranscriptEntry: ReturnType<typeof vi.fn>;
    moveTranscriptEntryToEnd: ReturnType<typeof vi.fn>;
  }

  function makeHost() {
    // makeSessionEventHost returns `never`; recover the mock surface for assertions.
    return makeSessionEventHost() as SessionHostMocks &
      ConstructorParameters<typeof SessionEventHandler>[0];
  }

  function taskTerminatedEvent(taskId: string, kind: 'agent' | 'process', status: string): Event {
    return {
      sessionId: 's1',
      agentId: 'main',
      type: 'background.task.terminated',
      info: {
        taskId,
        kind,
        agentId: kind === 'agent' ? `${taskId}-agent` : undefined,
        description: `task ${taskId}`,
        status,
        startedAt: 0,
        endedAt: 1,
      },
    } as unknown as Event;
  }

  function taskNotificationTurnEvent(taskId: string, status: string): Event {
    return {
      sessionId: 's1',
      agentId: 'main',
      type: 'turn.started',
      turnId: 2,
      origin: { kind: 'task', taskId, status },
    } as unknown as Event;
  }

  function appendedEntries(host: SessionHostMocks) {
    return host.appendTranscriptEntry.mock.calls.map(
      ([entry]) => entry as { content: string; backgroundAgentStatus?: { phase: string } },
    );
  }

  it('mounts no transcript card when an agent-kind task terminates', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(taskTerminatedEvent('task-a1', 'agent', 'completed'), vi.fn());

    // Agent terminal cards are owned by the subagent lifecycle path — the
    // task event itself only records the terminal state.
    expect(host.appendTranscriptEntry).not.toHaveBeenCalled();
    expect(handler.backgroundTaskTranscriptedTerminal.has('task-a1')).toBe(true);
  });

  it('moves the mounted terminal card to the notification turn instead of mounting a new one', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(taskTerminatedEvent('task-p1', 'process', 'completed'), vi.fn());
    expect(appendedEntries(host)).toHaveLength(1);

    handler.handleEvent(taskNotificationTurnEvent('task-p1', 'completed'), vi.fn());

    expect(host.moveTranscriptEntryToEnd).toHaveBeenCalledWith(appendedEntries(host)[0]);
    expect(appendedEntries(host)).toHaveLength(1);
  });

  it('mounts a terminal card at the notification turn start when the agent left none', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    // A timed-out agent that emitted no subagent lifecycle event has no
    // terminal card to anchor — agent-kind terminations mount none.
    handler.handleEvent(taskTerminatedEvent('task-a2', 'agent', 'timed_out'), vi.fn());
    expect(host.appendTranscriptEntry).not.toHaveBeenCalled();

    handler.handleEvent(taskNotificationTurnEvent('task-a2', 'timed_out'), vi.fn());

    const appended = appendedEntries(host);
    expect(appended).toHaveLength(1);
    expect(appended[0]!.backgroundAgentStatus?.phase).toBe('failed');
    expect(host.moveTranscriptEntryToEnd).not.toHaveBeenCalled();
  });

  it('anchors the only terminal card when completion lands before the task syncs', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    // Spawn-time background agent: the spawn event carries the task id.
    handler.handleEvent(
      {
        sessionId: 's1',
        agentId: 'main',
        type: 'subagent.spawned',
        subagentId: 'agent-1',
        subagentName: 'explore',
        parentToolCallId: 'tc-agent-1',
        description: 'task agent-1',
        runInBackground: true,
        taskId: 'task-agent-1',
      } as unknown as Event,
      vi.fn(),
    );
    // Completion lands before background.task.started syncs the task table.
    handler.handleEvent(
      {
        sessionId: 's1',
        agentId: 'main',
        type: 'subagent.completed',
        subagentId: 'agent-1',
        resultSummary: 'done',
      } as unknown as Event,
      vi.fn(),
    );
    handler.handleEvent(
      {
        sessionId: 's1',
        agentId: 'main',
        type: 'background.task.started',
        info: {
          taskId: 'task-agent-1',
          kind: 'agent',
          agentId: 'agent-1',
          description: 'task agent-1',
          status: 'running',
          startedAt: 0,
        },
      } as unknown as Event,
      vi.fn(),
    );

    const terminalCards = (): unknown[] =>
      host.appendTranscriptEntry.mock.calls
        .map(([entry]) => entry)
        .filter(
          (entry) =>
            (entry as { backgroundAgentStatus?: { phase: string } }).backgroundAgentStatus
              ?.phase === 'completed',
        );
    expect(terminalCards()).toHaveLength(1);

    handler.handleEvent(taskNotificationTurnEvent('task-agent-1', 'completed'), vi.fn());

    // The notification turn moves the mounted card to the turn start instead
    // of mounting a second one.
    expect(host.moveTranscriptEntryToEnd).toHaveBeenCalledWith(terminalCards()[0]);
    expect(terminalCards()).toHaveLength(1);
  });

  it('anchors the orphaned terminal card of an agent that finished before its task registered', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    // Tower-style spawn: the spawn event carries no task id — the task is
    // registered only after launch() returns, and the worker can finish
    // before that.
    handler.handleEvent(
      {
        sessionId: 's1',
        agentId: 'main',
        type: 'subagent.spawned',
        subagentId: 'agent-t1',
        subagentName: 'explore',
        parentToolCallId: 'tc-agent-t1',
        description: 'task agent-t1',
        runInBackground: true,
      } as unknown as Event,
      vi.fn(),
    );
    // The worker terminates before background.task.started syncs the task:
    // its terminal card mounts with no task id to register under.
    handler.handleEvent(
      {
        sessionId: 's1',
        agentId: 'main',
        type: 'subagent.completed',
        subagentId: 'agent-t1',
        resultSummary: 'done',
      } as unknown as Event,
      vi.fn(),
    );
    handler.handleEvent(
      {
        sessionId: 's1',
        agentId: 'main',
        type: 'background.task.started',
        info: {
          taskId: 'task-agent-t1',
          kind: 'agent',
          agentId: 'agent-t1',
          description: 'task agent-t1',
          status: 'running',
          startedAt: 0,
        },
      } as unknown as Event,
      vi.fn(),
    );
    handler.handleEvent(
      {
        sessionId: 's1',
        agentId: 'main',
        type: 'background.task.terminated',
        info: {
          taskId: 'task-agent-t1',
          kind: 'agent',
          agentId: 'agent-t1',
          description: 'task agent-t1',
          status: 'completed',
          startedAt: 0,
          endedAt: 1,
        },
      } as unknown as Event,
      vi.fn(),
    );

    const terminalCards = (): unknown[] =>
      host.appendTranscriptEntry.mock.calls
        .map(([entry]) => entry)
        .filter(
          (entry) =>
            (entry as { backgroundAgentStatus?: { phase: string } }).backgroundAgentStatus
              ?.phase === 'completed',
        );
    expect(terminalCards()).toHaveLength(1);

    handler.handleEvent(taskNotificationTurnEvent('task-agent-t1', 'completed'), vi.fn());

    // The notification turn reuses the orphaned card — no duplicate mounts.
    expect(host.moveTranscriptEntryToEnd).toHaveBeenCalledWith(terminalCards()[0]);
    expect(terminalCards()).toHaveLength(1);
    expect(host.appendTranscriptEntry).toHaveBeenCalledTimes(2);
  });

  it('does not steal a previous run’s card when a resumed agent shares its agentId', () => {
    const host = makeHost();
    const handler = new SessionEventHandler(host);

    // First run: the background agent completes and its terminal card is
    // registered under its own task id.
    handler.handleEvent(
      {
        sessionId: 's1',
        agentId: 'main',
        type: 'subagent.spawned',
        subagentId: 'agent-r1',
        subagentName: 'explore',
        parentToolCallId: 'tc-agent-r1',
        description: 'task agent-r1',
        runInBackground: true,
        taskId: 'task-r1',
      } as unknown as Event,
      vi.fn(),
    );
    handler.handleEvent(
      {
        sessionId: 's1',
        agentId: 'main',
        type: 'background.task.started',
        info: {
          taskId: 'task-r1',
          kind: 'agent',
          agentId: 'agent-r1',
          description: 'task agent-r1',
          status: 'running',
          startedAt: 0,
        },
      } as unknown as Event,
      vi.fn(),
    );
    handler.handleEvent(
      {
        sessionId: 's1',
        agentId: 'main',
        type: 'subagent.completed',
        subagentId: 'agent-r1',
        resultSummary: 'done',
      } as unknown as Event,
      vi.fn(),
    );

    const terminalEntries = () =>
      (
        handler as unknown as {
          backgroundTaskTerminalEntries: Map<string, unknown>;
        }
      ).backgroundTaskTerminalEntries;
    const firstRunCard = appendedEntries(host).find(
      (entry) => entry.backgroundAgentStatus?.phase === 'completed',
    );
    expect(firstRunCard).toBeDefined();
    expect(terminalEntries().get('task-r1')).toBe(firstRunCard);

    // The agent is resumed in the background: the new task shares the
    // agentId, then times out without mounting a card of its own.
    handler.handleEvent(
      {
        sessionId: 's1',
        agentId: 'main',
        type: 'background.task.started',
        info: {
          taskId: 'task-r2',
          kind: 'agent',
          agentId: 'agent-r1',
          description: 'task agent-r1 (resumed)',
          status: 'running',
          startedAt: 1,
        },
      } as unknown as Event,
      vi.fn(),
    );
    handler.handleEvent(
      {
        sessionId: 's1',
        agentId: 'main',
        type: 'background.task.terminated',
        info: {
          taskId: 'task-r2',
          kind: 'agent',
          agentId: 'agent-r1',
          description: 'task agent-r1 (resumed)',
          status: 'timed_out',
          startedAt: 1,
          endedAt: 2,
        },
      } as unknown as Event,
      vi.fn(),
    );

    handler.handleEvent(taskNotificationTurnEvent('task-r2', 'timed_out'), vi.fn());

    // The anchor must leave the first run's card registered and in place,
    // and mount the resumed task's own terminal card instead.
    expect(host.moveTranscriptEntryToEnd).not.toHaveBeenCalledWith(firstRunCard);
    expect(terminalEntries().get('task-r1')).toBe(firstRunCard);
    const appended = appendedEntries(host);
    const resumedCard = appended.at(-1)!;
    expect(resumedCard).not.toBe(firstRunCard);
    expect(resumedCard.backgroundAgentStatus?.phase).toBe('failed');
    expect(terminalEntries().get('task-r2')).toBe(resumedCard);
  });
});
