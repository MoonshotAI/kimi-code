import { emptyUsage } from '@moonshot-ai/kosong';
import type { StreamedMessagePart } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { ProviderManager } from '../../../src/session/provider-manager';
import { ILLMRequester } from '../../../src/services/agent';
import { testAgent } from './harness';

describe('LLMRequester service migration coverage', () => {
  it('preserves indexed tool-call deltas through LoopService protocol events', async () => {
    const ctx = testAgent();
    ctx.configure({ tools: ['Lookup'] });
    await ctx.rpc.setPermission({ mode: 'auto' });
    await ctx.rpc.registerTool({
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    });

    ctx.mockNextProviderResponse({
      parts: [
        { type: 'tool_call_part', argumentsPart: '{"query"', index: 0 },
        {
          type: 'function',
          id: 'call_lookup',
          name: 'Lookup',
          arguments: null,
          _streamIndex: 0,
        },
        { type: 'tool_call_part', argumentsPart: ':"moon"}', index: 0 },
      ],
      finishReason: 'tool_calls',
    });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });

    await ctx.untilToolCall({
      content: 'moon-result',
      output: 'moon-result',
    });

    expect(protocolEvents(ctx, 'tool.call.delta').map((event) => event.args)).toEqual([
      { turnId: 0, toolCallId: 'call_lookup', name: 'Lookup', argumentsPart: undefined },
      { turnId: 0, toolCallId: 'call_lookup', name: 'Lookup', argumentsPart: '{"query"' },
      { turnId: 0, toolCallId: 'call_lookup', name: 'Lookup', argumentsPart: ':"moon"}' },
    ]);
    expect(protocolEvents(ctx, 'toolCall').at(-1)?.args).toEqual({
      turnId: 0,
      toolCallId: 'call_lookup',
      args: { query: 'moon' },
    });

    ctx.mockNextResponse({ type: 'text', text: 'The lookup result is moon-result.' });
    await ctx.untilTurnEnd();
  });

  it('emits stream timing and applies the model output budget through ILLMRequester', async () => {
    let requestMaxTokens: unknown;
    const ctx = testAgent({
      generate: async (provider, _systemPrompt, _tools, _messages, callbacks, options) => {
        requestMaxTokens = (
          provider as unknown as { readonly modelParameters: Record<string, unknown> }
        ).modelParameters['max_tokens'];
        options?.onRequestStart?.();
        await callbacks?.onMessagePart?.({ type: 'text', text: 'timed' });
        options?.onStreamEnd?.();
        return {
          id: 'response-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'timed' }],
            toolCalls: [],
          },
          usage: emptyUsage(),
          finishReason: 'completed',
          rawFinishReason: 'stop',
        };
      },
      providerManager: new ProviderManager({
        config: {
          providers: {
            deepseek: {
              type: 'openai',
              apiKey: 'test-key',
              baseUrl: 'https://api.deepseek.example/v1',
            },
          },
          models: {
            'deepseek/deepseek-v4-flash': {
              provider: 'deepseek',
              model: 'deepseek-v4-flash',
              maxContextSize: 1_000_000,
              maxOutputSize: 384_000,
            },
          },
        },
      }),
    });
    ctx.profile.update({
      modelAlias: 'deepseek/deepseek-v4-flash',
      systemPrompt: 'system',
      thinkingLevel: 'off',
    });

    const events = await collectLLMEvents(ctx.get(ILLMRequester).request());

    expect(requestMaxTokens).toBe(384_000);
    expect(events).toContainEqual({ type: 'part', part: { type: 'text', text: 'timed' } });
    expect(events).toContainEqual({
      type: 'usage',
      usage: emptyUsage(),
      model: 'deepseek/deepseek-v4-flash',
    });
    expect(events).toContainEqual({
      type: 'finish',
      providerFinishReason: 'completed',
      rawFinishReason: 'stop',
    });
    expect(events).toContainEqual({
      type: 'timing',
      firstTokenLatencyMs: expect.any(Number),
      streamDurationMs: expect.any(Number),
    });
  });
});

type ProtocolEvent = Extract<
  ReturnType<typeof testAgent>['allEvents'][number],
  { readonly type: '[rpc]' }
>;

function protocolEvents(
  ctx: ReturnType<typeof testAgent>,
  eventName: string,
): readonly ProtocolEvent[] {
  return ctx.allEvents.filter(
    (event): event is ProtocolEvent => event.type === '[rpc]' && event.event === eventName,
  );
}

async function collectLLMEvents(
  stream: AsyncIterable<
    | { readonly type: 'part'; readonly part: StreamedMessagePart }
    | { readonly type: 'usage'; readonly usage: ReturnType<typeof emptyUsage>; readonly model?: string }
    | {
        readonly type: 'finish';
        readonly providerFinishReason?: string;
        readonly rawFinishReason?: string;
      }
    | {
        readonly type: 'timing';
        readonly firstTokenLatencyMs: number;
        readonly streamDurationMs: number;
      }
  >,
) {
  const events: unknown[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}
