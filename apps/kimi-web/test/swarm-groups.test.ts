import { describe, expect, it } from 'vitest';
import type { AppTask } from '../src/api/types';
import {
  buildSwarmGroups,
  countSwarmMembers,
  swarmMembersByToolCall,
} from '../src/composables/swarmGroups';

function subagentTask(
  id: string,
  parentToolCallId: string | undefined,
  opts: {
    swarmIndex?: number;
    status?: AppTask['status'];
    subagentPhase?: AppTask['subagentPhase'];
    text?: string;
    outputLines?: string[];
  } = {},
): AppTask {
  return {
    id,
    sessionId: 'session-1',
    kind: 'subagent',
    description: `subagent ${id}`,
    status: opts.status ?? 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    parentToolCallId,
    swarmIndex: opts.swarmIndex,
    text: opts.text,
    outputLines: opts.outputLines,
    subagentPhase: opts.subagentPhase ?? 'working',
  };
}

function bashTask(id: string): AppTask {
  return {
    id,
    sessionId: 'session-1',
    kind: 'bash',
    description: `bash ${id}`,
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('buildSwarmGroups', () => {
  it('emits a group only when two or more members share a swarmIndex', () => {
    const groups = buildSwarmGroups([
      subagentTask('a', 'swarm-1', { swarmIndex: 1 }),
      subagentTask('b', 'swarm-1', { swarmIndex: 2 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe('swarm-1');
    expect(groups[0]?.members.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('filters single-member groups (used for the badge counter)', () => {
    const groups = buildSwarmGroups([subagentTask('a', 'swarm-1', { swarmIndex: 1 })]);
    expect(groups).toHaveLength(0);
  });

  it('ignores subagents without a swarmIndex', () => {
    const groups = buildSwarmGroups([
      subagentTask('a', 'swarm-1'),
      subagentTask('b', 'swarm-1'),
    ]);
    expect(groups).toHaveLength(0);
  });
});

describe('countSwarmMembers', () => {
  it('counts completed + failed as done across groups', () => {
    const groups = buildSwarmGroups([
      subagentTask('a', 'swarm-1', { swarmIndex: 1, subagentPhase: 'completed', status: 'completed' }),
      subagentTask('b', 'swarm-1', { swarmIndex: 2, subagentPhase: 'failed', status: 'failed' }),
      subagentTask('c', 'swarm-2', { swarmIndex: 1, subagentPhase: 'working' }),
      subagentTask('d', 'swarm-2', { swarmIndex: 2, subagentPhase: 'queued' }),
    ]);
    expect(countSwarmMembers(groups)).toEqual({ done: 2, total: 4 });
  });
});

describe('swarmMembersByToolCall', () => {
  it('keeps single-member swarms so a resume-only AgentSwarm gets live progress', () => {
    const map = swarmMembersByToolCall([subagentTask('a', 'swarm-1', { swarmIndex: 1 })]);
    expect(map.get('swarm-1')?.map((m) => m.id)).toEqual(['a']);
  });

  it('groups every subagent with the same parentToolCallId, ignoring swarmIndex', () => {
    const map = swarmMembersByToolCall([
      subagentTask('b', 'swarm-1'),
      subagentTask('a', 'swarm-1'),
      subagentTask('c', 'swarm-2'),
    ]);
    expect(map.get('swarm-1')?.map((m) => m.id)).toEqual(['a', 'b']);
    expect(map.get('swarm-2')?.map((m) => m.id)).toEqual(['c']);
  });

  it('ignores non-subagent tasks and subagents without a parentToolCallId', () => {
    const map = swarmMembersByToolCall([
      bashTask('b-1'),
      subagentTask('orphan', undefined),
      subagentTask('a', 'swarm-1'),
    ]);
    expect([...map.keys()]).toEqual(['swarm-1']);
  });

  it('carries task.text so live rows can show still-composing subagent output', () => {
    const map = swarmMembersByToolCall([
      subagentTask('a', 'swarm-1', { text: 'Hello, world!' }),
      subagentTask('b', 'swarm-1', { outputLines: ['tool line'] }),
    ]);
    const rows = map.get('swarm-1') ?? [];
    expect(rows[0]).toMatchObject({ id: 'a', text: 'Hello, world!' });
    expect(rows[1]).toMatchObject({ id: 'b', outputLines: ['tool line'] });
  });
});

describe('buildSwarmGroups preserves streamed text', () => {
  it('carries task.text into each group member', () => {
    const groups = buildSwarmGroups([
      subagentTask('a', 'swarm-1', { swarmIndex: 1, text: 'first line' }),
      subagentTask('b', 'swarm-1', { swarmIndex: 2, text: 'second line' }),
    ]);
    expect(groups[0]?.members.map((m) => m.text)).toEqual(['first line', 'second line']);
  });
});
