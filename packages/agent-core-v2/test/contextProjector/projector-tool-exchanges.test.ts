import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentContextProjectorService } from '#/agent/contextProjector/contextProjector';
import { AgentContextProjectorService } from '#/agent/contextProjector/contextProjectorService';
import { IAgentMicroCompactionService } from '#/agent/microCompaction/microCompaction';
import { toProtocolMessage } from '#/agent/contextMemory/messageProjection';
import type { Message } from '#/app/llmProtocol/message';

// Tests for how the projector normalizes tool exchanges: results are pulled up
// right after their call, messages that landed between a call and its results
// are deferred to after the exchange, unanswered calls are closed with a
// synthetic error result, stale duplicate results are dropped, and orphan
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

describe('projector tool-exchange normalization', () => {
  let disposables: DisposableStore;
  let projector: IAgentContextProjectorService;

  beforeEach(() => {
    disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.set(IAgentContextProjectorService, new SyncDescriptor(AgentContextProjectorService));
    ix.stub(IAgentMicroCompactionService, { compact: (messages) => messages });
    projector = ix.get(IAgentContextProjectorService);
  });

  afterEach(() => disposables.dispose());

  function project(history: readonly ContextMessage[]): readonly Message[] {
    return projector.project(history);
  }

  function shape(history: readonly ContextMessage[]): string[] {
    return project(history).map((message) =>
      message.role === 'tool' ? `tool:${message.toolCallId}` : message.role,
    );
  }

  function projectStrict(history: readonly ContextMessage[]): readonly Message[] {
    return projector.projectStrict(history);
  }

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

  it('drops a leading orphan result when the slice contains an assistant', () => {
    const history = [toolResult('ghost', 'orphaned'), user('hi'), assistant('hello')];
    expect(shape(history)).toEqual(['user', 'assistant']);
  });

  it('drops a partial assistant exchange without stranding its results', () => {
    // A partial assistant (stream interrupted) is removed before the exchange
    // normalization, so its recorded results become orphans and are dropped,
    // and no synthetic result is invented for its open calls.
    const history: ContextMessage[] = [
      user('go'),
      { ...assistant('', ['c1', 'c2']), partial: true },
      toolResult('c1', 'one'),
      assistant('recovered'),
    ];
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

  it('renders structured tool-result notes only for the model projection', () => {
    const note = '<system>Image compressed.</system>';
    const result: ContextMessage = {
      role: 'tool',
      content: [{ type: 'text', text: 'image result' }],
      toolCalls: [],
      toolCallId: 'call_image',
      note,
    };
    const history = [assistant('', ['call_image']), result];

    expect(project(history)[1]?.content).toEqual([
      { type: 'text', text: `image result\n${note}` },
    ]);
    expect(result.content).toEqual([{ type: 'text', text: 'image result' }]);

    const protocol = toProtocolMessage('session_1', 0, result, 0);
    expect(protocol.content).toEqual([
      { type: 'tool_result', tool_call_id: 'call_image', output: 'image result' },
    ]);
  });

  it('renders v1 tool-result status at the model projection boundary', () => {
    const history = [
      assistant('', ['call_error', 'call_empty']),
      {
        role: 'tool',
        content: [{ type: 'text', text: '<system>ERROR: remote failed</system>' }],
        toolCalls: [],
        toolCallId: 'call_error',
        isError: true,
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: '   ' }],
        toolCalls: [],
        toolCallId: 'call_empty',
      },
    ] satisfies ContextMessage[];

    expect(project(history)[1]?.content).toEqual([
      {
        type: 'text',
        text:
          '<system>ERROR: Tool execution failed.</system>\n' +
          '<system>ERROR: remote failed</system>',
      },
    ]);
    expect(project(history)[2]?.content).toEqual([
      { type: 'text', text: '<system>Tool output is empty.</system>' },
    ]);
  });

  it('strict mode dedupes duplicate assistant tool call ids', () => {
    const history = [
      user('go'),
      assistant('first', ['dup']),
      toolResult('dup', 'one'),
      assistant('second', ['dup']),
      toolResult('dup', 'two'),
    ];

    const projected = projectStrict(history);

    expect(projected.map((message) => (message.role === 'tool' ? `tool:${message.toolCallId}` : message.role))).toEqual([
      'user',
      'assistant',
      'tool:dup',
      'assistant',
    ]);
    expect(projected[1]?.toolCalls.map((call) => call.id)).toEqual(['dup']);
    expect(projected.filter((message) => message.role === 'tool')).toHaveLength(1);
  });

  it("strict mode reattaches a later duplicate's result when the first call has none", () => {
    const projected = projectStrict([
      user('go'),
      assistant('first attempt', ['dup']),
      assistant('second attempt', ['dup']),
      toolResult('dup', 'late result'),
      user('next'),
    ]);

    expect(
      projected.map((message) =>
        message.role === 'tool' ? `tool:${message.toolCallId}` : message.role,
      ),
    ).toEqual(['user', 'assistant', 'tool:dup', 'assistant', 'user']);
    expect(projected[1]?.toolCalls.map((call) => call.id)).toEqual(['dup']);
    expect((projected[2]?.content[0] as { text: string }).text).toBe('late result');
  });

  it('strict mode drops leading non-user messages', () => {
    const projected = projectStrict([assistant('stale'), toolResult('ghost', 'orphaned'), user('hi')]);

    expect(projected.map((message) => message.role)).toEqual(['user']);
    expect(projected[0]?.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('strict mode merges consecutive assistant messages', () => {
    const projected = projectStrict([user('go'), assistant('one'), assistant('two')]);

    expect(projected.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(projected[1]?.content).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ]);
  });

});
