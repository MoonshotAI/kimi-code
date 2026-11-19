import { describe, expect, it } from 'vitest';
import type { SessionTask } from '../src/api/types';

import { sessionTasksToAppTasks, subagentDisplayName } from '../src/client/sessionTasks';

describe('sessionTasksToAppTasks', () => {
  it('maps states, kinds and subagent fields onto AppTask rows', () => {
    const tasks: SessionTask[] = [
      task('agent-1', 'subagent', 'running', { agentId: 'a1', model: 'k3', thinkingEffort: 'high', detached: false }),
      task('agent-2', 'subagent', 'completed', { agentId: 'a2', resultSummary: 'found it' }),
      task('agent-3', 'subagent', 'killed', { agentId: 'a3' }),
      task('agent-4', 'subagent', 'timed_out', { agentId: 'a4' }),
      task('shell-1', 'shell', 'running', { description: 'pnpm test' }),
      task('other-1', 'other', 'lost', {}),
    ];
    const rows = sessionTasksToAppTasks(tasks, 's1');
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ['agent-1', 'running'],
      ['agent-2', 'completed'],
      ['agent-3', 'cancelled'],
      ['agent-4', 'failed'],
      ['shell-1', 'running'],
      ['other-1', 'failed'],
    ]);
    expect(rows[0]).toMatchObject({
      kind: 'subagent',
      agentId: 'a1',
      model: 'k3',
      thinkingEffort: 'high',
      runInBackground: false,
    });
    expect(rows[1]).toMatchObject({ text: 'found it' });
    expect(rows[4]).toMatchObject({ kind: 'bash', description: 'pnpm test' });
    expect(rows[5]).toMatchObject({ kind: 'tool' });
  });

  it('carries the shell command and the spawning tool call', () => {
    const rows = sessionTasksToAppTasks(
      [task('shell-1', 'shell', 'running', { command: 'sleep 60', parentToolCallId: 'call_bash' })],
      's1',
    );
    expect(rows[0]).toMatchObject({ command: 'sleep 60', parentToolCallId: 'call_bash' });
  });

  it('keeps the swarm position the server reports for each member', () => {
    const rows = sessionTasksToAppTasks(
      [
        task('agent-1', 'subagent', 'running', { agentId: 'a1', parentToolCallId: 'call_swarm', swarmIndex: 0 }),
        task('agent-2', 'subagent', 'running', { agentId: 'a2', parentToolCallId: 'call_swarm', swarmIndex: 1 }),
      ],
      's1',
    );
    expect(rows.map((r) => [r.id, r.swarmIndex, r.parentToolCallId])).toEqual([
      ['agent-1', 0, 'call_swarm'],
      ['agent-2', 1, 'call_swarm'],
    ]);
  });

  it('takes the running subagent phase from the server', () => {
    const rows = sessionTasksToAppTasks(
      [
        task('agent-1', 'subagent', 'running', { agentId: 'a1', phase: 'suspended' }),
        task('agent-2', 'subagent', 'running', { agentId: 'a2', phase: 'working' }),
      ],
      's1',
    );
    expect(rows.map((row) => row.subagentPhase)).toEqual(['suspended', 'working']);
  });

  it('exposes the state reason as suspendedReason only while running', () => {
    const rows = sessionTasksToAppTasks(
      [
        task('agent-1', 'subagent', 'running', { agentId: 'a1', stateReason: 'approval' }),
        task('agent-2', 'subagent', 'timed_out', { agentId: 'a2', stateReason: 'timed out' }),
      ],
      's1',
    );
    expect(rows[0]?.suspendedReason).toBe('approval');
    expect(rows[1]?.suspendedReason).toBeUndefined();
  });
});

describe('subagentDisplayName', () => {
  it('names a subagent by the description of the task that started it', () => {
    const tasks = [
      task('shell-1', 'shell', 'running', { description: 'pnpm test' }),
      task('agent-1', 'subagent', 'running', { agentId: 'agent-3', description: 'Inspect the docs' }),
    ];
    expect(subagentDisplayName(tasks, 'agent-3')).toBe('Inspect the docs');
  });

  it('shortens a long description so the badge keeps its width', () => {
    const description = 'Audit every file under packages for unused exports and stale imports';
    const tasks = [task('agent-1', 'subagent', 'running', { agentId: 'agent-3', description })];
    const name = subagentDisplayName(tasks, 'agent-3');
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name.endsWith('…')).toBe(true);
    expect(description.startsWith(name.slice(0, -1))).toBe(true);
  });

  it('names a resumed subagent by its running task', () => {
    const tasks = [
      task('agent-1', 'subagent', 'running', { agentId: 'agent-3', description: 'Fix the tests' }),
      task('agent-0', 'subagent', 'completed', { agentId: 'agent-3', description: 'Write the tests' }),
    ];
    expect(subagentDisplayName(tasks, 'agent-3')).toBe('Fix the tests');
  });

  it('never splits a character outside the basic plane when shortening', () => {
    const description = `${'🚀'.repeat(39)}xy`;
    const tasks = [task('agent-1', 'subagent', 'running', { agentId: 'agent-3', description })];
    expect(subagentDisplayName(tasks, 'agent-3')).toBe(`${'🚀'.repeat(39)}…`);
  });

  it('falls back to the agent id when no task describes it', () => {
    const tasks = [task('agent-1', 'subagent', 'running', { agentId: 'agent-3', description: ' ' })];
    expect(subagentDisplayName(tasks, 'agent-3')).toBe('agent-3');
    expect(subagentDisplayName(tasks, 'agent-9')).toBe('agent-9');
  });
});

function task(
  taskId: string,
  kind: SessionTask['kind'],
  state: SessionTask['state'],
  extra: Partial<SessionTask>,
): SessionTask {
  return { taskId, kind, state, detached: true, ...extra };
}
