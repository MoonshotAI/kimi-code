import { describe, expect, it } from 'vitest';
import type { AppMessage, AppMessageContent, AppTask } from '../src/api/types';
import { latestTodos } from '../src/composables/latestTodos';
import { messagesToTurns } from '../src/composables/messagesToTurns';

function message(
  id: string,
  role: AppMessage['role'],
  content: AppMessageContent[],
  extra: Partial<AppMessage> = {},
): AppMessage {
  return {
    id,
    sessionId: 'session-1',
    role,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

function subagentTask(
  id: string,
  parentToolCallId: string,
  swarmIndex: number,
  subagentPhase: AppTask['subagentPhase'],
): AppTask {
  return {
    id,
    sessionId: 'session-1',
    kind: 'subagent',
    description: `subagent ${swarmIndex}`,
    status:
      subagentPhase === 'failed'
        ? 'failed'
        : subagentPhase === 'completed'
          ? 'completed'
          : 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    parentToolCallId,
    swarmIndex,
    subagentPhase,
  };
}

describe('messagesToTurns', () => {
  it('merges an assistant turn and folds tool results into it', () => {
    const turns = messagesToTurns(
      [
        message('u1', 'user', [{ type: 'text', text: 'hello' }]),
        message('a1', 'assistant', [
          { type: 'thinking', thinking: 'plan' },
          { type: 'toolUse', toolCallId: 'tool-1', toolName: 'read', input: { path: 'src/a.ts' } },
        ]),
        message('t1', 'tool', [{ type: 'toolResult', toolCallId: 'tool-1', output: 'alpha\nbeta' }]),
        message('a2', 'assistant', [{ type: 'text', text: 'done' }]),
      ],
      [],
      undefined,
      false,
      [],
    );

    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({
      role: 'assistant',
      thinking: 'plan',
      text: 'done',
    });
    expect(turns[1]?.tools).toMatchObject([
      { id: 'tool-1', status: 'ok', output: ['alpha', 'beta'] },
    ]);
  });

  it('splits assistant turns when prompt ids differ', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [{ type: 'text', text: 'one' }], { promptId: 'p1' }),
        message('a2', 'assistant', [{ type: 'text', text: 'two' }], { promptId: 'p2' }),
      ],
      [],
      undefined,
      false,
      [],
    );

    expect(turns.map((turn) => turn.text)).toEqual(['one', 'two']);
  });

  it('renders compaction summaries as divider turns', () => {
    const turns = messagesToTurns(
      [
        message('s1', 'assistant', [{ type: 'text', text: 'summary' }], {
          metadata: { origin: { kind: 'compaction_summary' } },
        }),
      ],
      [],
      undefined,
      false,
      [],
    );

    expect(turns).toMatchObject([{ role: 'compaction', text: 'summary' }]);
  });

  it('suppresses an inline tool card for a live multi-member swarm', () => {
    const turns = messagesToTurns(
      [
        message('u1', 'user', [{ type: 'text', text: 'run a swarm' }]),
        message('a1', 'assistant', [
          { type: 'toolUse', toolCallId: 'swarm-1', toolName: 'AgentSwarm', input: {} },
        ]),
      ],
      [],
      undefined,
      true,
      [
        subagentTask('a-1', 'swarm-1', 1, 'working'),
        subagentTask('a-2', 'swarm-1', 2, 'queued'),
        subagentTask('a-3', 'swarm-1', 3, 'completed'),
      ],
    );

    const assistant = turns.at(-1);
    expect(assistant?.tools ?? []).not.toContainEqual(
      expect.objectContaining({ id: 'swarm-1' }),
    );
    expect(assistant?.blocks ?? []).not.toContainEqual(
      expect.objectContaining({ kind: 'agentGroup' }),
    );
  });

  it('renders a completed multi-member swarm inline as a tool card', () => {
    const turns = messagesToTurns(
      [
        message('u1', 'user', [{ type: 'text', text: 'run a swarm' }]),
        message('a1', 'assistant', [
          { type: 'toolUse', toolCallId: 'swarm-2', toolName: 'AgentSwarm', input: {} },
        ]),
        message('t1', 'tool', [{ type: 'toolResult', toolCallId: 'swarm-2', output: 'all done' }]),
      ],
      [],
      undefined,
      false,
      [
        subagentTask('b-1', 'swarm-2', 1, 'completed'),
        subagentTask('b-2', 'swarm-2', 2, 'completed'),
        subagentTask('b-3', 'swarm-2', 3, 'failed'),
      ],
    );

    const assistant = turns.at(-1);
    expect(assistant?.tools).toContainEqual(
      expect.objectContaining({ id: 'swarm-2', name: 'AgentSwarm', status: 'ok' }),
    );
    expect(assistant?.blocks ?? []).not.toContainEqual(
      expect.objectContaining({ kind: 'agentGroup' }),
    );
  });

  it('renders a single subagent spawn as a tool card, not an agent block', () => {
    const singleSubagent: AppTask = {
      id: 'sub-1',
      sessionId: 'session-1',
      kind: 'subagent',
      description: 'explore the repo',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
      parentToolCallId: 'agent-call-1',
      subagentPhase: 'completed',
      runInBackground: false,
    };
    const turns = messagesToTurns(
      [
        message('u1', 'user', [{ type: 'text', text: 'go explore' }]),
        message('a1', 'assistant', [
          {
            type: 'toolUse',
            toolCallId: 'agent-call-1',
            toolName: 'Agent',
            input: { description: 'explore the repo', prompt: 'list the top-level dirs' },
          },
        ]),
        message('t1', 'tool', [{ type: 'toolResult', toolCallId: 'agent-call-1', output: 'done' }]),
      ],
      [],
      undefined,
      false,
      [singleSubagent],
    );

    const assistant = turns.at(-1);
    // The spawning `Agent` call renders as a normal tool card (args + result)…
    expect(assistant?.tools).toContainEqual(
      expect.objectContaining({ id: 'agent-call-1', name: 'Agent', status: 'ok' }),
    );
    // …and never as an inline agent/agentGroup block (live progress moves to
    // the right-side panel).
    expect(assistant?.blocks ?? []).not.toContainEqual(expect.objectContaining({ kind: 'agent' }));
    expect(assistant?.blocks ?? []).not.toContainEqual(
      expect.objectContaining({ kind: 'agentGroup' }),
    );
  });
});

describe('latestTodos', () => {
  it('returns the newest todo write and ignores later read-only queries', () => {
    expect(
      latestTodos([
        message('a1', 'assistant', [
          {
            type: 'toolUse',
            toolCallId: 'todo-1',
            toolName: 'TodoWrite',
            input: { todos: [{ title: 'old', status: 'pending' }] },
          },
        ]),
        message('a2', 'assistant', [
          {
            type: 'toolUse',
            toolCallId: 'todo-2',
            toolName: 'TodoWrite',
            input: JSON.stringify({ todos: [{ content: 'new', status: 'completed' }] }),
          },
        ]),
        message('a3', 'assistant', [
          { type: 'toolUse', toolCallId: 'todo-3', toolName: 'TodoRead', input: {} },
        ]),
      ]),
    ).toEqual([{ title: 'new', status: 'done' }]);
  });
});
