import { APIError } from 'openai';
import { describe, expect, it } from 'vitest';

import { glmProtocol } from '#/llm/builtin/provider/glm/index';
import type { OpenAIOptions } from '#/llm/builtin/protocol/openai/index';
import { createAssistantMessage, createToolMessage, createUserMessage, type Message } from '#/llm/message';
import type { DecodeSink, LlmModule } from '#/llm/protocol/protocol';
import { effectiveModelSpec } from '#/llm/protocol/rules/model';
import type { LlmRequestModel } from '#/llm/request';
import type { FinishInfo, LlmRemoteErrorMessage } from '#/llm/response';

const specOf = (name: string) => effectiveModelSpec(glmProtocol, { provider: 'glm', name });

function moduleOf(name: string, model: Omit<LlmRequestModel, 'spec'> = {}, messages: Message[] = []): LlmModule<OpenAIOptions> {
  return {
    model: { spec: specOf(name), ...model },
    profile: { tools: [{ name: 'shot', description: 'shot', parameters: {} }] },
    content: { messages },
    options: { reasoningKey: 'reasoning_content' },
  };
}

function encode(name: string, model: Omit<LlmRequestModel, 'spec'> = {}, messages: Message[] = [createUserMessage('hi')]) {
  return glmProtocol.encode(moduleOf(name, model, messages)).params as unknown as Record<string, unknown> & {
    messages: Record<string, unknown>[];
  };
}

function decodeChunks(chunks: readonly Record<string, unknown>[]) {
  const finishes: FinishInfo[] = [];
  const errors: LlmRemoteErrorMessage[] = [];
  const sink: DecodeSink = {
    onDelta: () => {},
    onFinish: (finish) => finishes.push(finish),
    onError: (error) => errors.push(error),
  };
  const decode = glmProtocol.decodeStream(moduleOf('glm-5.3'));
  for (const chunk of chunks) decode(chunk as never, sink);
  return { finishes, errors };
}

const chunk = (finishReason: string | null) => ({
  id: 'c',
  choices: [{ index: 0, delta: { content: 'x' }, finish_reason: finishReason }],
});

describe('glm provider', () => {
  it('encodes thinking per model family, adapts content and media, and classifies finishes and errors', () => {
    expect(specOf('glm-5.3-flash').capability).toMatchObject({ image_in: true, video_in: true, thinking: true });
    expect(specOf('glm-5.3').capability).toMatchObject({ image_in: false, thinking: true });
    expect(specOf('glm-4.6v').capability).toMatchObject({ image_in: true });
    expect(specOf('glm-4-flash-250414').capability).toMatchObject({ thinking: false });

    expect(encode('glm-5.3', { thinking: { effort: 'medium', keep: 'all' }, cacheKey: 's1' })).toMatchObject({
      thinking: { type: 'enabled', clear_thinking: false },
      reasoning_effort: 'high',
    });
    expect(encode('glm-5.3', { cacheKey: 's1' })).not.toHaveProperty('prompt_cache_key');
    expect(encode('glm-5.3', { thinking: { effort: 'on' } })).not.toHaveProperty('reasoning_effort');
    expect(() => encode('glm-5.3', { thinking: { effort: 'off' } })).toThrow('cannot be turned off');
    expect(() => encode('glm-5.3', { thinking: { effort: 'ultra' } })).toThrow("'ultra' cannot be mapped");
    expect(encode('glm-5.2', { thinking: { effort: 'off' } })['thinking']).toEqual({ type: 'disabled' });
    expect(encode('glm-5.2', { thinking: { effort: 'xhigh' } })).toMatchObject({ reasoning_effort: 'xhigh' });
    expect(encode('glm-4.7', { thinking: { effort: 'high' } })).not.toHaveProperty('reasoning_effort');
    expect(() =>
      encode('glm-5.3', { responseFormat: { type: 'json_schema', jsonSchema: { name: 'x', schema: {} } } }),
    ).toThrow("'json_schema' response format is not supported");

    const shot = { type: 'image_url' as const, source: { kind: 'url' as const, url: 'https://example.test/s.png' } };
    const webp = { type: 'image_url' as const, source: { kind: 'inline' as const, mimeType: 'image/webp', data: 'AA==' } };
    const vision = encode('glm-5.3-flash', {}, [
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, webp] },
      createAssistantMessage(
        [{ type: 'think', think: 'plan' }],
        [{ type: 'function', id: 'c1', name: 'shot', arguments: '{}' }],
      ),
      createToolMessage('c1', [{ type: 'text', text: 'taken' }, shot]),
    ]);
    expect(vision.messages).toEqual([
      {
        role: 'user',
        content: 'a\nb\n[image omitted for provider compatibility; re-read the file to view it or get conversion guidance]',
      },
      expect.objectContaining({ role: 'assistant', reasoning_content: 'plan' }),
      { role: 'tool', tool_call_id: 'c1', content: 'taken' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Attached media from tool result:' },
          { type: 'image_url', image_url: { url: 'https://example.test/s.png' } },
        ],
      },
    ]);

    expect(decodeChunks([chunk(null), chunk('sensitive')]).finishes).toEqual([
      { finishReason: 'filtered', rawFinishReason: 'content_filter' },
    ]);
    expect(decodeChunks([chunk('model_context_window_exceeded')]).finishes).toMatchObject([{ finishReason: 'truncated' }]);
    expect(decodeChunks([chunk('network_error')])).toMatchObject({ finishes: [], errors: [{ kind: 'provider' }] });

    const glmError = (status: number, code: string) =>
      glmProtocol.decodeError(new APIError(status, { code, message: `code ${code}` }, `code ${code}`, new Headers()));
    expect(glmError(429, '1113')).toMatchObject({ kind: 'quota_exhausted', statusCode: 429 });
    expect(glmError(429, '1310')).toMatchObject({ kind: 'quota_exhausted' });
    expect(glmError(429, '1302')).toMatchObject({ kind: 'rate_limit' });
    expect(glmError(429, '1305')).toMatchObject({ kind: 'overloaded' });
    expect(glmError(400, '1261')).toMatchObject({ kind: 'context_overflow' });
  });
});
