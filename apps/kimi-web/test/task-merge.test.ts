// Regression test for the swarm/subagent "running" flicker.
//
// Background-task refreshes (the 1s output poll and the session-load task fetch)
// rebuild tasksBySession from REST /tasks, which lists only the main agent's
// background store and never returns foreground swarm subagents. A plain replace
// dropped those WS-delivered subagents on every refresh, so the next event
// re-added them — flickering the swarm cards once per second. keepLiveSubagents
// is what carries them across the refresh.

import { describe, expect, it } from 'vitest';
import { createInitialState, reduceAppEvent } from '../src/api/daemon/eventReducer';
import { keepLiveSubagents } from '../src/lib/taskMerge';
import type { AppTask } from '../src/api/types';

function task(id: string, kind: AppTask['kind'], extra: Partial<AppTask> = {}): AppTask {
  return {
    id,
    sessionId: 'ses_1',
    kind,
    description: id,
    status: 'running',
    createdAt: '2026-06-15T00:00:00.000Z',
    ...extra,
  };
}

describe('keepLiveSubagents', () => {
  it('keeps a live subagent that the REST list omits (the flicker fix)', () => {
    const restBased = [task('bg_1', 'bash')];
    const existing = [task('bg_1', 'bash'), task('agent_1', 'subagent', { swarmIndex: 1 })];

    const merged = keepLiveSubagents(restBased, existing);

    expect(merged.map((t) => t.id)).toEqual(['bg_1', 'agent_1']);
  });

  it('preserves the live subagent output across the refresh', () => {
    const restBased = [task('bg_1', 'bash')];
    const existing = [
      task('agent_1', 'subagent', { outputLines: ['Calling Bash: pnpm test'], subagentPhase: 'working' }),
    ];

    const merged = keepLiveSubagents(restBased, existing);
    const subagent = merged.find((t) => t.id === 'agent_1');

    expect(subagent?.outputLines).toEqual(['Calling Bash: pnpm test']);
    expect(subagent?.subagentPhase).toBe('working');
  });

  it('stays REST-authoritative for background tasks (drops ones REST no longer lists)', () => {
    const restBased: AppTask[] = [];
    const existing = [task('bg_done', 'bash', { status: 'completed' })];

    // A finished background task that left the REST list is genuinely gone.
    expect(keepLiveSubagents(restBased, existing)).toEqual([]);
  });

  it('does not duplicate a subagent that REST does return', () => {
    const restBased = [task('agent_1', 'subagent', { swarmIndex: 1 })];
    const existing = [task('agent_1', 'subagent', { swarmIndex: 1 })];

    const merged = keepLiveSubagents(restBased, existing);

    expect(merged.filter((t) => t.id === 'agent_1')).toHaveLength(1);
  });

  it('deduplicates repeated progress and keeps only the recent tail', () => {
    let state = createInitialState();
    state.tasksBySession['ses_1'] = [task('agent_1', 'subagent')];

    state = reduceAppEvent(
      state,
      { type: 'taskProgress', sessionId: 'ses_1', taskId: 'agent_1', outputChunk: 'same progress', stream: 'stdout' },
      { sessionId: 'ses_1', seq: 1 },
    );
    state = reduceAppEvent(
      state,
      { type: 'taskProgress', sessionId: 'ses_1', taskId: 'agent_1', outputChunk: 'same progress', stream: 'stdout' },
      { sessionId: 'ses_1', seq: 2 },
    );

    expect(state.tasksBySession['ses_1']?.[0]?.outputLines).toEqual(['same progress']);

    for (let i = 0; i < 45; i += 1) {
      state = reduceAppEvent(
        state,
        { type: 'taskProgress', sessionId: 'ses_1', taskId: 'agent_1', outputChunk: `line ${i}`, stream: 'stdout' },
        { sessionId: 'ses_1', seq: 3 + i },
      );
    }

    const lines = state.tasksBySession['ses_1']?.[0]?.outputLines ?? [];
    expect(lines).toHaveLength(40);
    expect(lines[0]).toBe('line 5');
    expect(lines.at(-1)).toBe('line 44');
  });
});
