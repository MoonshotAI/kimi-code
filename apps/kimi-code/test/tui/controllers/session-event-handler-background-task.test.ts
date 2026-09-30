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
    tasksBrowserController: { repaint: vi.fn(), refreshOutputViewer: vi.fn() },
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
