import { describe, expect, it } from 'vitest';
import type { AppMessage, AppMessageContent } from '../../src/renderer/api/types';
import { messagesToTurns } from '../../src/renderer/composables/messagesToTurns';
import { assistantRenderBlocks, splitAssistantFold } from '../../src/renderer/components/chatTurnRendering';

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

/** A hidden task-notification injection carrying real `<notification>` XML. */
/** A hidden task-notification injection carrying real `<notification>` XML,
    with the origin shape the daemon actually persists (kind 'task'). */
function taskNtf(id: string, xml: string, kind = 'task'): AppMessage {
  return message(id, 'user', [{ type: 'text', text: xml }], {
    metadata: {
      origin: { kind, taskId: 'bash-1', status: 'completed', notificationId: 'task:bash-1:completed' },
    },
  });
}

const NTF_COMPLETED = `<notification id="task:bash-1:completed" category="task" type="task.completed" source_kind="background_task" source_id="bash-1">
Title: desktop dev
Severity: info
Background process completed.
</notification>`;

const NTF_FAILED = `<notification id="task:bash-2:failed" category="task" type="task.failed" source_kind="background_task" source_id="bash-2">
Title: pnpm build
Severity: error
Background process failed with exit code 1.
</notification>`;

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

describe('messagesToTurns task notifications', () => {
  it('renders a mid-turn notification as a block without splitting the turn', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [
          { type: 'toolUse', toolCallId: 'tool-1', toolName: 'bash', input: { command: 'ls' } },
        ]),
        message('t1', 'tool', [{ type: 'toolResult', toolCallId: 'tool-1', output: 'x' }]),
        taskNtf('ntf-1', NTF_COMPLETED),
        message('a2', 'assistant', [{ type: 'text', text: 'server is up' }]),
      ],
      [],
      undefined,
      false,
    );
    expect(turns).toHaveLength(1);
    const rendered = assistantRenderBlocks(turns[0]!);
    expect(rendered.map((b) => b.kind)).toEqual(['tool', 'notification', 'text']);
    expect(rendered[1]).toMatchObject({
      kind: 'notification',
      items: [{ id: 'task:bash-1:completed', title: 'desktop dev', createdAt: '2026-01-01T00:00:00.000Z' }],
    });
  });

  it('merges consecutive notifications (one message or several) into one group block', () => {
    const turns = messagesToTurns(
      [
        taskNtf('ntf-1', `${NTF_COMPLETED}\n\n${NTF_FAILED}`),
        taskNtf('ntf-2', NTF_COMPLETED.replace('bash-1', 'bash-3')),
        message('a1', 'assistant', [{ type: 'text', text: 'both noted' }]),
      ],
      [],
      undefined,
      false,
    );
    // The notifications open ONE turn; the assistant reply merges into it.
    expect(turns).toHaveLength(1);
    expect(turns[0]?.role).toBe('assistant');
    const rendered = assistantRenderBlocks(turns[0]!);
    expect(rendered.map((b) => b.kind)).toEqual(['notification', 'text']);
    if (rendered[0]?.kind === 'notification') {
      expect(rendered[0].items.map((n) => n.id)).toEqual([
        'task:bash-1:completed',
        'task:bash-2:failed',
        'task:bash-3:completed',
      ]);
    }
  });

  it('attaches a trailing notification to the open turn (still no boundary)', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [{ type: 'text', text: 'working' }]),
        taskNtf('ntf-1', NTF_FAILED),
      ],
      [],
      undefined,
      false,
    );
    expect(turns).toHaveLength(1);
    const { folded, visible } = splitAssistantFold(turns[0]!);
    expect(visible.map((b) => b.kind)).toEqual(['text', 'notification']);
    expect(folded).toEqual([]);
  });

  it('renders a lone notification turn without a fold row', () => {
    const turns = messagesToTurns([taskNtf('ntf-1', NTF_FAILED)], [], undefined, false);
    expect(turns.map((t) => t.role)).toEqual(['assistant']);
    const { folded, visible } = splitAssistantFold(turns[0]!);
    expect(folded).toEqual([]);
    expect(visible.map((b) => b.kind)).toEqual(['notification']);
  });

  it('keeps notification text with no well-formed block hidden (old behaviour)', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [{ type: 'text', text: 'one' }]),
        taskNtf('ntf-1', '<notification id="broken">unclosed'),
        message('a2', 'assistant', [{ type: 'text', text: 'two' }]),
      ],
      [],
      undefined,
      false,
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]?.blocks?.some((b) => b.kind === 'notification')).toBe(false);
  });

  it('accepts the legacy origin spellings too', () => {
    for (const kind of ['task_notification', 'background_task']) {
      const turns = messagesToTurns(
        [taskNtf('ntf-1', NTF_COMPLETED, kind), message('a1', 'assistant', [{ type: 'text', text: 'ok' }])],
        [],
        undefined,
        false,
      );
      expect(turns[0]?.blocks?.some((b) => b.kind === 'notification')).toBe(true);
    }
  });
});

describe('messagesToTurns turn stamps', () => {
  it('leaves endedAt undefined for a single-message turn (no Worked-0s span)', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [
          { type: 'thinking', thinking: 'plan' },
          { type: 'text', text: 'answer' },
        ]),
      ],
      [],
      undefined,
      false,
    );
    expect(turns[0]?.endedAt).toBeUndefined();
  });

  it('stamps endedAt from a later tool-result message', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [
          { type: 'toolUse', toolCallId: 'tool-1', toolName: 'bash', input: { command: 'ls' } },
        ]),
        message('t1', 'tool', [{ type: 'toolResult', toolCallId: 'tool-1', output: 'x' }], {
          createdAt: '2026-01-01T00:00:30.000Z',
        }),
      ],
      [],
      undefined,
      false,
    );
    expect(turns[0]?.endedAt).toBe('2026-01-01T00:00:30.000Z');
  });

  it('stamps endedAt from the last assistant message of a multi-message turn', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [{ type: 'thinking', thinking: 'plan' }]),
        message('a2', 'assistant', [{ type: 'text', text: 'answer' }], {
          createdAt: '2026-01-01T00:00:42.000Z',
        }),
      ],
      [],
      undefined,
      false,
    );
    expect(turns[0]?.endedAt).toBe('2026-01-01T00:00:42.000Z');
  });
});
