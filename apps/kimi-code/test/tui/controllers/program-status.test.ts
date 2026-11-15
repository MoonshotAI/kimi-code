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

function makeHarness(childrenEnabled: boolean | 'default' = true) {
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
  const terminal = {
    setProgramStatus(status: ProgramStatus) {
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
  };
  const controller =
    childrenEnabled === 'default'
      ? new ProgramStatusController(state, terminal)
      : new ProgramStatusController(state, terminal, childrenEnabled);
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
    description: 'Review terminal status',
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

function automaticOrigin(): TurnStartedEvent['origin'] {
  return {
    kind: 'task',
    taskId: 'task-1',
    status: 'completed',
    notificationId: 'notification-1',
  };
}

describe('ProgramStatusController', () => {
  it('projects main work, queues, shell, and turn outcomes into the root record', () => {
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

    harness.controller.finishTurn(turnEnded('completed'));
    harness.state.appState.streamingPhase = 'shell';
    harness.controller.refresh();
    expect(harness.root()?.state).toBe('working');
    harness.state.appState.streamingPhase = 'idle';
    harness.controller.finishShell();
    expect(harness.root()).toEqual({ state: 'idle', app: 'kimi-code' });
  });

  it('keeps the root result independent of background agents and reports their task descriptions', () => {
    const harness = makeHarness();
    harness.controller.updateBackgroundTask(agentTask('running'));
    expect(harness.root()).toEqual({ state: 'idle', app: 'kimi-code' });
    expect(harness.children()).toEqual([
      {
        state: 'working',
        id: expect.any(String),
        title: 'Review terminal status',
      },
    ]);

    harness.controller.finishTurn(turnEnded('failed'));
    expect(harness.root()).toMatchObject({ state: 'error' });
    harness.controller.updateBackgroundTask(agentTask('completed'));
    expect(harness.root()).toMatchObject({ state: 'error' });
    expect(harness.children()[0]?.state).toBe('done');

    harness.controller.updateBackgroundTask(agentTask('killed'));
    expect(harness.root()).toMatchObject({ state: 'error' });
    expect(harness.children()).toHaveLength(0);
  });

  it('creates records for foreground subagents and keeps the same id after detaching', () => {
    const harness = makeHarness();
    harness.controller.startSubagent({ agentId: 'agent-1', title: 'Inspect terminal status' });
    const id = harness.children()[0]?.id;
    expect(id).toEqual(expect.any(String));
    expect(harness.children()[0]).toMatchObject({
      state: 'working',
      title: 'Inspect terminal status',
    });
    expect(harness.root()).toEqual({ state: 'idle', app: 'kimi-code' });

    harness.controller.updateBackgroundTask(
      agentTask('running', { taskId: 'detached-task', description: 'Inspect terminal status' }),
    );
    expect(harness.children()).toHaveLength(1);
    expect(harness.children()[0]?.id).toBe(id);

    harness.controller.completeSubagent('agent-1');
    expect(harness.children()[0]?.state).toBe('done');
  });

  it('projects queued child interactions onto both records and restores the underlying root result', () => {
    const harness = makeHarness();
    harness.controller.finishTurn(turnEnded('completed'));
    harness.controller.startSubagent({ agentId: 'agent-1', title: 'Review changes' });
    const interaction = harness.controller.startInteraction({
      agentId: 'agent-1',
      kind: 'permission',
    });

    expect(harness.root()).toMatchObject({ state: 'blocked', kind: 'permission' });
    expect(harness.children()[0]).toMatchObject({
      state: 'blocked',
      kind: 'permission',
      message: 'Approval required',
    });

    harness.controller.endInteraction(interaction);
    expect(harness.root()).toMatchObject({ state: 'done' });
    expect(harness.children()[0]?.state).toBe('working');
  });

  it('prioritizes auth, permission, and question without depending on panel mounting', () => {
    const harness = makeHarness();
    const question = harness.controller.startInteraction({ kind: 'question' });
    const permission = harness.controller.startInteraction({ kind: 'permission' });
    expect(harness.root()).toMatchObject({ state: 'blocked', kind: 'permission' });

    harness.controller.setAuthRequired(true);
    expect(harness.root()).toMatchObject({ state: 'blocked', kind: 'auth' });
    harness.controller.setAuthRequired(false);
    expect(harness.root()).toMatchObject({ state: 'blocked', kind: 'permission' });

    harness.controller.endInteraction(permission);
    expect(harness.root()).toMatchObject({ state: 'blocked', kind: 'question' });
    harness.controller.endInteraction(question);
    expect(harness.root()).toEqual({ state: 'idle', app: 'kimi-code' });
  });

  it('clears settled children at the end of an explicit turn, not at its start', () => {
    const harness = makeHarness();
    harness.controller.updateBackgroundTask(agentTask('completed'));

    harness.controller.beginTurn({ kind: 'user' });
    expect(harness.children()).toHaveLength(1);
    harness.state.appState.streamingPhase = 'waiting';
    harness.controller.refresh();
    expect(harness.root()?.state).toBe('working');
    expect(harness.children()).toHaveLength(1);

    harness.state.appState.streamingPhase = 'idle';
    harness.controller.finishTurn(turnEnded('completed'));
    expect(harness.children()).toHaveLength(0);
    expect(harness.root()?.state).toBe('done');
  });

  it('preserves settled children through automatic and unknown-origin turns', () => {
    const harness = makeHarness();
    harness.controller.updateBackgroundTask(agentTask('completed'));

    harness.controller.beginTurn(automaticOrigin());
    harness.controller.finishTurn(turnEnded('completed'));
    expect(harness.children()).toHaveLength(1);

    harness.controller.beginTurn(undefined);
    harness.controller.finishTurn(turnEnded('completed'));
    expect(harness.children()).toHaveLength(1);
  });

  it('clears settled children after an accepted user steer rather than at submission', () => {
    const harness = makeHarness();
    harness.controller.updateBackgroundTask(agentTask('completed'));

    harness.controller.markUserSteer();
    expect(harness.children()).toHaveLength(1);
    harness.controller.finishTurn(turnEnded('completed'));
    expect(harness.children()).toHaveLength(0);
  });

  it('acknowledges root results and settled children on focus return while preserving running work', () => {
    const harness = makeHarness();
    harness.controller.updateBackgroundTask(agentTask('completed'));
    harness.controller.startSubagent({ agentId: 'agent-2', title: 'Still running' });
    harness.controller.finishTurn(turnEnded('failed'));
    expect(harness.root()?.state).toBe('error');

    harness.controller.acknowledgeResults();
    expect(harness.root()).toEqual({ state: 'idle', app: 'kimi-code' });
    expect(harness.children()).toHaveLength(1);
    expect(harness.children()[0]).toMatchObject({ state: 'working', title: 'Still running' });
  });

  it('finishes successful and cancelled compactions as idle and reports request errors', () => {
    const harness = makeHarness();
    harness.controller.finishTurn(turnEnded('completed'));
    harness.state.appState.isCompacting = true;
    harness.controller.refresh();
    expect(harness.root()?.state).toBe('working');

    harness.state.appState.isCompacting = false;
    harness.controller.finishCompaction();
    expect(harness.root()).toEqual({ state: 'idle', app: 'kimi-code' });

    harness.controller.finishTurn(turnEnded('completed'));
    harness.controller.finishCompaction();
    expect(harness.root()).toEqual({ state: 'idle', app: 'kimi-code' });
    harness.controller.failRequest('compaction failed\nstack frame');
    expect(harness.root()).toMatchObject({ state: 'error', message: 'compaction failed' });
  });

  it('uses only the first child error line and never copies it to the root', () => {
    const harness = makeHarness();
    harness.controller.finishTurn(turnEnded('completed'));
    harness.controller.updateBackgroundTask(
      agentTask('failed', { stopReason: 'provider failed\nstack frame must not be reported' }),
    );

    expect(harness.root()).toMatchObject({ state: 'done' });
    expect(harness.children()[0]).toMatchObject({ state: 'error', message: 'provider failed' });
    expect(JSON.stringify(harness.writes)).not.toContain('stack frame');
  });

  it('does not resurrect a settled subagent when a stale running snapshot arrives', () => {
    const harness = makeHarness();
    harness.controller.startSubagent({ agentId: 'agent-1', title: 'Short task' });
    harness.controller.completeSubagent('agent-1');
    expect(harness.children()[0]?.state).toBe('done');

    harness.controller.updateBackgroundTask(agentTask('running'));
    expect(harness.children()[0]?.state).toBe('done');
    harness.controller.updateBackgroundTask(agentTask('completed'));
    expect(harness.children()[0]?.state).toBe('done');
  });

  it('restores only running agents without making the root work and converges when repeated', () => {
    const harness = makeHarness();
    harness.controller.restoreBackgroundTasks([
      agentTask('running'),
      agentTask('completed', { taskId: 'old-task', agentId: 'old-agent' }),
    ]);
    expect(harness.root()).toEqual({ state: 'idle', app: 'kimi-code' });
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

  it('selects blocked, error, working, and done records by priority and allows re-entry', () => {
    const harness = makeHarness();
    for (let index = 0; index < 60; index += 1) {
      const agentId = `done-${index}`;
      harness.controller.startSubagent({ agentId, title: agentId });
      harness.controller.completeSubagent(agentId);
    }
    for (let index = 60; index < 62; index += 1) {
      harness.controller.startSubagent({ agentId: `working-${index}`, title: `working-${index}` });
    }
    harness.controller.startSubagent({ agentId: 'error-62', title: 'error-62' });
    harness.controller.failSubagent('error-62', 'failed');
    harness.controller.startSubagent({ agentId: 'blocked-63', title: 'blocked-63' });
    const interaction = harness.controller.startInteraction({ agentId: 'blocked-63', kind: 'permission' });

    expect(harness.children()).toHaveLength(63);
    expect(harness.children().some((status) => status.title === 'done-0')).toBe(false);
    expect(harness.children().some((status) => status.title === 'blocked-63')).toBe(true);
    expect(harness.children().some((status) => status.title === 'error-62')).toBe(true);

    harness.controller.endInteraction(interaction);
    harness.controller.cancelSubagent('blocked-63');
    expect(harness.children()).toHaveLength(63);
    expect(harness.children().some((status) => status.title === 'done-0')).toBe(true);
  });

  it('evicts the oldest done records at 63 without imposing a result TTL', () => {
    const harness = makeHarness();
    for (let index = 0; index < 70; index += 1) {
      const agentId = `agent-${index}`;
      harness.controller.startSubagent({ agentId, title: `task-${index}` });
      harness.controller.completeSubagent(agentId);
    }

    expect(harness.children()).toHaveLength(63);
    for (let index = 0; index < 7; index += 1) {
      expect(harness.children().some((status) => status.title === `task-${index}`)).toBe(false);
    }
    expect(harness.children().some((status) => status.title === 'task-7')).toBe(true);
    expect(harness.children().some((status) => status.title === 'task-69')).toBe(true);

    harness.controller.refresh();
    expect(harness.children()).toHaveLength(63);
  });

  it('suppresses child reports when the multiplexer policy disables them', () => {
    const harness = makeHarness(false);
    harness.controller.refresh();
    harness.controller.startSubagent({ agentId: 'agent-1', title: 'Hidden child' });

    expect(harness.root()).toEqual({ state: 'idle', app: 'kimi-code' });
    expect(harness.children()).toHaveLength(0);
    expect(harness.writes.every((status) => status.id === undefined)).toBe(true);
  });

  it('keeps auth required across overlapping flows until it is explicitly resolved', () => {
    const harness = makeHarness();
    harness.controller.setAuthRequired(true);
    const releaseFirst = harness.controller.beginAuthBlock();
    const releaseSecond = harness.controller.beginAuthBlock();

    releaseFirst();
    releaseFirst();
    expect(harness.root()).toMatchObject({ state: 'blocked', kind: 'auth' });
    releaseSecond();
    expect(harness.root()).toMatchObject({ state: 'blocked', kind: 'auth' });
    harness.controller.setAuthRequired(false);
    expect(harness.root()).toEqual({ state: 'idle', app: 'kimi-code' });
  });

  it('detects tmux, screen, zellij, and herdr when suppressing child records', () => {
    const keys = ['TMUX', 'STY', 'ZELLIJ', 'ZELLIJ_SESSION_NAME', 'HERDR_ENV'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      for (const key of keys) delete process.env[key];
      const control = makeHarness('default');
      control.controller.startSubagent({ agentId: 'agent-1', title: 'Visible child' });
      expect(control.children()).toHaveLength(1);

      for (const key of keys) {
        for (const other of keys) delete process.env[other];
        process.env[key] = '1';
        const harness = makeHarness('default');
        harness.controller.startSubagent({ agentId: 'agent-1', title: 'Hidden child' });
        expect(harness.children()).toHaveLength(0);
      }
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('maps prompt-hook termination to error and deduplicates repeated terminal outcomes', () => {
    const harness = makeHarness();
    harness.controller.updateBackgroundTask(agentTask('running'));
    harness.controller.updateBackgroundTask(agentTask('completed'));
    const writeCount = harness.writes.length;

    harness.controller.completeSubagent('agent-1');
    harness.controller.updateBackgroundTask(agentTask('completed'));
    expect(harness.writes).toHaveLength(writeCount);

    harness.controller.finishTurn(turnEnded('blocked'));
    expect(harness.root()).toMatchObject({ state: 'error', message: 'Turn blocked by a prompt hook' });
  });
});
