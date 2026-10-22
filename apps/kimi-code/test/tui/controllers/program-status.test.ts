import type { ProgramStatus } from '@moonshot-ai/pi-tui';
import type {
  AgentBackgroundTaskInfo,
  TurnEndedEvent,
  TurnStartedEvent,
} from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import {
  ProgramStatusController,
  type ProgramStatusState,
} from '#/tui/controllers/program-status';

function makeHarness() {
  const queuedMessages: unknown[] = [];
  const state: ProgramStatusState = {
    appState: {
      isCompacting: false,
      sessionTitle: 'Fix terminal status',
      streamingPhase: 'idle',
    },
    queuedMessages,
    queuedMessageDispatchPending: false,
  };
  const records = new Map<string | undefined, ProgramStatus>();
  const writes: ProgramStatus[] = [];
  const controller = new ProgramStatusController(state, {
    setProgramStatus(status) {
      writes.push(status);
      if (status.state === 'clear') {
        if (status.id === undefined) {
          records.clear();
        } else {
          records.delete(status.id);
          for (const id of records.keys()) {
            if (id?.startsWith(`${status.id}/`)) records.delete(id);
          }
        }
      } else {
        records.set(status.id, status);
      }
    },
  });
  return {
    controller,
    queuedMessages,
    records,
    state,
    writes,
    root: () => records.get(undefined),
    children: () => [...records.entries()].filter(([id]) => id !== undefined).map(([, status]) => status),
  };
}

function agentTask(
  status: AgentBackgroundTaskInfo['status'],
  overrides: Partial<AgentBackgroundTaskInfo> = {},
): AgentBackgroundTaskInfo {
  return {
    taskId: 'task-1',
    kind: 'agent',
    agentId: 'agent-1',
    subagentType: 'explore',
    description: 'model-generated task description must not be reported',
    status,
    startedAt: 1,
    endedAt: status === 'running' ? null : 2,
    ...overrides,
  };
}

function turnEnded(reason: TurnEndedEvent['reason']): TurnEndedEvent {
  return {
    type: 'turn.ended',
    turnId: 1,
    reason,
  };
}

describe('ProgramStatusController', () => {
  it('projects foreground work, queued messages, and turn outcomes into the root record', () => {
    const harness = makeHarness();
    harness.controller.refresh();
    expect(harness.root()).toEqual({ state: 'idle', app: 'kimi-code' });

    harness.state.appState.streamingPhase = 'waiting';
    harness.controller.refresh();
    expect(harness.root()).toEqual({
      state: 'working',
      app: 'kimi-code',
      message: 'Fix terminal status',
    });

    harness.state.appState.streamingPhase = 'idle';
    harness.controller.finishTurn(turnEnded('completed'));
    expect(harness.root()).toEqual({
      state: 'done',
      app: 'kimi-code',
      message: 'Fix terminal status',
    });

    harness.queuedMessages.push({});
    harness.controller.refresh();
    expect(harness.root()?.state).toBe('working');
    harness.queuedMessages.length = 0;
    harness.controller.finishTurn(turnEnded('cancelled'));
    expect(harness.root()).toEqual({ state: 'idle', app: 'kimi-code' });
  });

  it('keeps the root working until background agents settle and hides task descriptions', () => {
    const harness = makeHarness();
    harness.controller.updateBackgroundTask(agentTask('running'));
    expect(harness.root()?.state).toBe('working');
    expect(harness.children()).toEqual([
      {
        state: 'working',
        id: expect.any(String),
        title: 'Background agent: explore',
      },
    ]);
    expect(JSON.stringify(harness.writes)).not.toContain('model-generated');

    harness.controller.finishTurn(turnEnded('completed'));
    expect(harness.root()?.state).toBe('working');
    harness.controller.updateBackgroundTask(agentTask('completed'));
    expect(harness.root()).toEqual({
      state: 'done',
      app: 'kimi-code',
      message: 'Fix terminal status',
    });
    expect(harness.children()[0]?.state).toBe('done');
  });

  it('marks queued child interactions blocked without changing the visible root block', () => {
    const harness = makeHarness();
    harness.controller.updateBackgroundTask(agentTask('running'));
    const interaction = harness.controller.startInteraction({
      agentId: 'agent-1',
      kind: 'permission',
    });
    expect(harness.root()?.state).toBe('working');
    expect(harness.children()[0]).toMatchObject({
      state: 'blocked',
      kind: 'permission',
      message: 'Approval required',
    });

    harness.controller.updateBackgroundTask(agentTask('running'));
    expect(harness.children()[0]?.state).toBe('blocked');
    harness.controller.setEditorBlocked({ kind: 'question', message: 'Answer required' });
    expect(harness.root()).toMatchObject({ state: 'blocked', kind: 'question' });
    harness.controller.setEditorBlocked(undefined);
    expect(harness.root()?.state).toBe('working');

    harness.controller.endInteraction(interaction);
    expect(harness.children()[0]?.state).toBe('working');
  });

  it('uses only the first error line and clears settled children on explicit user work', () => {
    const harness = makeHarness();
    harness.controller.updateBackgroundTask(agentTask('running'));
    harness.controller.updateBackgroundTask(
      agentTask('failed', { stopReason: 'provider failed\nstack frame must not be reported' }),
    );
    expect(harness.root()).toEqual({
      state: 'error',
      app: 'kimi-code',
      message: 'provider failed',
    });
    expect(harness.children()[0]).toMatchObject({ state: 'error', message: 'provider failed' });
    expect(JSON.stringify(harness.writes)).not.toContain('stack frame');

    harness.state.appState.streamingPhase = 'waiting';
    const automaticOrigin: TurnStartedEvent['origin'] = {
      kind: 'task',
      taskId: 'task-1',
      status: 'failed',
      notificationId: 'notification-1',
    };
    harness.controller.beginTurn(automaticOrigin);
    expect(harness.children()).toHaveLength(1);
    harness.controller.beginTurn({ kind: 'user' });
    expect(harness.children()).toHaveLength(0);
    expect(harness.root()?.state).toBe('working');
  });

  it('keeps settled children when an older turn event has no origin', () => {
    const harness = makeHarness();
    harness.controller.updateBackgroundTask(agentTask('completed'));
    harness.controller.beginTurn(undefined);
    expect(harness.children()).toHaveLength(1);
  });

  it('clears settled children when a user instruction steers into an existing turn', () => {
    const harness = makeHarness();
    harness.controller.updateBackgroundTask(agentTask('completed'));
    expect(harness.children()).toHaveLength(1);

    harness.state.appState.streamingPhase = 'thinking';
    harness.controller.beginUserInstruction();
    expect(harness.children()).toHaveLength(0);
    expect(harness.root()?.state).toBe('working');
  });

  it('restores only active agents and converges when restore is repeated', () => {
    const harness = makeHarness();
    harness.controller.restoreBackgroundTasks([
      agentTask('running'),
      agentTask('completed', { taskId: 'old-task', agentId: 'old-agent' }),
    ]);
    expect(harness.root()?.state).toBe('working');
    expect(harness.children()).toHaveLength(1);
    expect(harness.children()[0]?.state).toBe('working');

    const writeCount = harness.writes.length;
    harness.controller.restoreBackgroundTasks([
      agentTask('running'),
      agentTask('completed', { taskId: 'old-task', agentId: 'old-agent' }),
    ]);
    expect(harness.writes).toHaveLength(writeCount);

    harness.controller.resetSession();
    expect(harness.root()).toEqual({ state: 'idle', app: 'kimi-code' });
    expect(harness.children()).toHaveLength(0);
  });

  it('caps child records without dropping active agents from the root summary', () => {
    const harness = makeHarness();
    for (let index = 0; index < 64; index += 1) {
      harness.controller.updateBackgroundTask(
        agentTask('running', {
          taskId: `task-${index}`,
          agentId: `agent-${index}`,
        }),
      );
    }
    harness.controller.updateBackgroundTask(
      agentTask('completed', {
        taskId: 'overflow-result',
        agentId: 'overflow-agent',
        subagentType: 'overflow-result',
      }),
    );
    expect(harness.children()).toHaveLength(63);
    expect(harness.root()?.state).toBe('working');

    harness.controller.updateBackgroundTask(agentTask('killed', { taskId: 'task-0', agentId: 'agent-0' }));
    harness.controller.updateBackgroundTask(agentTask('completed', { taskId: 'task-1', agentId: 'agent-1' }));
    expect(harness.children()).toHaveLength(63);
    expect(
      harness.children().some((status) => status.title === 'Background agent: overflow-result'),
    ).toBe(false);
  });

  it('restores the underlying state after visible and auth blocks close', () => {
    const harness = makeHarness();
    harness.controller.refresh();
    harness.controller.setAuthBlocked(true);
    expect(harness.root()).toMatchObject({ state: 'blocked', kind: 'auth' });

    harness.controller.setEditorBlocked({ kind: 'permission', message: 'Workspace trust required' });
    expect(harness.root()).toMatchObject({ state: 'blocked', kind: 'permission' });
    harness.controller.setEditorBlocked(undefined);
    expect(harness.root()).toMatchObject({ state: 'blocked', kind: 'auth' });
    harness.controller.setAuthBlocked(false);
    expect(harness.root()).toEqual({ state: 'idle', app: 'kimi-code' });
  });
});
