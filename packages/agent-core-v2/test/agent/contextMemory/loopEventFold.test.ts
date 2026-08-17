import { describe, expect, it } from 'vitest';

import {
  foldAppendMessage,
  foldLoopEvent,
  type LoopRecordedEvent,
} from '#/agent/contextMemory/loopEventFold';
import type { ContextMessage } from '#/agent/contextMemory/types';

describe('loop-event fold parity', () => {
  function appendAll(
    state: readonly ContextMessage[],
    messages: readonly ContextMessage[],
  ): readonly ContextMessage[] {
    let next = state;
    for (const message of messages) {
      next = foldAppendMessage(next, message);
    }
    return next;
  }

  function foldAll(
    state: readonly ContextMessage[],
    events: readonly LoopRecordedEvent[],
  ): readonly ContextMessage[] {
    let next = state;
    for (const event of events) {
      next = foldLoopEvent(next, event);
    }
    return next;
  }

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
    const baseline = comparable(
      appendAll([], [
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
      ]),
    );

    const folded = comparable(
      foldAll([], [
        { type: 'step.begin', uuid: 's1' },
        {
          type: 'content.part',
          stepUuid: 's1',
          part: { type: 'text', text: 'I will call.' },
        },
        {
          type: 'tool.call',
          stepUuid: 's1',
          toolCallId: 'c1',
          name: 'Lookup',
          args: { q: 'moon' },
        },
        {
          type: 'tool.result',
          toolCallId: 'c1',
          result: { output: 'lookup result', isError: false },
        },
        { type: 'step.end', uuid: 's1' },
      ]),
    );

    expect(folded).toEqual(baseline);
  });

  it('folds an errored tool result into the append_message shape', () => {
    const baseline = comparable(
      appendAll([], [
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
      ]),
    );

    const folded = comparable(
      foldAll([], [
        { type: 'step.begin', uuid: 's2' },
        {
          type: 'tool.call',
          stepUuid: 's2',
          toolCallId: 'c2',
          name: 'Bash',
          args: {},
        },
        {
          type: 'tool.result',
          toolCallId: 'c2',
          result: { output: 'boom', isError: true },
        },
        { type: 'step.end', uuid: 's2' },
      ]),
    );

    expect(folded).toEqual(baseline);
  });

  function shapes(messages: readonly ContextMessage[]) {
    return messages.map((m) => ({
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls,
      toolCallId: m.toolCallId,
      isError: m.isError,
      partial: m.partial,
    }));
  }

  it('drops an empty partial assistant left by a failed attempt when the retry begins', () => {
    const folded = foldAll([], [
      { type: 'step.begin', uuid: 's1' },
      { type: 'step.begin', uuid: 's2' },
      {
        type: 'content.part',
        stepUuid: 's2',
        part: { type: 'text', text: 'recovered' },
      },
      { type: 'step.end', uuid: 's2' },
    ]);

    expect(shapes(folded)).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'recovered' }],
        toolCalls: [],
        toolCallId: undefined,
        isError: undefined,
        partial: undefined,
      },
    ]);
  });

  it('seals a failed attempt’s partial assistant and closes its tool exchange on the next step.begin', () => {
    const folded = foldAll([], [
      { type: 'step.begin', uuid: 's1' },
      {
        type: 'content.part',
        stepUuid: 's1',
        part: { type: 'text', text: 'half' },
      },
      {
        type: 'tool.call',
        stepUuid: 's1',
        toolCallId: 'c1',
        name: 'Bash',
        args: {},
      },
      { type: 'step.begin', uuid: 's2' },
    ]);

    expect(shapes(folded)).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'half' }],
        toolCalls: [{ type: 'function', id: 'c1', name: 'Bash', arguments: '{}' }],
        toolCallId: undefined,
        isError: undefined,
        partial: undefined,
      },
      {
        role: 'tool',
        content: expect.any(Array),
        toolCalls: [],
        toolCallId: 'c1',
        isError: true,
        partial: undefined,
      },
      {
        role: 'assistant',
        content: [],
        toolCalls: [],
        toolCallId: undefined,
        isError: undefined,
        partial: true,
      },
    ]);
  });

  it('drops an assistant that produced no output at step.end', () => {
    const folded = foldAll([], [
      { type: 'step.begin', uuid: 's1' },
      { type: 'step.end', uuid: 's1' },
    ]);

    expect(folded).toEqual([]);
  });

  it('drops an assistant whose only recorded part is an empty thinking block at step.end', () => {
    const folded = foldAll([], [
      { type: 'step.begin', uuid: 's1' },
      {
        type: 'content.part',
        stepUuid: 's1',
        part: { type: 'think', think: '' },
      },
      { type: 'step.end', uuid: 's1' },
    ]);

    expect(folded).toEqual([]);
  });

  it('drops a vacuous partial assistant left by a failed attempt when the retry begins', () => {
    const folded = foldAll([], [
      { type: 'step.begin', uuid: 's1' },
      {
        type: 'content.part',
        stepUuid: 's1',
        part: { type: 'think', think: '   ' },
      },
      { type: 'step.begin', uuid: 's2' },
      {
        type: 'content.part',
        stepUuid: 's2',
        part: { type: 'text', text: 'recovered' },
      },
      { type: 'step.end', uuid: 's2' },
    ]);

    expect(shapes(folded)).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'recovered' }],
        toolCalls: [],
        toolCallId: undefined,
        isError: undefined,
        partial: undefined,
      },
    ]);
  });

  it('seals a step whose thinking block has real content', () => {
    const folded = foldAll([], [
      { type: 'step.begin', uuid: 's1' },
      {
        type: 'content.part',
        stepUuid: 's1',
        part: { type: 'think', think: 'real reasoning' },
      },
      { type: 'step.end', uuid: 's1' },
    ]);

    expect(folded.at(-1)?.content).toEqual([{ type: 'think', think: 'real reasoning' }]);
  });

  it('seals a step whose empty thinking block carries a provider signature', () => {
    const folded = foldAll([], [
      { type: 'step.begin', uuid: 's1' },
      {
        type: 'content.part',
        stepUuid: 's1',
        part: { type: 'think', think: '', encrypted: 'sig' },
      },
      { type: 'step.end', uuid: 's1' },
    ]);

    expect(folded.at(-1)?.content).toEqual([{ type: 'think', think: '', encrypted: 'sig' }]);
  });

  it('seals a step that pairs an empty thinking block with real text', () => {
    const folded = foldAll([], [
      { type: 'step.begin', uuid: 's1' },
      {
        type: 'content.part',
        stepUuid: 's1',
        part: { type: 'think', think: '' },
      },
      {
        type: 'content.part',
        stepUuid: 's1',
        part: { type: 'text', text: 'answer' },
      },
      { type: 'step.end', uuid: 's1' },
    ]);

    expect(folded.at(-1)?.content).toEqual([
      { type: 'think', think: '' },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('seals an assistant with tool calls even when its thinking block is empty', () => {
    const folded = foldAll([], [
      { type: 'step.begin', uuid: 's1' },
      {
        type: 'content.part',
        stepUuid: 's1',
        part: { type: 'think', think: '' },
      },
      {
        type: 'tool.call',
        stepUuid: 's1',
        toolCallId: 'c1',
        name: 'Lookup',
        args: {},
      },
      { type: 'step.end', uuid: 's1' },
    ]);

    expect(shapes(folded)).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'think', think: '' }],
        toolCalls: [{ type: 'function', id: 'c1', name: 'Lookup', arguments: '{}' }],
        toolCallId: undefined,
        isError: undefined,
        partial: undefined,
      },
      {
        role: 'tool',
        content: expect.any(Array),
        toolCalls: [],
        toolCallId: 'c1',
        isError: true,
        partial: undefined,
      },
    ]);
  });

  it('folds a tool-result note as structured model-only metadata', () => {
    const baseline = comparable(
      appendAll([], [
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
      ]),
    );

    const folded = comparable(
      foldAll([], [
        { type: 'step.begin', uuid: 's3' },
        {
          type: 'tool.call',
          stepUuid: 's3',
          toolCallId: 'c3',
          name: 'Screenshot',
          args: {},
        },
        {
          type: 'tool.result',
          toolCallId: 'c3',
          result: {
            output: 'result text',
            isError: false,
            note: '<system>Image compressed.</system>',
          },
        },
        { type: 'step.end', uuid: 's3' },
      ]),
    );

    expect(folded).toEqual(baseline);
  });
});
