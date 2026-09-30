import { APIError } from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  deepseekAnthropicProtocol,
  deepseekOpenAIProtocol,
  DEEPSEEK_MAX_OUTPUT_TOKENS,
} from '#/llm/builtin/provider/deepseek/index';
import { deepseekAnthropicFiles } from '#/llm/builtin/provider/deepseek/files';
import {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
  type MediaSource,
  type Message,
} from '#/llm/message';
import { effectiveModelSpec } from '#/llm/protocol/rules/model';
import type { LlmModelSpec, LlmRequestModel } from '#/llm/request';

const flash: LlmModelSpec = effectiveModelSpec(deepseekOpenAIProtocol, { provider: 'deepseek', name: 'deepseek-flash' });
const pro: LlmModelSpec = effectiveModelSpec(deepseekOpenAIProtocol, { provider: 'deepseek', name: 'deepseek-v4-pro' });

function encodeChat(model: Omit<LlmRequestModel, 'spec'> & { spec?: LlmModelSpec }, messages: Message[]) {
  return deepseekOpenAIProtocol.encode({
    model: { spec: flash, ...model },
    profile: { tools: [{ name: 'lookup', description: 'lookup', parameters: {} }] },
    content: { messages },
    options: { reasoningKey: 'reasoning_content' },
  }).params as unknown as Record<string, unknown> & { messages: Record<string, unknown>[] };
}

describe('deepseek provider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('encodes thinking, files, limits and errors for the chat and anthropic formats', async () => {
    expect([flash.capability?.image_in, pro.capability?.image_in]).toEqual([true, false]);

    const image = (source: MediaSource) => ({ type: 'image_url', source }) as const;
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, image({ kind: 'file', id: 'file-api-1', mimeType: 'image/png' })] },
      createAssistantMessage(
        [{ type: 'think', think: 'plan' }],
        [{ type: 'function', id: 'c1', name: 'lookup', arguments: '{}' }],
      ),
      createToolMessage('c1', 'done'),
      createUserMessage('next'),
    ];
    const max = encodeChat(
      { thinking: { effort: 'max' }, maxOutputTokens: 500_000, cacheKey: 's1', sampling: { temperature: 0.2, presencePenalty: 1 } },
      history,
    );
    expect(max).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max',
      max_tokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
      temperature: 0.2,
    });
    expect(max).not.toHaveProperty('prompt_cache_key');
    expect(max).not.toHaveProperty('presence_penalty');
    expect(max.messages[0]?.['content']).toEqual([
      { type: 'text', text: 'look' },
      { type: 'file', file_id: 'file-api-1' },
    ]);
    expect(max.messages[1]).toMatchObject({ role: 'assistant', reasoning_content: 'plan' });

    const off = encodeChat({ thinking: { effort: 'off' } }, [createUserMessage('hi')]);
    expect(off['thinking']).toEqual({ type: 'disabled' });
    expect(off).not.toHaveProperty('reasoning_effort');
    expect(encodeChat({ thinking: { effort: 'on' } }, [createUserMessage('hi')])).not.toHaveProperty('reasoning_effort');
    const textOnly = encodeChat({ spec: pro }, [
      { role: 'user', content: [image({ kind: 'url', url: 'https://example.test/a.png' })] },
    ]);
    expect(textOnly.messages[0]?.['content']).toBe('[image omitted: not supported by this model]');
    expect(
      encodeChat({}, [{ role: 'user', content: [image({ kind: 'url', url: `https://example.test/${'a'.repeat(9000)}.png` })] }])
        .messages[0]?.['content'],
    ).toBe('[image omitted for provider compatibility; re-read the file to view it or get conversion guidance]');
    expect(encodeChat({ responseFormat: { type: 'json_object' } }, [createUserMessage('hi')])).toMatchObject({
      response_format: { type: 'json_object' },
    });
    expect(() =>
      encodeChat(
        { responseFormat: { type: 'json_schema', jsonSchema: { name: 'x', schema: {} } } },
        [createUserMessage('hi')],
      ),
    ).toThrow("'json_schema' response format is not supported");

    const anthropic = deepseekAnthropicProtocol.encode({
      model: { spec: flash, thinking: { effort: 'high' } },
      profile: {},
      content: { messages: [history[0]!] },
      options: undefined,
    }) as unknown as { params: Record<string, unknown>; betas: string[] };
    expect(anthropic.params).toMatchObject({
      thinking: { type: 'enabled' },
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'file', file_id: 'file-api-1' } }] }],
    });
    expect(anthropic.betas).toContain('files-api-2025-04-14');
    expect(() =>
      deepseekAnthropicProtocol.encode({
        model: { spec: flash, responseFormat: { type: 'json_object' } },
        profile: {},
        content: { messages: [createUserMessage('hi')] },
        options: undefined,
      }),
    ).toThrow("'json_object' response format is not supported");

    expect(
      deepseekOpenAIProtocol.decodeError(new APIError(402, { message: 'Insufficient Balance' }, 'Insufficient Balance', new Headers())),
    ).toMatchObject({ kind: 'quota_exhausted', statusCode: 402 });
    expect(
      deepseekOpenAIProtocol.decodeError(new APIError(429, { message: 'Rate Limit Reached' }, 'Rate Limit Reached', new Headers())),
    ).toMatchObject({ kind: 'rate_limit' });

    const uploads: { url: string; form: FormData }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      uploads.push({ url, form: init.body as FormData });
      return Response.json({ id: 'file-api-2', object: 'file', bytes: 3, created_at: 1_700_000_000, filename: 'upload.png', purpose: 'user_data', expires_at: 1_702_592_000 });
    });
    const uploaded = await deepseekAnthropicFiles.upload(
      { kind: 'image', data: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
      { endpoint: { baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'YOUR_API_KEY' }, signal: new AbortController().signal },
    );
    expect(uploaded).toEqual({
      source: { kind: 'file', id: 'file-api-2', mimeType: 'image/png' },
      expiresAt: 1_702_592_000_000 - 3_600_000,
    });
    expect(uploads[0]?.url).toBe('https://api.deepseek.com/files');
    expect(uploads[0]?.form.get('purpose')).toBe('user_data');
    expect(uploads[0]?.form.get('expires_after[seconds]')).toBe(String(30 * 24 * 3600));
  });
});
