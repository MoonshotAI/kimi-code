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

describe('messagesToTurns skill activation', () => {
  /** The user message a Skill tool call injects with the loaded skill body. */
  function toolSkillMessage(id: string, trigger = 'model-tool'): AppMessage {
    return message(id, 'user', [{ type: 'text', text: '<kimi-skill-loaded skill="kimi-webbridge">\n…' }], {
      metadata: {
        origin: { kind: 'skill_activation', skillName: 'kimi-webbridge', trigger },
      },
    });
  }

  it('does not split the assistant turn on a Skill tool call', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [
          { type: 'toolUse', toolCallId: 'tool-1', toolName: 'bash', input: { command: 'ls' } },
        ]),
        message('t1', 'tool', [{ type: 'toolResult', toolCallId: 'tool-1', output: 'x' }]),
        message('a2', 'assistant', [
          { type: 'toolUse', toolCallId: 'tool-2', toolName: 'Skill', input: { skill: 'kimi-webbridge' } },
        ]),
        toolSkillMessage('sk-1'),
        message('t2', 'tool', [
          { type: 'toolResult', toolCallId: 'tool-2', output: 'Skill "kimi-webbridge" loaded inline.' },
        ]),
        message('a3', 'assistant', [{ type: 'text', text: 'done' }]),
      ],
      [],
      undefined,
      false,
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]?.tools?.map((t) => t.id)).toEqual(['tool-1', 'tool-2']);
    // The Skill call folds with the rest of the activity behind ONE fold row.
    const { folded, visible } = splitAssistantFold(turns[0]!);
    expect(folded.map((b) => b.kind)).toEqual(['activity-run']);
    expect(visible.map((b) => b.kind)).toEqual(['text']);
  });

  it('treats a nested-skill activation the same way', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [
          { type: 'toolUse', toolCallId: 'tool-1', toolName: 'Skill', input: { skill: 'a' } },
        ]),
        toolSkillMessage('sk-1', 'nested-skill'),
        message('t1', 'tool', [{ type: 'toolResult', toolCallId: 'tool-1', output: 'ok' }]),
        message('a2', 'assistant', [{ type: 'text', text: 'done' }]),
      ],
      [],
      undefined,
      false,
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]?.tools?.map((t) => t.id)).toEqual(['tool-1']);
  });

  it('keeps a user-slash skill activation as a user-turn boundary', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [{ type: 'text', text: 'one' }]),
        toolSkillMessage('sk-1', 'user-slash'),
        message('a2', 'assistant', [{ type: 'text', text: 'two' }]),
      ],
      [],
      undefined,
      false,
    );
    expect(turns.map((t) => t.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(turns[1]?.skillActivation).toEqual({ name: 'kimi-webbridge', args: undefined });
  });

  it('recovers attachment chips on a user-slash activation and surfaces args once', () => {
    // A skill activation carrying uploads: the daemon appends the resolved
    // attachment parts after the rendered skill-prompt text part on the same
    // user message. After a reload, media come back as `<video|image path>…`
    // tags and other files as "Attached file …" notices — same as plain prompts.
    const fileId = 'f_0aa63f2e-9e03-4e4d-b191-245d15e0ba61';
    const turns = messagesToTurns(
      [
        message(
          'sk-1',
          'user',
          [
            { type: 'text', text: '<kimi-skill-loaded skill="kimi-webbridge">\n…' },
            { type: 'text', text: `<video path="/cache/${fileId}.mp4"></video>` },
            {
              type: 'text',
              text: `Attached file "notes.txt" (text/plain, 12 bytes): /sess/attachments/${fileId}-notes.txt — open it with the Read tool`,
            },
            { type: 'image', source: { kind: 'file', fileId } },
          ],
          {
            metadata: {
              origin: {
                kind: 'skill_activation',
                skillName: 'kimi-webbridge',
                skillArgs: 'fix it',
                trigger: 'user-slash',
              },
            },
          },
        ),
      ],
      [],
      (id) => `file://${id}`,
      false,
    );
    expect(turns).toHaveLength(1);
    const turn = turns[0]!;
    // The args show once — not once per text part.
    expect(turn.text).toBe('fix it');
    expect(turn.skillActivation).toEqual({ name: 'kimi-webbridge', args: 'fix it' });
    expect(turn.attachments).toEqual([
      { url: `file://${fileId}`, kind: 'video', fileId },
      {
        kind: 'file',
        url: `file://${fileId}`,
        fileId,
        name: 'notes.txt',
        mediaType: 'text/plain',
        size: 12,
      },
      { url: `file://${fileId}`, kind: 'image', name: undefined, fileId },
    ]);
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

describe('messagesToTurns goal continuation', () => {
  function goalTrigger(id: string): AppMessage {
    return message(id, 'user', [{ type: 'text', text: 'Continue working toward the active goal…' }], {
      metadata: { origin: { kind: 'system_trigger', name: 'goal_continuation' } },
    });
  }

  it('marks the turn a goal continuation opens, keeping the boundary and hiding the prompt', () => {
    const turns = messagesToTurns(
      [
        message('a1', 'assistant', [{ type: 'text', text: 'one' }]),
        goalTrigger('g1'),
        message('a2', 'assistant', [{ type: 'text', text: 'two' }]),
      ],
      [],
      undefined,
      false,
    );
    expect(turns.map((t) => t.role)).toEqual(['assistant', 'assistant']);
    expect(turns[0]?.goalContinuation).toBeUndefined();
    expect(turns[1]?.goalContinuation).toBe(true);
    // The long machine prompt never leaks into the visible text.
    expect(turns[1]?.text).toBe('two');
  });

  it('marks a turn opened by a continuation at the transcript start', () => {
    const turns = messagesToTurns(
      [goalTrigger('g1'), message('a1', 'assistant', [{ type: 'text', text: 'working' }])],
      [],
      undefined,
      false,
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]?.goalContinuation).toBe(true);
  });

  it('does not mark turns opened by other system triggers', () => {
    const turns = messagesToTurns(
      [
        goalTrigger('g-other'),
        message('a1', 'assistant', [{ type: 'text', text: 'one' }]),
        message('g2', 'user', [{ type: 'text', text: 'x' }], {
          metadata: { origin: { kind: 'system_trigger', name: 'other_trigger' } },
        }),
        message('a2', 'assistant', [{ type: 'text', text: 'two' }]),
      ],
      [],
      undefined,
      false,
    );
    expect(turns[0]?.goalContinuation).toBe(true);
    expect(turns[1]?.goalContinuation).toBeUndefined();
  });

  it('clears the pending marker when a real user message supersedes it', () => {
    const turns = messagesToTurns(
      [
        goalTrigger('g1'),
        message('u1', 'user', [{ type: 'text', text: 'stop, do this instead' }]),
        message('a1', 'assistant', [{ type: 'text', text: 'ok' }]),
      ],
      [],
      undefined,
      false,
    );
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns[1]?.goalContinuation).toBeUndefined();
  });

  it('clears the pending marker on a later hidden non-goal boundary', () => {
    const turns = messagesToTurns(
      [
        goalTrigger('g1'),
        message('h1', 'user', [{ type: 'text', text: 'hook output' }], {
          metadata: { origin: { kind: 'hook_result' } },
        }),
        message('a1', 'assistant', [{ type: 'text', text: 'one' }]),
      ],
      [],
      undefined,
      false,
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]?.goalContinuation).toBeUndefined();
  });

  it('marks the turn a continuation opens even when a task notification lands first', () => {
    const turns = messagesToTurns(
      [
        goalTrigger('g1'),
        taskNtf('ntf-1', NTF_COMPLETED),
        message('a1', 'assistant', [{ type: 'text', text: 'noted' }]),
      ],
      [],
      undefined,
      false,
    );
    expect(turns).toHaveLength(1);
    expect(turns[0]?.goalContinuation).toBe(true);
    expect(turns[0]?.blocks?.some((b) => b.kind === 'notification')).toBe(true);
  });

  it('seeds a trailing continuation as an empty marked turn at the tail (the undo-guard window)', () => {
    const turns = messagesToTurns(
      [message('a1', 'assistant', [{ type: 'text', text: 'one' }]), goalTrigger('g1')],
      [],
      undefined,
      false,
    );
    // The seeded turn enters the transcript immediately, so the
    // goalContinuation guard (Esc undo / edit-and-resend) applies during the
    // window before its first assistant block arrives.
    expect(turns).toHaveLength(2);
    expect(turns[1]?.goalContinuation).toBe(true);
    expect(turns[1]?.blocks).toBeUndefined();
    expect(turns[1]?.text).toBe('');
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
