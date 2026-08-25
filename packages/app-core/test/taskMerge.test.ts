import { describe, expect, it } from 'vitest';
import { keepLiveSubagents } from '../src/lib/taskMerge';
import type { AppTask } from '../src/api/types';

function task(overrides: Partial<AppTask>): AppTask {
  return {
    id: 'task-1',
    sessionId: 's1',
    kind: 'subagent',
    description: 'explore project',
    status: 'running',
    createdAt: '2026-08-06T00:00:00.000Z',
    ...overrides,
  };
}

describe('keepLiveSubagents foreground-task fold', () => {
  it('folds a mid-run foreground task record into the agent’s WS row instead of surfacing a second row', () => {
    // The WS stream keys the foreground agent by agent id; REST /tasks lists
    // its non-detached task record under a registration id while the run is
    // live. Without the agent-id fold both rows survive.
    const live = task({
      id: 'agent-8',
      agentId: 'agent-8',
      runInBackground: false,
      subagentPhase: 'working',
    });
    const rest = task({
      id: 'agent-qnklteu1',
      agentId: 'agent-8',
      status: 'running',
      model: 'provider/rest',
    });

    const merged = keepLiveSubagents([rest], [live]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: 'agent-8',
      status: 'running',
      runInBackground: false,
      model: 'provider/rest',
    });
  });

  it('never lets a stale running foreground record resurrect a settled WS row', () => {
    const live = task({
      id: 'agent-8',
      agentId: 'agent-8',
      runInBackground: false,
      status: 'completed',
      subagentPhase: 'completed',
    });
    const rest = task({ id: 'agent-qnklteu1', agentId: 'agent-8', status: 'running' });

    const merged = keepLiveSubagents([rest], [live]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'agent-8', status: 'completed', subagentPhase: 'completed' });
  });

  it('still folds a background REST row whose binding the WS row has not learned yet', () => {
    const live = task({ id: 'agent-10', agentId: 'agent-10', runInBackground: true });
    const rest = task({ id: 'agent-wus25z1l', agentId: 'agent-10', status: 'completed' });

    const merged = keepLiveSubagents([rest], [live]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'agent-10', status: 'completed', subagentPhase: 'completed' });
  });
});

describe('keepLiveSubagents model/effort fold', () => {
  it('fills display metadata from the REST row when the live row lacks it', () => {
    const live = task({ id: 'agent-1', agentId: 'agent-1', backgroundTaskId: 'task-9' });
    const rest = task({
      id: 'task-9',
      model: 'provider/secondary',
      thinkingEffort: 'low',
    });

    const merged = keepLiveSubagents([rest], [live]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: 'agent-1',
      model: 'provider/secondary',
      thinkingEffort: 'low',
    });
  });

  it('keeps the live row metadata when both copies carry it', () => {
    const live = task({
      id: 'agent-1',
      agentId: 'agent-1',
      backgroundTaskId: 'task-9',
      model: 'provider/live',
      thinkingEffort: 'high',
    });
    const rest = task({ id: 'task-9', model: 'provider/rest', thinkingEffort: 'low' });

    const merged = keepLiveSubagents([rest], [live]);

    expect(merged[0]).toMatchObject({ model: 'provider/live', thinkingEffort: 'high' });
  });
});
