import { describe, expect, it } from 'vitest';
import type { AppMessage, AppMessageContent } from '../src/api/types';
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
    );

    expect(turns).toMatchObject([{ role: 'compaction', text: 'summary' }]);
  });

  it('renders a live multi-member swarm inline as a tool card', () => {
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
    );

    const assistant = turns.at(-1);
    expect(assistant?.tools).toContainEqual(
      expect.objectContaining({ id: 'swarm-1', name: 'AgentSwarm', status: 'running' }),
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

  it('renders a `<video path>` text tag as a video attachment, not raw text', () => {
    const fileId = 'f_01KWK39A0ZC8R2ATZEQMD8716C';
    const turns = messagesToTurns(
      [
        message('u1', 'user', [
          { type: 'text', text: 'look at this' },
          {
            type: 'text',
            text: `<video path="/Users/me/.kimi-code/cache/${fileId}.mp4"></video>`,
          },
        ]),
      ],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ role: 'user', text: 'look at this' });
    expect(turns[0]?.images).toEqual([
      { url: `/api/v1/files/${fileId}`, kind: 'video', alt: fileId, fileId },
    ]);
  });

  it('keeps the video tag as text when no file resolver is provided', () => {
    const tag =
      '<video path="/Users/me/.kimi-code/cache/f_01KWK39A0ZC8R2ATZEQMD8716C.mp4"></video>';
    const turns = messagesToTurns(
      [message('u1', 'user', [{ type: 'text', text: tag }])],
      [],
      undefined,
      false,
    );

    expect(turns[0]).toMatchObject({ role: 'user', text: tag });
    expect(turns[0]?.images).toBeUndefined();
  });

  it('leaves non-file-store media paths as text instead of fabricating a url', () => {
    // TUI/legacy cache names are not shaped like a file-store id (`f_…`), so the
    // tag must stay as text rather than becoming a broken /files/<name> request.
    const tag =
      '<video path="/tmp/550e8400-e29b-41d4-a716-446655440000-clip.mp4"></video>';
    const turns = messagesToTurns(
      [message('u1', 'user', [{ type: 'text', text: tag }])],
      [],
      (id) => `/api/v1/files/${id}`,
      false,
    );

    expect(turns[0]).toMatchObject({ role: 'user', text: tag });
    expect(turns[0]?.images).toBeUndefined();
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
