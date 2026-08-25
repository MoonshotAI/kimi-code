import { describe, expect, it } from 'vitest';
import type { AppMessage, AppMessageContent } from '../src/api/types';
import { messagesToTurns } from '@moonshot-ai/app-core/client';
import { assistantRenderBlocks, splitAssistantFold } from '@moonshot-ai/app-components';

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
      { url: `file://${fileId}`, kind: 'video', fileId, orderHint: 0 },
      {
        kind: 'file',
        url: `file://${fileId}`,
        fileId,
        name: 'notes.txt',
        mediaType: 'text/plain',
        size: 12,
        orderHint: 1,
      },
      { url: `file://${fileId}`, kind: 'image', name: undefined, fileId, orderHint: 2 },
    ]);
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
