import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentContextMemoryService } from '#/index';

import { createTestAgent, type TestAgentContext } from '../harness';

describe('loop-event fold parity', () => {
  let ctx: TestAgentContext;
  let context: IAgentContextMemoryService;

  beforeEach(() => {
    ctx = createTestAgent();
    context = ctx.get(IAgentContextMemoryService);
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  function comparable(messages: readonly ContextMessage[]): unknown {
    return messages.map((m) => ({
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls,
      toolCallId: m.toolCallId,
      isError: m.isError,
      note: m.note,
    }));
  }

  it('folds a text + tool-call + tool-result step into the append_message shape', () => {
    context.append(
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'I will call.' }],
        toolCalls: [{ type: 'function', id: 'c1', name: 'Lookup', arguments: '{"q":"moon"}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'lookup result' }],
        toolCalls: [],
        toolCallId: 'c1',
        isError: false,
      },
    );
    const baseline = comparable(context.get());
    context.clear();

    context.appendLoopEvent({ type: 'step.begin', uuid: 's1' });
    context.appendLoopEvent({
      type: 'content.part',
      stepUuid: 's1',
      part: { type: 'text', text: 'I will call.' },
    });
    context.appendLoopEvent({
      type: 'tool.call',
      stepUuid: 's1',
      toolCallId: 'c1',
      name: 'Lookup',
      args: { q: 'moon' },
    });
    context.appendLoopEvent({
      type: 'tool.result',
      toolCallId: 'c1',
      result: { output: 'lookup result', isError: false },
    });
    context.appendLoopEvent({ type: 'step.end', uuid: 's1' });
    const folded = comparable(context.get());

    expect(folded).toEqual(baseline);
  });

  it('folds an errored tool result into the append_message shape', () => {
    context.append(
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'c2', name: 'Bash', arguments: '{}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'boom' }],
        toolCalls: [],
        toolCallId: 'c2',
        isError: true,
      },
    );
    const baseline = comparable(context.get());
    context.clear();

    context.appendLoopEvent({ type: 'step.begin', uuid: 's2' });
    context.appendLoopEvent({
      type: 'tool.call',
      stepUuid: 's2',
      toolCallId: 'c2',
      name: 'Bash',
      args: {},
    });
    context.appendLoopEvent({
      type: 'tool.result',
      toolCallId: 'c2',
      result: { output: 'boom', isError: true },
    });
    context.appendLoopEvent({ type: 'step.end', uuid: 's2' });
    const folded = comparable(context.get());

    expect(folded).toEqual(baseline);
  });

  it('folds a tool-result note as structured model-only metadata', () => {
    context.append(
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ type: 'function', id: 'c3', name: 'Screenshot', arguments: '{}' }],
      },
      {
        role: 'tool',
        content: [{ type: 'text', text: 'result text' }],
        toolCalls: [],
        toolCallId: 'c3',
        isError: false,
        note: '<system>Image compressed.</system>',
      },
    );
    const baseline = comparable(context.get());
    context.clear();

    context.appendLoopEvent({ type: 'step.begin', uuid: 's3' });
    context.appendLoopEvent({
      type: 'tool.call',
      stepUuid: 's3',
      toolCallId: 'c3',
      name: 'Screenshot',
      args: {},
    });
    context.appendLoopEvent({
      type: 'tool.result',
      toolCallId: 'c3',
      result: {
        output: 'result text',
        isError: false,
        note: '<system>Image compressed.</system>',
      },
    });
    context.appendLoopEvent({ type: 'step.end', uuid: 's3' });
    const folded = comparable(context.get());

    expect(folded).toEqual(baseline);
  });
});
