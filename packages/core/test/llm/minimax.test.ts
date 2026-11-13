import { APIError } from 'openai';
import { describe, expect, it } from 'vitest';

import {
  MINIMAX_DEFAULT_MAX_OUTPUT_TOKENS,
  MINIMAX_MAX_OUTPUT_TOKENS,
  miniMaxAnthropicProtocol,
  miniMaxOpenAIProtocol,
} from '#/llm/builtin/provider/minimax/index';
import type { OpenAIOptions } from '#/llm/builtin/protocol/openai/index';
import { createUserMessage, type Message } from '#/llm/message';
import type { DecodeSink, LlmModule } from '#/llm/protocol/protocol';
import { withProtocolCapabilities } from '#/llm/protocol/rules/model';
import type { LlmModelSpec, LlmRequestModel } from '#/llm/request';
import type { LlmRemoteErrorMessage } from '#/llm/response';

const specOf = (name: string, protocol = miniMaxOpenAIProtocol) =>
  withProtocolCapabilities({ provider: 'minimax', name }, protocol);

function moduleOf(
  name: string,
  model: Omit<LlmRequestModel, 'spec'> & { spec?: LlmModelSpec } = {},
  messages: Message[] = [createUserMessage('hi')],
): LlmModule<OpenAIOptions> {
  return {
    model: { spec: specOf(name), ...model },
    profile: {
      systemPrompt: 'system',
      tools: [{ name: 'lookup', description: 'lookup', parameters: {} }],
    },
    content: { messages },
    options: { reasoningKey: 'reasoning_content' },
  };
}

function encodeChat(name: string, model: Omit<LlmRequestModel, 'spec'> & { spec?: LlmModelSpec } = {}, messages?: Message[]) {
  return miniMaxOpenAIProtocol.encode(moduleOf(name, model, messages)).params as unknown as Record<string, unknown> & {
    messages: Record<string, unknown>[];
  };
}

function encodeAnthropic(name: string, model: Omit<LlmRequestModel, 'spec'> & { spec?: LlmModelSpec } = {}, messages?: Message[]) {
  return miniMaxAnthropicProtocol.encode({
    ...moduleOf(name, model, messages),
    options: undefined,
  }) as unknown as { params: Record<string, any>; betas: string[]; useBetaApi: boolean };
}

function businessError(code: number) {
  const errors: LlmRemoteErrorMessage[] = [];
  const sink: DecodeSink = {
    onDelta: () => {},
    onFinish: () => {},
    onMessageId: () => {},
    onUsage: () => {},
    onError: (error) => errors.push(error),
    onToolCallEnd: () => {},
  };
  const decoder = miniMaxOpenAIProtocol.decoder(moduleOf('MiniMax-M3.1-Flash'), sink);
  decoder.push({ choices: [], base_resp: { status_code: code, status_msg: `code ${code}` } } as never);
  decoder.end();
  return errors;
}

describe('minimax provider', () => {
  it('encodes model-specific thinking, media and limits without anthropic cache or beta features', () => {
    expect(specOf('MiniMax-M3.1-Flash').capability).toMatchObject({ image_in: true, video_in: true, thinking: true });
    expect(specOf('MiniMax-M3').capability).toMatchObject({ image_in: true, video_in: true, thinking: true });

    const chat = encodeChat('MiniMax-M3.1-Flash', {
      thinking: { effort: 'high' },
      maxOutputTokens: 600_000,
      cacheKey: 'session',
      sampling: { temperature: 0.2, topP: 0.9, stop: ['END'], seed: 7 },
    });
    expect(chat).toMatchObject({
      thinking: { type: 'adaptive' },
      reasoning_effort: 'high',
      max_completion_tokens: MINIMAX_MAX_OUTPUT_TOKENS,
      temperature: 0.2,
      top_p: 0.9,
    });
    expect(chat).not.toHaveProperty('prompt_cache_key');
    expect(chat).not.toHaveProperty('stop');
    expect(chat).not.toHaveProperty('seed');
    expect(encodeChat('MiniMax-M3.1-Flash')['max_completion_tokens']).toBe(MINIMAX_DEFAULT_MAX_OUTPUT_TOKENS);
    expect(() => encodeChat('MiniMax-M3.1-Flash', { thinking: { effort: 'off' } })).toThrow('requires adaptive thinking');
    expect(() => encodeChat('MiniMax-M3.1-Flash', { thinking: { effort: 'none' } })).toThrow('requires adaptive thinking');
    expect(() => encodeChat('MiniMax-M3.1-Flash', { thinking: { effort: 'minimal' } })).toThrow('not supported');
    expect(encodeChat('MiniMax-M3', { thinking: { effort: 'off' } })['thinking']).toEqual({ type: 'disabled' });
    expect(encodeChat('MiniMax-M3', { thinking: { effort: 'low' } })).toMatchObject({ thinking: { type: 'adaptive' } });
    expect(encodeChat('MiniMax-M3', { thinking: { effort: 'low' } })).not.toHaveProperty('reasoning_effort');
    expect(() => encodeChat('MiniMax-M3.1-Flash', { responseFormat: { type: 'json_object' } })).toThrow(
      "'json_object' response format is not supported",
    );

    const media = encodeChat('MiniMax-M3.1-Flash', {}, [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'watch' },
          { type: 'video_url', videoUrl: { url: 'mm_file://video-1' } },
        ],
      },
    ]);
    expect(media.messages[1]?.['content']).toEqual([
      { type: 'text', text: 'watch' },
      { type: 'video_url', video_url: { url: 'mm_file://video-1' } },
    ]);

    const anthropic = encodeAnthropic('MiniMax-M3.1-Flash', {
      thinking: { effort: 'high', keep: 'all' },
      maxOutputTokens: 600_000,
    });
    expect(anthropic.params).toMatchObject({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      max_tokens: MINIMAX_MAX_OUTPUT_TOKENS,
      system: [{ type: 'text', text: 'system' }],
    });
    expect(anthropic.betas).toEqual([]);
    expect(anthropic.useBetaApi).toBe(false);
    expect(anthropic.params['system'][0]).not.toHaveProperty('cache_control');
    expect(anthropic.params['messages'][0].content[0]).not.toHaveProperty('cache_control');
    expect(anthropic.params['tools'][0]).not.toHaveProperty('cache_control');
    expect(encodeAnthropic('MiniMax-M3.1-Flash').params['max_tokens']).toBe(MINIMAX_DEFAULT_MAX_OUTPUT_TOKENS);
    expect(encodeAnthropic('MiniMax-M3', { thinking: { effort: 'off' } }).params['thinking']).toEqual({ type: 'disabled' });

    const mov = encodeAnthropic('MiniMax-M3.1-Flash', {}, [
      {
        role: 'user',
        content: [
          { type: 'video_url', videoUrl: { url: 'data:video/mov;base64,AA==' } },
        ],
      },
    ]);
    expect(mov.params['messages'][0].content).toEqual([
      { type: 'video', source: { type: 'base64', media_type: 'video/mov', data: 'AA==' } },
    ]);

    expect(businessError(1008)).toMatchObject([{ kind: 'quota_exhausted', code: '1008', retryable: false }]);
    expect(businessError(1002)).toMatchObject([{ kind: 'rate_limit', code: '1002', retryable: true }]);
    expect(
      miniMaxOpenAIProtocol.decodeError(
        new APIError(429, { base_resp: { status_code: 1008, status_msg: 'balance' } }, 'balance', new Headers()),
      ),
    ).toMatchObject({ kind: 'quota_exhausted', statusCode: 429, code: '1008', retryable: false });
  });
});
