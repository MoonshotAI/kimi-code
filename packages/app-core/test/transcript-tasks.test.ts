import { describe, expect, it } from 'vitest';
import type { AgentTranscriptSnapshot, TranscriptTask, TranscriptTurn } from '../src/transcript';

import { spawnedParentByAgentId, transcriptTasksToAppTasks } from '../src/client/transcriptTasks';

describe('transcriptTasksToAppTasks', () => {
  it('maps states, kinds and subagent fields onto AppTask rows', () => {
    const tasks: TranscriptTask[] = [
      task('agent-1', 'subagent', 'running', { agentId: 'agent-1', model: 'k3', thinkingEffort: 'high', detached: false }),
      task('agent-2', 'subagent', 'completed', { agentId: 'agent-2', resultSummary: 'found it' }),
      task('agent-3', 'subagent', 'killed', { agentId: 'agent-3' }),
      task('agent-4', 'subagent', 'timed_out', { agentId: 'agent-4' }),
      task('shell-1', 'shell', 'running', { description: 'pnpm test' }),
      task('tool-1', 'tool', 'lost', {}),
    ];
    const rows = transcriptTasksToAppTasks(snapshot(tasks), 's1');
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ['agent-1', 'running'],
      ['agent-2', 'completed'],
      ['agent-3', 'cancelled'],
      ['agent-4', 'failed'],
      ['shell-1', 'running'],
      ['tool-1', 'failed'],
    ]);
    expect(rows[0]).toMatchObject({ kind: 'subagent', model: 'k3', thinkingEffort: 'high', runInBackground: false });
    expect(rows[1]).toMatchObject({ text: 'found it' });
    expect(rows[4]).toMatchObject({ kind: 'bash', description: 'pnpm test' });
    expect(rows[5]).toMatchObject({ kind: 'tool' });
  });

  it('marks a running subagent with a state reason as suspended', () => {
    const rows = transcriptTasksToAppTasks(
      snapshot([task('agent-1', 'subagent', 'running', { agentId: 'agent-1', stateReason: 'approval' })]),
      's1',
    );
    expect(rows[0]?.subagentPhase).toBe('suspended');
  });

  it('folds a background agent and its task-store row into one dock row', () => {
    const rows = transcriptTasksToAppTasks(
      snapshot([
        task('agent-0', 'subagent', 'running', { agentId: 'agent-0', description: 'bg work' }),
        task('bt-9', 'subagent', 'running', { agentId: 'agent-0', model: 'k3', thinkingEffort: 'high' }),
      ]),
      's1',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'agent-0',
      backgroundTaskId: 'bt-9',
      model: 'k3',
      thinkingEffort: 'high',
      description: 'bg work',
    });
  });

  it('keeps a background-task row that has no agent row', () => {
    const rows = transcriptTasksToAppTasks(
      snapshot([task('bt-9', 'subagent', 'running', { agentId: 'agent-0' })]),
      's1',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('bt-9');
  });

  it('derives parentToolCallId from the spawning frame agentRefs', () => {
    const turn: TranscriptTurn = {
      kind: 'turn',
      turnId: 't0',
      ordinal: 0,
      state: 'running',
      origin: { kind: 'user' },
      steps: [{
        kind: 'step',
        stepId: 't0.1',
        turnId: 't0',
        ordinal: 1,
        state: 'running',
        frames: [{
          kind: 'tool',
          frameId: 't0.1.call_agent',
          toolCallId: 'call_agent',
          name: 'Agent',
          state: 'running',
          agentRefs: [{ agentId: 'agent-1', role: 'child' }],
        }],
      }],
    };
    const snap = snapshot([task('agent-1', 'subagent', 'running', { agentId: 'agent-1' })], [turn]);
    expect(spawnedParentByAgentId(snap).get('agent-1')).toBe('call_agent');
    expect(transcriptTasksToAppTasks(snap, 's1')[0]?.parentToolCallId).toBe('call_agent');
  });

  it('restores the swarm member index from the spawning frame ref order', () => {
    const turn: TranscriptTurn = {
      kind: 'turn',
      turnId: 't0',
      ordinal: 0,
      state: 'running',
      origin: { kind: 'user' },
      steps: [{
        kind: 'step',
        stepId: 't0.1',
        turnId: 't0',
        ordinal: 1,
        state: 'running',
        frames: [{
          kind: 'tool',
          frameId: 't0.1.call_swarm',
          toolCallId: 'call_swarm',
          name: 'AgentSwarm',
          state: 'running',
          agentRefs: [
            { agentId: 'agent-1', role: 'child' },
            { agentId: 'agent-2', role: 'child' },
            { agentId: 'agent-3', role: 'child' },
          ],
        }],
      }],
    };
    const snap = snapshot(
      [
        task('agent-1', 'subagent', 'running', { agentId: 'agent-1' }),
        task('agent-2', 'subagent', 'running', { agentId: 'agent-2' }),
        task('agent-3', 'subagent', 'running', { agentId: 'agent-3' }),
      ],
      [turn],
    );
    const rows = transcriptTasksToAppTasks(snap, 's1');
    expect(rows.map((r) => [r.id, r.swarmIndex, r.parentToolCallId])).toEqual([
      ['agent-1', 0, 'call_swarm'],
      ['agent-2', 1, 'call_swarm'],
      ['agent-3', 2, 'call_swarm'],
    ]);
  });

  it('exposes the state reason as suspendedReason only while running', () => {
    const rows = transcriptTasksToAppTasks(
      snapshot([
        task('agent-1', 'subagent', 'running', { agentId: 'agent-1', stateReason: 'approval' }),
        task('agent-2', 'subagent', 'timed_out', { agentId: 'agent-2', stateReason: 'timed out' }),
      ]),
      's1',
    );
    expect(rows[0]?.suspendedReason).toBe('approval');
    expect(rows[1]?.suspendedReason).toBeUndefined();
  });
});

function task(
  taskId: string,
  kind: TranscriptTask['kind'],
  state: TranscriptTask['state'],
  extra: Partial<TranscriptTask>,
): TranscriptTask {
  return { taskId, kind, state, detached: true, outputTail: '', ...extra };
}

function snapshot(tasks: TranscriptTask[], items: AgentTranscriptSnapshot['items'] = []): AgentTranscriptSnapshot {
  return {
    items,
    tasks,
    interactions: [],
    attachments: [],
    todos: [],
    prompts: [],
    meta: { activity: 'idle' },
    hasMoreOlder: false,
  };
}
