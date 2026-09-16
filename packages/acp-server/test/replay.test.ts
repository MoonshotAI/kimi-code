import { describe, expect, it } from 'vitest';

import { projectHistoryToSessionUpdates } from '../src/replay';

import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { HistoryMessage } from '@moonshot-ai/agent-core-v2';

const SESSION_ID = 'session_test';

function kinds(updates: readonly SessionNotification[]): string[] {
  return updates.map((u) => u.update.sessionUpdate);
}

describe('projectHistoryToSessionUpdates', () => {
  it('returns an empty array for an empty history', () => {
    expect(projectHistoryToSessionUpdates(SESSION_ID, [])).toEqual([]);
  });

  it('projects a user text message to a user_message_chunk', () => {
    const messages: HistoryMessage[] = [
      { message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, meta: {} },
    ];
    const updates = projectHistoryToSessionUpdates(SESSION_ID, messages);
    expect(kinds(updates)).toEqual(['user_message_chunk']);
    expect(updates[0]?.update).toMatchObject({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'hi' },
    });
  });

  it('projects an assistant text + tool call and correlates the tool result', () => {
    const messages: HistoryMessage[] = [
      { message: { role: 'user', content: [{ type: 'text', text: 'read a.ts' }] }, meta: {} },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'reading' }],
          toolCalls: [{ type: 'function', id: 'c1', name: 'Read', arguments: '{"path":"a.ts"}' }],
        },
        meta: {},
      },
      {
        message: {
          role: 'tool',
          content: [{ type: 'text', text: 'file body' }],
          toolCallId: 'c1',
        },
        meta: {},
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
    const messages: HistoryMessage[] = [
      {
        message: {
          role: 'assistant',
          content: [],
          toolCalls: [{ type: 'function', id: 'c1', name: 'Bash', arguments: '{}' }],
        },
        meta: {},
      },
      {
        message: {
          role: 'tool',
          content: [{ type: 'text', text: 'boom' }],
          toolCallId: 'c1',
        },
        meta: { isError: true },
      },
    ];
    const updates = projectHistoryToSessionUpdates(SESSION_ID, messages);
    expect(updates.at(-1)?.update).toMatchObject({ status: 'failed' });
  });

  it('projects a think part to an agent_thought_chunk', () => {
    const messages: HistoryMessage[] = [
      {
        message: {
          role: 'assistant',
          content: [{ type: 'think', think: 'hmm' }],
          toolCalls: [],
        },
        meta: {},
      },
    ];
    const updates = projectHistoryToSessionUpdates(SESSION_ID, messages);
    expect(kinds(updates)).toEqual(['agent_thought_chunk']);
  });

  it('skips a tool message whose call was never issued in this slice', () => {
    const messages: HistoryMessage[] = [
      {
        message: {
          role: 'tool',
          content: [{ type: 'text', text: 'orphan' }],
          toolCallId: 'unknown',
        },
        meta: {},
      },
    ];
    expect(projectHistoryToSessionUpdates(SESSION_ID, messages)).toEqual([]);
  });

  it('increments the synthetic turnId per assistant message', () => {
    const messages: HistoryMessage[] = [
      {
        message: {
          role: 'assistant',
          content: [],
          toolCalls: [{ type: 'function', id: 'a', name: 'Read', arguments: '{}' }],
        },
        meta: {},
      },
      {
        message: {
          role: 'assistant',
          content: [],
          toolCalls: [{ type: 'function', id: 'b', name: 'Read', arguments: '{}' }],
        },
        meta: {},
      },
    ];
    const updates = projectHistoryToSessionUpdates(SESSION_ID, messages);
    const ids = updates
      .filter((u) => u.update.sessionUpdate === 'tool_call')
      .map((u) => (u.update as { toolCallId: string }).toolCallId);
    expect(ids).toEqual(['1:a', '2:b']);
  });
});
