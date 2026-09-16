import { describe, expect, it } from 'vitest';

import {
  foldAppendMessage,
  foldLoopEvent,
  type LoopRecordedEvent,
} from '#/agent/contextMemory/loopEventFold';
import { isAssistantEntry, isToolEntry, type HistoryMessage } from '#human/agent/turn';

describe('loop-event fold parity', () => {
  function appendAll(
    state: readonly HistoryMessage[],
    messages: readonly HistoryMessage[],
  ): readonly HistoryMessage[] {
    let next = state;
    for (const message of messages) {
      next = foldAppendMessage(next, message);
    }
    return next;
  }

  function foldAll(
    state: readonly HistoryMessage[],
    events: readonly LoopRecordedEvent[],
  ): readonly HistoryMessage[] {
    let next = state;
    for (const event of events) {
      next = foldLoopEvent(next, event);
    }
    return next;
  }

  function comparable(messages: readonly HistoryMessage[]): unknown {
    return messages.map((entry) => ({
      role: entry.message.role,
      content: entry.message.content,
      toolCalls: entry.message.role === 'assistant' ? entry.message.toolCalls : [],
      toolCallId: entry.message.role === 'tool' ? entry.message.toolCallId : undefined,
      isError: isToolEntry(entry) ? entry.meta?.isError : undefined,
      note: isToolEntry(entry) ? entry.meta?.note : undefined,
    }));
  }

  it('folds a text + tool-call + tool-result step into the append_message shape', () => {
    const baseline = comparable(
      appendAll([], [
        {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'I will call.' }],
            toolCalls: [{ type: 'function', id: 'c1', name: 'Lookup', arguments: '{"q":"moon"}' }],
          },
          meta: {},
        },
        {
          message: {
            role: 'tool',
            content: [{ type: 'text', text: 'lookup result' }],
            toolCallId: 'c1',
          },
          meta: { isError: false },
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
          message: {
            role: 'assistant',
            content: [],
            toolCalls: [{ type: 'function', id: 'c2', name: 'Bash', arguments: '{}' }],
          },
          meta: {},
        },
        {
          message: {
            role: 'tool',
            content: [{ type: 'text', text: 'boom' }],
            toolCallId: 'c2',
          },
          meta: { isError: true },
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

  function shapes(messages: readonly HistoryMessage[]) {
    return messages.map((entry) => ({
      role: entry.message.role,
      content: entry.message.content,
      toolCalls: entry.message.role === 'assistant' ? entry.message.toolCalls : [],
      toolCallId: entry.message.role === 'tool' ? entry.message.toolCallId : undefined,
      isError: isToolEntry(entry) ? entry.meta?.isError : undefined,
      partial: isAssistantEntry(entry) ? entry.meta?.partial : undefined,
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

  it('keeps the open assistant untouched when step.end reports an interruption', () => {
    const folded = foldAll([], [
      { type: 'step.begin', uuid: 's1' },
      {
        type: 'content.part',
        stepUuid: 's1',
        part: { type: 'text', text: 'partial' },
      },
      { type: 'step.end', uuid: 's1', finishReason: 'interrupted' },
    ]);

    expect(shapes(folded)).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial' }],
        toolCalls: [],
        toolCallId: undefined,
        isError: undefined,
        partial: true,
      },
    ]);
  });

  it('settles a failed step at the next step.begin as before', () => {
    const folded = foldAll([], [
      { type: 'step.begin', uuid: 's1' },
      { type: 'step.end', uuid: 's1', finishReason: 'error' },
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

    expect(folded.at(-1)?.message.content).toEqual([{ type: 'think', think: 'real reasoning' }]);
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

    expect(folded.at(-1)?.message.content).toEqual([{ type: 'think', think: '', encrypted: 'sig' }]);
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

    expect(folded.at(-1)?.message.content).toEqual([
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
          message: {
            role: 'assistant',
            content: [],
            toolCalls: [{ type: 'function', id: 'c3', name: 'Screenshot', arguments: '{}' }],
          },
          meta: {},
        },
        {
          message: {
            role: 'tool',
            content: [{ type: 'text', text: 'result text' }],
            toolCallId: 'c3',
          },
          meta: { isError: false, note: '<system>Image compressed.</system>' },
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
