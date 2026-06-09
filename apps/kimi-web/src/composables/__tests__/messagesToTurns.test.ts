// apps/kimi-web/src/composables/__tests__/messagesToTurns.test.ts
import { describe, it, expect } from 'vitest';
import { messagesToTurns } from '../messagesToTurns';
import type { AppMessage, AppApprovalRequest } from '../../api/types';

function makeMsg(
  id: string,
  role: 'user' | 'assistant' | 'tool',
  promptId: string | undefined,
  content: AppMessage['content'],
): AppMessage {
  return {
    id,
    sessionId: 'ses_1',
    role,
    content,
    createdAt: new Date().toISOString(),
    promptId,
  };
}

describe('messagesToTurns', () => {
  it('user message → its own turn', () => {
    const msgs: AppMessage[] = [
      makeMsg('u1', 'user', 'pr_1', [{ type: 'text', text: 'hello' }]),
    ];
    const turns = messagesToTurns(msgs, []);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.role).toBe('user');
    expect(turns[0]!.text).toBe('hello');
    expect(turns[0]!.no).toBe(1);
  });

  it('two assistant messages with SAME promptId → ONE merged turn', () => {
    const msgs: AppMessage[] = [
      makeMsg('a1', 'assistant', 'pr_1', [
        { type: 'thinking', thinking: 'thinking text' },
        { type: 'toolUse', toolCallId: 'tc_1', toolName: 'read', input: { path: 'a.ts' } },
      ]),
      makeMsg('a2', 'assistant', 'pr_1', [
        { type: 'text', text: 'final answer' },
      ]),
    ];
    const turns = messagesToTurns(msgs, []);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.role).toBe('assistant');
    expect(turns[0]!.thinking).toBe('thinking text');
    expect(turns[0]!.text).toBe('final answer');
    expect(turns[0]!.tools).toHaveLength(1);
    expect(turns[0]!.tools![0]!.name).toBe('read');
  });

  it('duplicate assistant copies (same promptId, identical content, different ids) render once', () => {
    // The streamed copy + the persisted copy of the same reply both reach us with
    // the same promptId but different ids; the turn must show the text + tool once.
    const content: AppMessage['content'] = [
      { type: 'toolUse', toolCallId: 'tc_1', toolName: 'bash', input: { command: 'echo hi' } },
      { type: 'text', text: 'The exact output was hi.' },
    ];
    const msgs: AppMessage[] = [
      makeMsg('a_stream', 'assistant', 'pr_1', content),
      makeMsg('a_persisted', 'assistant', 'pr_1', content),
    ];
    const turns = messagesToTurns(msgs, []);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe('The exact output was hi.');
    expect(turns[0]!.tools).toHaveLength(1);
  });

  it('two assistant messages with DIFFERENT promptId → TWO turns', () => {
    const msgs: AppMessage[] = [
      makeMsg('a1', 'assistant', 'pr_1', [{ type: 'text', text: 'first' }]),
      makeMsg('a2', 'assistant', 'pr_2', [{ type: 'text', text: 'second' }]),
    ];
    const turns = messagesToTurns(msgs, []);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.text).toBe('first');
    expect(turns[1]!.text).toBe('second');
    expect(turns[0]!.no).toBe(1);
    expect(turns[1]!.no).toBe(2);
  });

  it('assistant messages with undefined promptId → NOT merged (one turn per message)', () => {
    const msgs: AppMessage[] = [
      makeMsg('a1', 'assistant', undefined, [{ type: 'text', text: 'first' }]),
      makeMsg('a2', 'assistant', undefined, [{ type: 'text', text: 'second' }]),
    ];
    const turns = messagesToTurns(msgs, []);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.text).toBe('first');
    expect(turns[1]!.text).toBe('second');
  });

  it('tool-role messages fold tool results into the preceding assistant group', () => {
    const msgs: AppMessage[] = [
      makeMsg('a1', 'assistant', 'pr_1', [
        { type: 'toolUse', toolCallId: 'tc_1', toolName: 'bash', input: { command: 'ls' } },
      ]),
      makeMsg('tool1', 'tool', 'pr_1', [
        { type: 'toolResult', toolCallId: 'tc_1', output: 'file.ts', isError: false },
      ]),
      makeMsg('a2', 'assistant', 'pr_1', [
        { type: 'text', text: 'done' },
      ]),
    ];
    const turns = messagesToTurns(msgs, []);
    const assistantTurns = turns.filter((t) => t.role === 'assistant');
    expect(assistantTurns).toHaveLength(1);
    expect(assistantTurns[0]!.tools).toHaveLength(1);
    expect(assistantTurns[0]!.tools![0]!.status).toBe('ok');
    expect(assistantTurns[0]!.text).toBe('done');
  });

  it('user message resets the group — assistant messages after user start a new turn', () => {
    const msgs: AppMessage[] = [
      makeMsg('a1', 'assistant', 'pr_1', [{ type: 'text', text: 'reply 1' }]),
      makeMsg('u1', 'user', 'pr_2', [{ type: 'text', text: 'followup' }]),
      makeMsg('a2', 'assistant', 'pr_2', [{ type: 'text', text: 'reply 2' }]),
    ];
    const turns = messagesToTurns(msgs, []);
    expect(turns).toHaveLength(3);
    expect(turns[0]!.role).toBe('assistant');
    expect(turns[1]!.role).toBe('user');
    expect(turns[2]!.role).toBe('assistant');
  });

  it('approval attaches to the tool within the grouped turn', () => {
    const approval: AppApprovalRequest = {
      approvalId: 'apv_1',
      sessionId: 'ses_1',
      toolCallId: 'tc_edit',
      toolName: 'edit',
      action: 'Edit file',
      display: { kind: 'generic', summary: 'edit a.ts' },
      expiresAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    const msgs: AppMessage[] = [
      makeMsg('a1', 'assistant', 'pr_1', [
        { type: 'toolUse', toolCallId: 'tc_edit', toolName: 'edit', input: {} },
      ]),
      makeMsg('a2', 'assistant', 'pr_1', [
        { type: 'text', text: 'waiting for approval' },
      ]),
    ];
    const turns = messagesToTurns(msgs, [approval]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.approval).toBeDefined();
    expect(turns[0]!.approvalId).toBe('apv_1');
  });

  it('system messages are skipped entirely', () => {
    const msgs: AppMessage[] = [
      { id: 'sys1', sessionId: 'ses_1', role: 'system', content: [{ type: 'text', text: 'system prompt' }], createdAt: '' },
      makeMsg('u1', 'user', 'pr_1', [{ type: 'text', text: 'hi' }]),
    ];
    const turns = messagesToTurns(msgs, []);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.role).toBe('user');
  });

  it('multiple thinking parts are concatenated with newline', () => {
    const msgs: AppMessage[] = [
      makeMsg('a1', 'assistant', 'pr_1', [{ type: 'thinking', thinking: 'part one' }]),
      makeMsg('a2', 'assistant', 'pr_1', [{ type: 'thinking', thinking: 'part two' }]),
    ];
    const turns = messagesToTurns(msgs, []);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.thinking).toBe('part one\npart two');
  });
});
