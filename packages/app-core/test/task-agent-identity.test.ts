import { describe, expect, it } from 'vitest';
import { toSessionTask } from '../src/api/daemon/mappers';
import type { WireTaskState } from '../src/api/daemon/wire';

describe('task state mapping', () => {
  const subagentTask: WireTaskState = {
    task_id: 'task-9',
    kind: 'subagent',
    status: 'ended',
    outcome: 'timed_out',
    detached: true,
    child_agent_id: 'agent-1',
    parent_tool_call_id: 'call_agent',
    swarm_index: 2,
    started_at: '2026-10-28T00:00:00.000Z',
    ended_at: '2026-10-28T00:00:01.000Z',
    model: 'example-model',
    thinking: 'high',
  };

  it('maps an ended task to its outcome, the child agent id and its swarm position', () => {
    expect(toSessionTask(subagentTask)).toMatchObject({
      taskId: 'task-9',
      kind: 'subagent',
      state: 'timed_out',
      agentId: 'agent-1',
      parentToolCallId: 'call_agent',
      swarmIndex: 2,
      startedAt: '2026-10-28T00:00:00.000Z',
      endedAt: '2026-10-28T00:00:01.000Z',
      model: 'example-model',
      thinkingEffort: 'high',
    });
  });

  it('keeps the phase of a running subagent', () => {
    const { outcome: _outcome, ...running } = subagentTask;
    expect(toSessionTask({ ...running, status: 'running', phase: 'suspended' })).toMatchObject({
      state: 'running',
      phase: 'suspended',
    });
  });

  it('maps a running shell task and keeps its command', () => {
    const { outcome: _outcome, ...running } = subagentTask;
    expect(
      toSessionTask({ ...running, kind: 'shell', status: 'running', command: 'sleep 60' }),
    ).toMatchObject({ kind: 'shell', state: 'running', command: 'sleep 60' });
  });

  it('keeps whether the starting tool call still waits for the task', () => {
    expect(toSessionTask({ ...subagentTask, detached: false }).detached).toBe(false);
    expect(toSessionTask(subagentTask).detached).toBe(true);
  });
});
