import { describe, expect, it } from 'vitest';
import type { AppSubagentPhase } from '../src/api/types';
import type { SwarmMember } from '../src/client';
import type { SwarmResult } from '../src/lib';
import { buildSwarmCardRows, swarmMemberActivity } from '../src/client';

function member(
  id: string,
  name: string,
  opts: {
    phase?: AppSubagentPhase;
    text?: string;
    outputLines?: string[];
    suspendedReason?: string;
    subagentType?: string;
  } = {},
): SwarmMember {
  return {
    id,
    agentId: id,
    name,
    phase: opts.phase ?? 'working',
    text: opts.text,
    outputLines: opts.outputLines,
    suspendedReason: opts.suspendedReason,
    subagentType: opts.subagentType,
    swarmIndex: 0,
  };
}

function result(subagents: SwarmResult['subagents']): SwarmResult {
  return {
    summary: `${subagents.length}`,
    completed: subagents.filter((s) => s.outcome === 'completed').length,
    failed: subagents.filter((s) => s.outcome === 'failed').length,
    aborted: subagents.filter((s) => s.outcome === 'aborted').length,
    total: subagents.length,
    subagents,
  };
}

describe('swarmMemberActivity', () => {
  it('prefers streamed subagent text over outputLines', () => {
    const m = member('a', '子任务', {
      text: 'line 1\nline 2',
      outputLines: ['tool call output'],
    });
    expect(swarmMemberActivity(m)).toBe('line 2');
  });

  it('falls back to the last outputLines entry when no text is streaming', () => {
    const m = member('a', '子任务', { outputLines: ['one', 'two'] });
    expect(swarmMemberActivity(m)).toBe('two');
  });
});

describe('buildSwarmCardRows', () => {
  it('builds rows from live members when no parsed result exists', () => {
    const rows = buildSwarmCardRows(
      [member('a', '子任务 A', { text: 'streaming' })],
      null,
    );
    expect(rows).toEqual([{
      id: 'a',
      agentId: 'a',
      taskId: 'a',
      name: '子任务 A',
      activity: 'streaming',
      detail: 'streaming',
      phase: 'working',
    }]);
  });

  it('strips a trailing agent-type suffix from member names', () => {
    const rows = buildSwarmCardRows(
      [
        member('a', '审查模块 #3 (explore)', { subagentType: 'explore' }),
        member('b', '审查模块 #4 (explore)', { subagentType: 'explore' }),
        member('c', '审查模块 #5 (custom)', { subagentType: 'explore' }),
      ],
      null,
    );
    expect(rows.map((r) => r.name)).toEqual(['审查模块 #3', '审查模块 #4', '审查模块 #5 (custom)']);
  });

  it('keeps per-row type suffixes when members have mixed agent types', () => {
    const rows = buildSwarmCardRows(
      [
        member('a', '审查模块 #3 (explore)', { subagentType: 'explore' }),
        member('b', '审查模块 #4 (custom)', { subagentType: 'custom' }),
      ],
      null,
    );
    expect(rows.map((r) => r.name)).toEqual(['审查模块 #3 (explore)', '审查模块 #4 (custom)']);
  });

  it('keeps a member without an agent id readable without treating its task id as an agent id', () => {
    const taskMember = member('task-1', '后台子任务', {
      phase: 'completed',
      text: 'saved output',
    });
    taskMember.agentId = undefined;

    expect(buildSwarmCardRows([taskMember], null)).toEqual([{
      id: 'task-1',
      agentId: undefined,
      taskId: 'task-1',
      name: '后台子任务',
      activity: 'saved output',
      detail: 'saved output',
      phase: 'completed',
    }]);
  });

  it('carries a suspended member\'s reason on its row', () => {
    const rows = buildSwarmCardRows(
      [member('a1', 'A', { phase: 'suspended', suspendedReason: 'Waiting for approval' }), member('a2', 'B')],
      null,
    );
    expect(rows.map((r) => r.suspendedReason)).toEqual(['Waiting for approval', undefined]);
  });

  it('keeps the task id on member rows but not on result-only rows', () => {
    const live = member('task-2', 'A', { phase: 'queued' });
    live.agentId = undefined;
    const rows = buildSwarmCardRows(
      [live],
      result([
        { item: 'A', outcome: 'completed', state: 'finished', body: 'done' },
        { item: 'Z', outcome: 'aborted', state: 'not_started', body: '' },
      ]),
    );
    expect(rows.map((r) => [r.name, r.taskId])).toEqual([['A', 'task-2'], ['Z', undefined]]);
  });

  it('builds rows from result subagents when no members are present', () => {
    const rows = buildSwarmCardRows(
      [],
      result([
        { outcome: 'completed', item: 'A', body: 'A body' },
        { outcome: 'failed', item: 'B', body: 'B body' },
      ]),
    );
    expect(rows.map((r) => r.name)).toEqual(['A', 'B']);
    expect(rows.map((r) => r.phase)).toEqual(['completed', 'failed']);
    expect(rows.map((r) => r.agentId)).toEqual([undefined, undefined]);
  });

  it('appends result-only aborted not_started rows on top of live members', () => {
    const rows = buildSwarmCardRows(
      [
        member('a1', '子任务 A', { phase: 'completed' }),
        member('a2', '子任务 B', { phase: 'working' }),
      ],
      result([
        { outcome: 'completed', item: 'A', agentId: 'a1', body: 'A body' },
        { outcome: 'completed', item: 'B', agentId: 'a2', body: 'B body' },
        { outcome: 'aborted', item: 'C', state: 'not_started', body: 'C never started' },
      ]),
    );
    expect(rows.map((r) => r.id)).toEqual(['a1', 'a2', 'C']);
    expect(rows.map((r) => r.agentId)).toEqual(['a1', 'a2', undefined]);
    expect(rows[2]?.phase).toBe('cancelled');
    expect(rows[2]?.activity).toBe('C never started');
    expect(rows[2]?.detail).toBe('C never started');
  });

  it('carries the full saved result as row detail for members that have no agent id', () => {
    const restMember = member('task-1', '后台子任务', {
      phase: 'completed',
      text: 'first line\nsecond line\nthird line',
    });
    restMember.agentId = undefined;

    expect(buildSwarmCardRows([restMember], null)[0]?.detail).toBe('first line\nsecond line\nthird line');
  });

  it('keeps the whole result body on result-only rows, not just its first line', () => {
    const rows = buildSwarmCardRows(
      [],
      result([{ outcome: 'completed', item: 'A', body: 'headline\nrest of the body' }]),
    );
    expect(rows[0]?.activity).toBe('headline');
    expect(rows[0]?.detail).toBe('headline\nrest of the body');
  });

  it('does not duplicate a result row that a live member already covers', () => {
    const rows = buildSwarmCardRows(
      [member('a1', '子任务 A', { phase: 'failed' })],
      result([{ outcome: 'aborted', item: 'A', agentId: 'a1', body: 'A body' }]),
    );
    expect(rows.map((r) => r.id)).toEqual(['a1']);
    expect(rows[0]?.phase).toBe('failed');
  });

  it('matches by item substring when agent ids disagree', () => {
    const rows = buildSwarmCardRows(
      [member('a1', 'find unused exports in src', { phase: 'completed' })],
      result([{ outcome: 'aborted', item: 'unused exports', state: 'not_started', body: 'x' }]),
    );
    expect(rows.map((r) => r.id)).toEqual(['a1']);
  });
});
