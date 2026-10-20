import { describe, expect, it } from 'vitest';

import { extractText, type AssistantMessage, type StreamedMessagePart } from '#/llm/message';
import {
  createMessageAccumulator,
  emptyResponseError,
  usableOutputOf,
} from '#/llm/policy/settle';
import type { LlmModelSpec } from '#/llm/request';
import { NO_FINISH } from '#/llm/response';

const model: LlmModelSpec = { provider: 'test', name: 'test-model' };

function accumulatedMessage(parts: readonly StreamedMessagePart[]): AssistantMessage {
  const accumulator = createMessageAccumulator();
  for (const part of parts) {
    accumulator.push(part);
  }
  return accumulator.finish();
}

describe('emptyResponseError', () => {
  it('reports an empty response when the stream produced nothing', () => {
    const message = accumulatedMessage([]);
    const error = emptyResponseError(message, model, NO_FINISH);
    expect(error).toMatchObject({
      kind: 'empty_response',
      finishReason: null,
      rawFinishReason: null,
    });
    expect(error?.message).toContain('empty response (no content, no tool calls)');
    expect(error?.message).toContain('Provider: test, model: test-model');

    const filtered = emptyResponseError(message, model, {
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });
    expect(filtered).toMatchObject({
      kind: 'empty_response',
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });
    expect(filtered?.message).toContain('filtered the response');
  });

  it('reports a think-only response but tolerates whitespace text', () => {
    const thinkOnly = accumulatedMessage([{ type: 'think', think: 'reasoning' }]);
    const error = emptyResponseError(thinkOnly, model, NO_FINISH);
    expect(error?.kind).toBe('empty_response');
    expect(error?.message).toContain('only thinking content');

    const whitespace = accumulatedMessage([{ type: 'text', text: '  \n' }]);
    expect(emptyResponseError(whitespace, model, NO_FINISH)).toBeNull();

    const thinkWithWhitespace = accumulatedMessage([
      { type: 'think', think: 'reasoning' },
      { type: 'text', text: ' ' },
    ]);
    expect(emptyResponseError(thinkWithWhitespace, model, NO_FINISH)?.message).toContain(
      'only thinking content',
    );
  });

  it('returns null when the stream produced text or tool calls', () => {
    expect(
      emptyResponseError(accumulatedMessage([{ type: 'text', text: 'hi' }]), model, NO_FINISH),
    ).toBeNull();
    expect(
      emptyResponseError(
        accumulatedMessage([
          { type: 'think', think: 'reasoning' },
          { type: 'text', text: 'hi' },
        ]),
        model,
        NO_FINISH,
      ),
    ).toBeNull();
    expect(
      emptyResponseError(
        accumulatedMessage([{ type: 'function', id: 'call_1', name: 'tool', arguments: '{}' }]),
        model,
        NO_FINISH,
      ),
    ).toBeNull();
  });
});

describe('usableOutputOf', () => {
  it('returns null when nothing or only vacuous parts were streamed', () => {
    expect(usableOutputOf(accumulatedMessage([]))).toBeNull();
    expect(
      usableOutputOf(accumulatedMessage([{ type: 'text', text: '  \n' }])),
    ).toBeNull();
  });

  it('returns null when the stream is still in the thinking phase', () => {
    expect(
      usableOutputOf(accumulatedMessage([{ type: 'think', think: 'reasoning' }])),
    ).toBeNull();
    expect(
      usableOutputOf(
        accumulatedMessage([
          { type: 'think', think: 'reasoning' },
          { type: 'text', text: ' ' },
        ]),
      ),
    ).toBeNull();
  });

  it('keeps thinking alongside visible output once text has started', () => {
    const salvaged = usableOutputOf(
      accumulatedMessage([
        { type: 'think', think: 'reasoning' },
        { type: 'text', text: 'partial answer' },
      ]),
    );
    expect(salvaged).not.toBeNull();
    expect(extractText(salvaged as AssistantMessage)).toBe('partial answer');
    expect((salvaged as AssistantMessage).content.some((part) => part.type === 'think')).toBe(
      true,
    );
    expect((salvaged as AssistantMessage).toolCalls).toEqual([]);
  });
});
