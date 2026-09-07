import { describe, expect, it } from 'vitest';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { NO_FINISH } from '#/llm/finish-reason';
import {
  createMessageAccumulator,
  type AssistantMessage,
  type StreamedMessagePart,
} from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { emptyResponseError } from '#/llm/empty-response';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

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
