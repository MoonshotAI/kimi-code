import { describe, expect, it } from 'vitest';
import { messagesToTurns } from '../src/composables/messagesToTurns';
import type { AppMessage } from '../src/api/types';

const now = '2026-06-11T00:00:00.000Z';

// An assistant turn whose final tool call never received a matching toolResult
// (a result frame dropped on a reconnect / ordering race). The tool is the last
// thing in the conversation, so it lands in the FINAL group.
function messagesWithDanglingTool(): AppMessage[] {
  return [
    {
      id: 'a1',
      sessionId: 's1',
      role: 'assistant',
      promptId: 'pr_1',
      createdAt: now,
      content: [
        { type: 'text', text: 'reading the file' },
        { type: 'toolUse', toolCallId: 'tc_1', toolName: 'read_file', input: { path: 'a.ts' } },
      ],
    },
  ];
}

describe('dangling tool spinner', () => {
  it('keeps the final tool spinning while the session is active', () => {
    const turns = messagesToTurns(messagesWithDanglingTool(), [], undefined, true);
    const tool = turns.at(-1)!.tools![0]!;
    expect(tool.status).toBe('running');
  });

  it('settles the final tool once the session is idle', () => {
    const turns = messagesToTurns(messagesWithDanglingTool(), [], undefined, false);
    const tool = turns.at(-1)!.tools![0]!;
    expect(tool.status).toBe('ok');
  });

  it('still resolves a tool that did get its result, regardless of activity', () => {
    const msgs: AppMessage[] = [
      ...messagesWithDanglingTool(),
      {
        id: 't1',
        sessionId: 's1',
        role: 'tool',
        promptId: 'pr_1',
        createdAt: now,
        content: [{ type: 'toolResult', toolCallId: 'tc_1', output: 'done', isError: false }],
      },
    ];
    const turns = messagesToTurns(msgs, [], undefined, true);
    expect(turns.at(-1)!.tools![0]!.status).toBe('ok');
  });
});
