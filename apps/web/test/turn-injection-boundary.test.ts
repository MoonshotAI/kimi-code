import { describe, expect, it } from 'vitest';
import type { AppMessage, AppMessageContent } from '../src/api/types';
import { messagesToTurns } from '../src/composables/messagesToTurns';
import { assistantRenderBlocks } from '../src/components/chatTurnRendering';

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

/** A hidden system injection (todo-list reminder / task notification). */
function injection(id: string, kind = 'injection'): AppMessage {
  return message(id, 'user', [{ type: 'text', text: '<system-reminder>\nThe TodoList…' }], {
    metadata: { origin: { kind, variant: 'todo_list_reminder' } },
  });
}

// Hidden user-role injections land mid-turn between assistant messages. They
// are not rendered (isDisplayableUserMessage hides them) and must NOT split
// the pending assistant group either — one agent turn renders as ONE chat
// turn, so a continuous activity stream folds into a single row.
describe('messagesToTurns hidden injections', () => {
  it('does not split the assistant turn on a mid-turn injection', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [
          { type: 'thinking', thinking: 'plan' },
          { type: 'toolUse', toolCallId: 'tool-1', toolName: 'bash', input: { command: 'ls' } },
        ]),
        message('t1', 'tool', [{ type: 'toolResult', toolCallId: 'tool-1', output: 'x' }]),
        injection('inj-1'),
        message('a2', 'assistant', [
          { type: 'toolUse', toolCallId: 'tool-2', toolName: 'bash', input: { command: 'pwd' } },
        ]),
        message('t2', 'tool', [{ type: 'toolResult', toolCallId: 'tool-2', output: 'y' }]),
      ],
      [],
      undefined,
      false,
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]?.tools?.map((t) => t.id)).toEqual(['tool-1', 'tool-2']);
    // …and the whole stream folds into ONE activity run, not one row per side
    // of the injection.
    const rendered = assistantRenderBlocks(turns[0]!);
    expect(rendered.map((b) => b.kind)).toEqual(['activity-run']);
  });

  it('does not split on a task-notification either', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [
          { type: 'toolUse', toolCallId: 'tool-1', toolName: 'bash', input: { command: 'ls' } },
        ]),
        message('t1', 'tool', [{ type: 'toolResult', toolCallId: 'tool-1', output: 'x' }]),
        injection('inj-1', 'task_notification'),
        message('a2', 'assistant', [
          { type: 'toolUse', toolCallId: 'tool-2', toolName: 'bash', input: { command: 'pwd' } },
        ]),
        message('t2', 'tool', [{ type: 'toolResult', toolCallId: 'tool-2', output: 'y' }]),
      ],
      [],
      undefined,
      false,
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]?.tools?.map((t) => t.id)).toEqual(['tool-1', 'tool-2']);
  });

  it('keeps the boundary for other hidden user messages (hook results, retries…)', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [{ type: 'text', text: 'one' }]),
        message('h1', 'user', [{ type: 'text', text: 'hook output' }], {
          metadata: { origin: { kind: 'hook_result' } },
        }),
        message('a2', 'assistant', [{ type: 'text', text: 'two' }]),
      ],
      [],
      undefined,
      false,
    );
    expect(turns.map((t) => t.role)).toEqual(['assistant', 'assistant']);
  });

  it('still splits the turn on a real user message', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [{ type: 'text', text: 'one' }]),
        message('u1', 'user', [{ type: 'text', text: 'next' }]),
        message('a2', 'assistant', [{ type: 'text', text: 'two' }]),
      ],
      [],
      undefined,
      false,
    );
    expect(turns.map((t) => t.role)).toEqual(['assistant', 'user', 'assistant']);
  });

  it('keeps cron injections as turn boundaries rendering their own notice', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [{ type: 'text', text: 'before' }]),
        message('c1', 'user', [{ type: 'text', text: 'check the deploy' }], {
          metadata: { origin: { kind: 'cron_job', jobId: 'job-1', cron: '0 9 * * *' } },
        }),
        message('a2', 'assistant', [{ type: 'text', text: 'after' }]),
      ],
      [],
      undefined,
      false,
    );
    expect(turns.map((t) => t.role)).toEqual(['assistant', 'cron', 'assistant']);
  });
});
