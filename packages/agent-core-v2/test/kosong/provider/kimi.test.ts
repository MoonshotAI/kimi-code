/**
 * `kosong/provider` Kimi trait probes (probe 6) — every Kimi deviation is a
 * declarative trait hook on one of two trait objects, tested directly
 * against a stub trait context:
 *
 *  - `kimiOpenAITrait.convertTool`: `$`-prefixed tools become
 *    `builtin_function`; regular tools get the Kimi schema dialect
 *    normalization;
 *  - `kimiOpenAITrait.convertMessage`: empty-content assistant tool messages
 *    drop `content`; `tool_calls[].extras` round-trips; message-level
 *    `tools` embed;
 *  - `kimiOpenAITrait.reasoningKey` / `preserveThinking`: reasoning field is
 *    `reasoning_content`; force-replay only `keep: 'all'` sessions with
 *    thinking not disabled;
 *  - `kimiOpenAITrait.extractUsage`: usage at the top level or
 *    `choices[0].usage`;
 *  - `kimiOpenAITrait` request params: endpoint chain, `max_tokens` →
 *    `max_completion_tokens` with `extra_body` expansion,
 *    `extra_body.thinking` encoding, no 128k ceiling, `prompt_cache_key`,
 *    and the `strictThinkingValidation` marker;
 *  - `kimiAnthropicTrait` (the `(kimi, anthropic)` registration): thinking
 *    encoding and interleaved-thinking beta stripping.
 */

import { describe, expect, it } from 'vitest';

import type { Message } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import type { ProtocolTrait, TraitContext } from '#/kosong/protocol/protocolTrait';
import {
  convertKimiTool,
  kimiAnthropicTrait,
  kimiOpenAITrait,
} from '#/kosong/provider/providers/kimi/kimi.contrib';

const context: TraitContext = {
  config: { protocol: 'openai', providerType: 'kimi', modelName: 'kimi-k2' },
  providerId: 'kimi',
};

function call<T>(hook: ((...args: never[]) => T) | undefined, ...args: unknown[]): T | undefined {
  return hook === undefined ? undefined : hook(...(args as never[]));
}

describe('kimiOpenAITrait.convertTool', () => {
  it('converts $-prefixed tools to builtin_function declarations', () => {
    const tool: Tool = { name: '$web_search', description: 'search', parameters: {} };
    expect(call(kimiOpenAITrait.convertTool, tool, context)).toEqual({
      type: 'builtin_function',
      function: { name: '$web_search' },
    });
  });

  it('normalizes the schema dialect of regular tools', () => {
    const tool: Tool = {
      name: 'read_file',
      description: 'read',
      parameters: {
        $defs: { path: { type: 'string' } },
        properties: { path: { $ref: '#/$defs/path' } },
      },
    };
    expect(convertKimiTool(tool)).toEqual({
      type: 'function',
      function: {
        name: 'read_file',
        description: 'read',
        parameters: { properties: { path: { type: 'string' } } },
      },
    });
  });
});

describe('kimiOpenAITrait.convertMessage', () => {
  const assistantToolMessage: Message = {
    role: 'assistant',
    content: [{ type: 'text', text: '   ' }],
    toolCalls: [
      { type: 'function', id: 'call_1', name: 'read_file', arguments: '{}', extras: { a: 1 } },
      { type: 'function', id: 'call_2', name: 'write_file', arguments: null },
    ],
  };

  it('deletes effectively-empty content on assistant tool messages', () => {
    const converted: Record<string, unknown> = {
      role: 'assistant',
      content: '   ',
      tool_calls: [
        { type: 'function', id: 'call_1', function: { name: 'read_file', arguments: '{}' } },
        { type: 'function', id: 'call_2', function: { name: 'write_file', arguments: null } },
      ],
    };
    const out = call(kimiOpenAITrait.convertMessage, assistantToolMessage, converted, context);
    expect(out).not.toHaveProperty('content');
  });

  it('round-trips tool_calls extras by index', () => {
    const converted: Record<string, unknown> = {
      role: 'assistant',
      tool_calls: [
        { type: 'function', id: 'call_1', function: { name: 'read_file', arguments: '{}' } },
        { type: 'function', id: 'call_2', function: { name: 'write_file', arguments: null } },
      ],
    };
    const out = call(
      kimiOpenAITrait.convertMessage,
      assistantToolMessage,
      converted,
      context,
    ) as Record<string, unknown>;
    const toolCalls = out['tool_calls'] as Record<string, unknown>[];
    expect(toolCalls[0]?.['extras']).toEqual({ a: 1 });
    expect(toolCalls[1]).not.toHaveProperty('extras');
  });

  it('keeps non-empty content untouched', () => {
    const message: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'working on it' }],
      toolCalls: [{ type: 'function', id: 'c', name: 't', arguments: null }],
    };
    const converted: Record<string, unknown> = { role: 'assistant', content: 'working on it' };
    const out = call(kimiOpenAITrait.convertMessage, message, converted, context);
    expect(out).toHaveProperty('content', 'working on it');
  });

  it('embeds message-level tools', () => {
    const message: Message = {
      role: 'assistant',
      content: [],
      toolCalls: [],
      tools: [{ name: '$web_search', description: '', parameters: {} }],
    };
    const converted: Record<string, unknown> = { role: 'assistant' };
    const out = call(kimiOpenAITrait.convertMessage, message, converted, context);
    expect(out?.['tools']).toEqual([
      { type: 'builtin_function', function: { name: '$web_search' } },
    ]);
  });
});

describe('kimiOpenAITrait reasoning hooks', () => {
  it('declares reasoning_content as the reasoning field', () => {
    expect(call(kimiOpenAITrait.reasoningKey, context)).toBe('reasoning_content');
  });

  it('force-replays reasoning only in keep:all sessions with thinking enabled', () => {
    const keepAll = {
      extra_body: { thinking: { type: 'enabled', keep: 'all' } },
    };
    expect(call(kimiOpenAITrait.preserveThinking, keepAll, context)).toBe(true);

    const keepAllDisabled = {
      extra_body: { thinking: { type: 'disabled', keep: 'all' } },
    };
    expect(call(kimiOpenAITrait.preserveThinking, keepAllDisabled, context)).toBeUndefined();

    const keepSome = {
      extra_body: { thinking: { type: 'enabled', keep: 'some' } },
    };
    expect(call(kimiOpenAITrait.preserveThinking, keepSome, context)).toBeUndefined();
    expect(call(kimiOpenAITrait.preserveThinking, {}, context)).toBeUndefined();
  });
});

describe('kimiOpenAITrait.extractUsage', () => {
  it('finds usage at the top level', () => {
    const usage = { prompt_tokens: 10, completion_tokens: 2 };
    expect(call(kimiOpenAITrait.extractUsage, { usage }, context)).toBe(usage);
  });

  it('finds usage inside choices[0].usage', () => {
    const usage = { prompt_tokens: 5, completion_tokens: 1 };
    expect(call(kimiOpenAITrait.extractUsage, { choices: [{ usage }] }, context)).toBe(usage);
  });

  it('defers to the base default when the chunk carries no usage', () => {
    expect(call(kimiOpenAITrait.extractUsage, { choices: [] }, context)).toBeUndefined();
    expect(call(kimiOpenAITrait.extractUsage, { choices: [{}] }, context)).toBeUndefined();
  });
});

describe('kimiOpenAITrait request params', () => {
  it('declares the KIMI_API_KEY / KIMI_BASE_URL fallback chain and default base URL', () => {
    expect(call(kimiOpenAITrait.endpoint, context)).toEqual({
      apiKeyEnv: 'KIMI_API_KEY',
      baseUrlEnv: 'KIMI_BASE_URL',
      defaultBaseUrl: 'https://api.moonshot.ai/v1',
    });
  });

  it('encodes the cache key as prompt_cache_key', () => {
    expect(call(kimiOpenAITrait.cacheKey, 'session-1', context)).toEqual({
      prompt_cache_key: 'session-1',
    });
  });

  it('encodes thinking into extra_body.thinking, carrying keep', () => {
    expect(call(kimiOpenAITrait.withThinking, 'high', {}, {}, context)).toEqual({
      extra_body: { thinking: { type: 'enabled', effort: 'high' } },
    });
    expect(call(kimiOpenAITrait.withThinking, 'on', {}, {}, context)).toEqual({
      extra_body: { thinking: { type: 'enabled' } },
    });
    expect(call(kimiOpenAITrait.withThinking, 'off', {}, {}, context)).toEqual({
      extra_body: { thinking: { type: 'disabled' } },
    });
    expect(call(kimiOpenAITrait.withThinking, 'high', { keep: 'all' }, {}, context)).toEqual({
      extra_body: { thinking: { type: 'enabled', effort: 'high', keep: 'all' } },
    });
  });

  it('applies no 128k ceiling in withMaxCompletionTokens', () => {
    expect(call(kimiOpenAITrait.withMaxCompletionTokens, 200_000, context)).toEqual({
      max_completion_tokens: 200_000,
    });
  });

  it('buildParams backfills max_completion_tokens, drops max_tokens, expands extra_body last', () => {
    const out = call(
      kimiOpenAITrait.buildParams,
      {
        model: 'kimi-k2',
        max_tokens: 4096,
        extra_body: { thinking: { type: 'enabled', effort: 'high' }, custom_flag: true },
      },
      context,
    );
    expect(out).toEqual({
      model: 'kimi-k2',
      max_completion_tokens: 4096,
      thinking: { type: 'enabled', effort: 'high' },
      custom_flag: true,
    });
  });

  it('buildParams keeps an explicit max_completion_tokens and lets extra_body win', () => {
    const out = call(
      kimiOpenAITrait.buildParams,
      {
        max_tokens: 1024,
        max_completion_tokens: 2048,
        temperature: 0.5,
        extra_body: { temperature: 0.9 },
      },
      context,
    );
    expect(out).toEqual({ max_completion_tokens: 2048, temperature: 0.9 });
  });
});

describe('kimiAnthropicTrait (the (kimi, anthropic) registration)', () => {
  const seeded = { betaFeatures: ['interleaved-thinking-2025-05-14', 'other-beta'] };

  it('encodes thinking:{type:enabled} + output_config.effort and strips the interleaved beta', () => {
    const out = call(kimiAnthropicTrait.withThinking, 'high', {}, seeded, context);
    expect(out).toEqual({
      thinking: { type: 'enabled' },
      output_config: { effort: 'high' },
      betaFeatures: ['other-beta'],
    });
  });

  it('omits output_config for on', () => {
    expect(call(kimiAnthropicTrait.withThinking, 'on', {}, seeded, context)).toEqual({
      thinking: { type: 'enabled' },
      output_config: undefined,
      betaFeatures: ['other-beta'],
    });
  });

  it('encodes off as disabled', () => {
    expect(call(kimiAnthropicTrait.withThinking, 'off', {}, seeded, context)).toEqual({
      thinking: { type: 'disabled' },
      output_config: undefined,
      betaFeatures: ['other-beta'],
    });
  });
});

describe('trait objects are plain declarations', () => {
  it('exposes exactly the hooks appendix A assigns to them, plus metadata markers', () => {
    const hookNames = (trait: ProtocolTrait): string[] => Object.keys(trait);
    expect(hookNames(kimiOpenAITrait).toSorted()).toEqual([
      'buildParams',
      'cacheKey',
      'convertMessage',
      'convertTool',
      'endpoint',
      'extractUsage',
      'preserveThinking',
      'reasoningKey',
      'strictThinkingValidation',
      'uploadVideo',
      'withMaxCompletionTokens',
      'withThinking',
    ]);
    expect(hookNames(kimiAnthropicTrait)).toEqual(['withThinking']);
  });

  it('marks only the native-transport thinking trait as strict-validation (v1 parity)', () => {
    // Kimi's native API rejects unlisted efforts → strict; over the Anthropic
    // transport the backend may accept them → lenient (warning + pass-through).
    expect(kimiOpenAITrait.strictThinkingValidation).toBe(true);
    expect(kimiAnthropicTrait.strictThinkingValidation).toBeUndefined();
  });
});
