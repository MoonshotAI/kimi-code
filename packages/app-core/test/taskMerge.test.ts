import { describe, expect, it } from 'vitest';
import { keepLiveSubagents, mergeSnapshotSubagents } from '../src/lib/taskMerge';
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

describe('mergeSnapshotSubagents metadata', () => {
  it('keeps the live status-fallback values when the roster omits them', () => {
    const live = task({
      id: 'agent-1',
      agentId: 'agent-1',
      model: 'provider/live',
      thinkingEffort: 'low',
      outputLines: ['working…'],
    });
    const rosterRow = task({ id: 'agent-1', agentId: 'agent-1' });

    const merged = mergeSnapshotSubagents([rosterRow], [live]);

    expect(merged[0]).toMatchObject({
      model: 'provider/live',
      thinkingEffort: 'low',
      outputLines: ['working…'],
    });
  });

  it('lets the roster value win when it carries one', () => {
    const live = task({ id: 'agent-1', agentId: 'agent-1', model: 'provider/live' });
    const rosterRow = task({ id: 'agent-1', agentId: 'agent-1', model: 'provider/roster' });

    const merged = mergeSnapshotSubagents([rosterRow], [live]);

    expect(merged[0]!.model).toBe('provider/roster');
  });
});
