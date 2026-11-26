import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { projectHistoryToSessionUpdates, type ReplayContext } from '../src/replay';

import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { ContextMessage } from '@moonshot-ai/agent-core-v2';
import { userPromptSubmitHookPart } from '@moonshot-ai/agent-core-v2/agent/contextMemory/hookParts';

const SESSION_ID = 'session_test';

function kinds(updates: readonly SessionNotification[]): string[] {
  return updates.map((u) => u.update.sessionUpdate);
}

describe('projectHistoryToSessionUpdates', () => {
  it('returns an empty array for an empty history', () => {
    expect(projectHistoryToSessionUpdates(SESSION_ID, [])).toEqual([]);
  });

  it('projects a user text message to a user_message_chunk', () => {
    const messages: ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ];
    const updates = projectHistoryToSessionUpdates(SESSION_ID, messages);
    expect(kinds(updates)).toEqual(['user_message_chunk']);
    expect(updates[0]?.update).toMatchObject({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'hi' },
    });
  });

  it('projects an assistant text + tool call and correlates the tool result', () => {
    const messages: ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'read a.ts' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'reading' }],
        toolCalls: [{ type: 'function', id: 'c1', name: 'Read', arguments: '{"path":"a.ts"}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'file body' }],
        toolCallId: 'c1',
      },
    ];
    const updates = projectHistoryToSessionUpdates(SESSION_ID, messages);
    expect(kinds(updates)).toEqual([
      'user_message_chunk',
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
    ]);
    const create = updates[2]?.update;
    expect(create).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: '1:c1',
      status: 'in_progress',
    });
    const done = updates[3]?.update;
    expect(done).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: '1:c1',
      status: 'completed',
    });
  });

  it('marks an errored tool result as failed', () => {
    const messages: ContextMessage[] = [
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'c1', name: 'Bash', arguments: '{}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'boom' }],
        toolCallId: 'c1',
        isError: true,
      },
    ];
    const updates = projectHistoryToSessionUpdates(SESSION_ID, messages);
    expect(updates.at(-1)?.update).toMatchObject({ status: 'failed' });
  });

  it('projects a think part to an agent_thought_chunk', () => {
    const messages: ContextMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'think', think: 'hmm' }],
        toolCalls: [],
      },
    ];
    const updates = projectHistoryToSessionUpdates(SESSION_ID, messages);
    expect(kinds(updates)).toEqual(['agent_thought_chunk']);
  });

  it('skips a tool message whose call was never issued in this slice', () => {
    const messages: ContextMessage[] = [
      {
        role: 'tool',
        content: [{ type: 'text', text: 'orphan' }],
        toolCallId: 'unknown',
      },
    ];
    expect(projectHistoryToSessionUpdates(SESSION_ID, messages)).toEqual([]);
  });

  it('increments the synthetic turnId per assistant message', () => {
    const messages: ContextMessage[] = [
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'a', name: 'Read', arguments: '{}' }],
      },
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'b', name: 'Read', arguments: '{}' }],
      },
    ];
    const updates = projectHistoryToSessionUpdates(SESSION_ID, messages);
    const ids = updates
      .filter((u) => u.update.sessionUpdate === 'tool_call')
      .map((u) => (u.update as { toolCallId: string }).toolCallId);
    expect(ids).toEqual(['1:a', '2:b']);
  });
});

describe('projectHistoryToSessionUpdates replays what the user saw', () => {
  function userTexts(messages: readonly ContextMessage[], context?: ReplayContext): string[] {
    return projectHistoryToSessionUpdates(SESSION_ID, messages, context).flatMap((u) =>
      u.update.sessionUpdate === 'user_message_chunk' && u.update.content.type === 'text'
        ? [u.update.content.text]
        : [],
    );
  }

  function toolCall(messages: readonly ContextMessage[]): Record<string, unknown> {
    const update = projectHistoryToSessionUpdates(SESSION_ID, messages).find(
      (u) => u.update.sessionUpdate === 'tool_call',
    );
    if (update === undefined) throw new Error('no tool_call replayed');
    return update.update as unknown as Record<string, unknown>;
  }

  it('leaves out the reminders, summaries and notices the product put in the context', () => {
    const messages: ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Summarise the plan.' }], origin: { kind: 'user' } },
      {
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>Today is 2026-01-01.</system-reminder>' }],
        origin: { kind: 'injection', variant: 'date' },
      },
      { role: 'user', content: [{ type: 'text', text: 'Earlier turns, summarised.' }], origin: { kind: 'compaction_summary' } },
      { role: 'user', content: [{ type: 'text', text: 'A hook said hello.' }], origin: { kind: 'hook_result', event: 'Stop' } },
      { role: 'user', content: [{ type: 'text', text: 'Read the notes first.' }] },
    ];

    expect(userTexts(messages)).toEqual(['Summarise the plan.', 'Read the notes first.']);
  });

  it('keeps only the typed text of a prompt that carried hook output and a bundled skill', () => {
    const messages: ContextMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Full text of the review skill.' },
          { type: 'text', text: 'Fix the failing test.' },
          userPromptSubmitHookPart('<hook>extra context</hook>'),
        ],
        origin: { kind: 'user', skillActivations: [{ activationId: 'a1', skillName: 'review' }] },
      },
    ];

    expect(userTexts(messages)).toEqual(['Fix the failing test.']);
  });

  it('shows a slash skill or plugin command as the command the user typed', () => {
    const messages: ContextMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Full text of the review skill.' }],
        origin: { kind: 'skill_activation', activationId: 's1', skillName: 'review', skillArgs: 'src/a.ts', skillSource: 'project', trigger: 'user-slash' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Full text of the init skill.' }],
        origin: { kind: 'skill_activation', activationId: 's2', skillName: 'init', skillSource: 'builtin', trigger: 'user-slash' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Full text of a skill the model chose.' }],
        origin: { kind: 'skill_activation', activationId: 's3', skillName: 'lint', trigger: 'model-tool' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Full text of the deploy command.' }],
        origin: { kind: 'plugin_command', activationId: 'p1', pluginId: 'acme', commandName: 'deploy', commandArgs: 'prod', trigger: 'user-slash' },
      },
    ];

    expect(userTexts(messages)).toEqual(['/skill:review src/a.ts', '/init', '/acme:deploy prod']);
  });

  it('keeps the text the user attached to a slash skill after the command', () => {
    const messages: ContextMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Full text of the review skill.' },
          { type: 'text', text: 'and check the tests' },
          userPromptSubmitHookPart('<hook>extra context</hook>'),
        ],
        origin: { kind: 'skill_activation', activationId: 's1', skillName: 'review', skillArgs: 'src/a.ts', skillSource: 'project', trigger: 'user-slash' },
      },
    ];

    expect(userTexts(messages)).toEqual(['/skill:review src/a.ts and check the tests']);
  });

  it('shows a sub-skill with the command name the session advertises for it', () => {
    const messages: ContextMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Full text of the child skill.' }],
        origin: { kind: 'skill_activation', activationId: 's1', skillName: 'bundle.child', skillArgs: 'src', skillSource: 'user', trigger: 'user-slash' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Full text of the project review skill.' }],
        origin: { kind: 'skill_activation', activationId: 's2', skillName: 'review', skillSource: 'project', trigger: 'user-slash' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Full text of a skill that is gone.' }],
        origin: { kind: 'skill_activation', activationId: 's3', skillName: 'gone', skillSource: 'project', trigger: 'user-slash' },
      },
    ];
    const skillCommandMap = new Map([
      ['review', 'review'],
      ['bundle.child', 'bundle.child'],
      ['skill:review', 'review'],
    ]);

    expect(userTexts(messages, { skillCommandMap })).toEqual(['/bundle.child src', '/skill:review', '/skill:gone']);
  });

  it('shows a shell command the user ran, then its output, as the terminal UI does', () => {
    const messages: ContextMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: '<bash-input>\ngrep -n &quot;a &amp; b&quot; notes.txt\n</bash-input>' }],
        origin: { kind: 'shell_command', phase: 'input' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '<bash-stdout>1:a &amp; b &lt;ok&gt;\n</bash-stdout><bash-stderr></bash-stderr>' }],
        origin: { kind: 'shell_command', phase: 'output' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '<bash-input>\ntouch done\n</bash-input>' }],
        origin: { kind: 'shell_command', phase: 'input' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '<bash-stdout></bash-stdout><bash-stderr></bash-stderr>' }],
        origin: { kind: 'shell_command', phase: 'output' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '<bash-input>\ncat README.md\n</bash-input>' }],
        origin: { kind: 'shell_command', phase: 'input' },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '<bash-stdout>```sh\nls\n```\n</bash-stdout><bash-stderr>cat: warning\n</bash-stderr>' }],
        origin: { kind: 'shell_command', phase: 'output', isError: true },
      },
      { role: 'user', content: [{ type: 'text', text: 'What changed?' }], origin: { kind: 'user' } },
    ];

    expect(userTexts(messages)).toEqual([
      '$ grep -n "a & b" notes.txt\n\n',
      '```\n1:a & b <ok>\n```\n\n',
      '$ touch done\n\n',
      '$ cat README.md\n\n',
      '````\n```sh\nls\n```\ncat: warning\n````\n\n',
      'What changed?',
    ]);
  });

  it('locates a file tool call by resolving its recorded path against the session directory', () => {
    const messages: ContextMessage[] = [
      {
        role: 'assistant',
        content: [],
        toolCalls: [
          { type: 'function', id: 'r1', name: 'Read', arguments: '{"path":"notes/a.txt"}' },
          { type: 'function', id: 'r2', name: 'Read', arguments: '{"path":"/elsewhere/b.txt"}' },
          { type: 'function', id: 'b1', name: 'Bash', arguments: '{"command":"cat notes/a.txt"}' },
          { type: 'function', id: 'r3', name: 'Read', arguments: '{"path":"~/notes/c.txt"}' },
        ],
      },
    ];
    const locations = (cwd?: string) =>
      projectHistoryToSessionUpdates(SESSION_ID, messages, { cwd })
        .filter((u) => u.update.sessionUpdate === 'tool_call')
        .map((u) => (u.update as { locations?: unknown }).locations);

    const cwd = resolve('/work');
    expect(locations(cwd)).toEqual([[{ path: resolve(cwd, 'notes/a.txt') }], [{ path: '/elsewhere/b.txt' }], undefined, undefined]);
    expect(locations()).toEqual([undefined, [{ path: '/elsewhere/b.txt' }], undefined, undefined]);
  });

  it('locates a file tool call from the display it recorded, as the live card does', () => {
    const read: ContextMessage[] = [
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'r1', name: 'Read', arguments: '{"path":"a.txt"}' }],
        toolCallDisplays: { r1: { kind: 'file_io', operation: 'read', path: '/work/a.txt' } },
      },
    ];
    const edit: ContextMessage[] = [
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'e1', name: 'Edit', arguments: '{"path":"a.txt","old_string":"a","new_string":"b"}' }],
        toolCallDisplays: { e1: { kind: 'diff', path: '/work/a.txt', before: 'a', after: 'b' } },
      },
    ];

    expect(toolCall(read)).toMatchObject({ locations: [{ path: '/work/a.txt' }] });
    expect(toolCall(edit)).toMatchObject({
      locations: [{ path: '/work/a.txt' }],
      content: expect.arrayContaining([expect.objectContaining({ type: 'diff', path: '/work/a.txt', oldText: 'a', newText: 'b' })]),
    });
  });
});
