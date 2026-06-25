import { describe, expect, it } from 'vitest';

import { project, trimTrailingOpenToolExchange } from '../../../src/agent/context/projector';
import type { ContextMessage } from '../../../src/agent/context/types';

// Unit tests for how the projector normalizes tool exchanges: results are
// pulled up right after their call, messages that landed between a call and its
// results are deferred to after the exchange, unanswered calls are closed with
// a synthetic error result, stale duplicate results are dropped, and orphan
// results are dropped in a real projection (but kept in a bare slice).

const INTERRUPTED = 'Tool execution was interrupted before its result was recorded';

function user(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' } };
}

function reminder(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>` }],
    toolCalls: [],
    origin: { kind: 'injection', variant: 'host' },
  };
}

function assistant(text: string, toolCallIds: readonly string[] = []): ContextMessage {
  return {
    role: 'assistant',
    content: text === '' ? [] : [{ type: 'text', text }],
    toolCalls: toolCallIds.map((id) => ({ type: 'function', id, name: 'Lookup', arguments: '{}' })),
  };
}

function toolResult(toolCallId: string, text: string): ContextMessage {
  return { role: 'tool', content: [{ type: 'text', text }], toolCalls: [], toolCallId };
}

function shape(history: readonly ContextMessage[]): string[] {
  return project(history).map((message) =>
    message.role === 'tool' ? `tool:${message.toolCallId}` : message.role,
  );
}

describe('projector tool-exchange normalization', () => {
  it('leaves a fully resolved exchange untouched', () => {
    const history = [user('go'), assistant('', ['c1']), toolResult('c1', 'one'), user('next')];
    expect(shape(history)).toEqual(['user', 'assistant', 'tool:c1', 'user']);
    expect(project(history)).toHaveLength(4);
  });

  it('synthesizes a result for a trailing unanswered call', () => {
    const projected = project([user('go'), assistant('', ['c1', 'c2']), toolResult('c1', 'one')]);
    expect(shape([user('go'), assistant('', ['c1', 'c2']), toolResult('c1', 'one')])).toEqual([
      'user',
      'assistant',
      'tool:c1',
      'tool:c2',
    ]);
    const synthetic = projected.at(-1);
    expect(synthetic).toMatchObject({ role: 'tool', toolCallId: 'c2' });
    expect((synthetic?.content[0] as { text: string }).text).toContain(INTERRUPTED);
  });

  it('synthesizes every open call of a multi-call step in tool-call order', () => {
    expect(shape([user('go'), assistant('', ['a', 'b', 'c'])])).toEqual([
      'user',
      'assistant',
      'tool:a',
      'tool:b',
      'tool:c',
    ]);
  });

  it('pulls a real result up and defers a reminder that landed inside the exchange', () => {
    const history = [
      assistant('', ['c1', 'c2']),
      reminder('host note'),
      toolResult('c1', 'one'),
      toolResult('c2', 'two'),
    ];
    expect(shape(history)).toEqual(['assistant', 'tool:c1', 'tool:c2', 'user']);
    const projected = project(history);
    expect((projected.at(-1)?.content[0] as { text: string }).text).toContain('host note');
  });

  it('keeps the real result and synthesizes only the still-open call', () => {
    const history = [
      assistant('', ['done', 'open']),
      toolResult('done', 'real result'),
      assistant('All done.'),
    ];
    const projected = project(history);
    expect(shape(history)).toEqual(['assistant', 'tool:done', 'tool:open', 'assistant']);
    expect((projected[1]?.content[0] as { text: string }).text).toBe('real result');
    expect((projected[2]?.content[0] as { text: string }).text).toContain(INTERRUPTED);
  });

  it('closes an interrupted mid-history call before the next turn', () => {
    const history = [
      user('go'),
      assistant('', ['c1']),
      user('keep going'),
      assistant('All done.'),
    ];
    expect(shape(history)).toEqual(['user', 'assistant', 'tool:c1', 'user', 'assistant']);
  });

  it('closes consecutive interrupted steps each at their own boundary', () => {
    const history = [
      user('go'),
      assistant('', ['one']),
      assistant('', ['two']),
      assistant('Done.'),
    ];
    expect(shape(history)).toEqual([
      'user',
      'assistant',
      'tool:one',
      'assistant',
      'tool:two',
      'assistant',
    ]);
  });

  it('drops a stale duplicate result for an already-answered call', () => {
    // The call is closed (synthetically) when the next assistant turn starts;
    // the trailing duplicate result for the same call is dropped.
    const history = [
      user('go'),
      assistant('', ['c1']),
      user('keep going'),
      assistant('All done.'),
      toolResult('c1', 'late duplicate'),
    ];
    expect(shape(history)).toEqual(['user', 'assistant', 'tool:c1', 'user', 'assistant']);
  });

  it('matches results across exchanges that reuse the same tool-call id', () => {
    const history = [
      assistant('', ['call']),
      toolResult('call', 'first'),
      assistant('', ['call']),
      toolResult('call', 'second'),
    ];
    const projected = project(history);
    expect(shape(history)).toEqual(['assistant', 'tool:call', 'assistant', 'tool:call']);
    expect((projected[1]?.content[0] as { text: string }).text).toBe('first');
    expect((projected[3]?.content[0] as { text: string }).text).toBe('second');
  });

  it('drops an orphan result whose call was never recorded', () => {
    const history = [user('hi'), assistant('hello'), toolResult('ghost', 'orphaned')];
    expect(shape(history)).toEqual(['user', 'assistant']);
  });

  it('keeps a bare result slice with no preceding assistant (used for sizing)', () => {
    // micro-compaction projects single messages to size them — a leading result
    // is kept rather than treated as an orphan.
    expect(shape([toolResult('c1', 'partial result')])).toEqual(['tool:c1']);
  });

  it('keeps a tool-shaped message without a toolCallId', () => {
    const message: ContextMessage = {
      role: 'tool',
      content: [{ type: 'text', text: 'tool-like output' }],
      toolCalls: [],
    };
    expect(project([message])).toHaveLength(1);
  });

  it('trims a trailing exchange closed only by synthetic interrupted results', () => {
    const projected = project([user('go'), assistant('', ['c1', 'c2']), toolResult('c1', 'one')]);
    expect(trimTrailingOpenToolExchange(projected).map((message) => message.role)).toEqual([
      'user',
    ]);
  });

  it('keeps a trailing exchange closed by real tool results', () => {
    const projected = project([
      user('go'),
      assistant('', ['c1', 'c2']),
      toolResult('c1', 'one'),
      toolResult('c2', 'two'),
    ]);
    expect(trimTrailingOpenToolExchange(projected)).toEqual(projected);
  });
});
