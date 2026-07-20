/**
 * Scenario: OpenAI-compatible (chat completions) thinking effort encoding.
 * Responsibilities: encode withThinking onto the wire, keep an explicit 'off'
 * distinct from "never configured", and report the accurate effort.
 * Wiring: real v2 OpenAILegacy adapter with only the remote SDK client boundary
 * replaced by mocks.
 * Run: pnpm exec vitest run packages/agent-core-v2/test/app/llmProtocol/providers/openai-legacy.test.ts
 */
import type { Message } from '#/app/llmProtocol/message';
import { OpenAILegacyChatProvider } from '#/app/llmProtocol/providers/openai-legacy';
import { describe, expect, it, vi } from 'vitest';

const USER_TURN: Message = {
  role: 'user',
  content: [{ type: 'text', text: 'Think' }],
  toolCalls: [],
};

const THINK_HISTORY: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'Hello' }], toolCalls: [] },
  {
    role: 'assistant',
    content: [
      { type: 'think', think: 'Thinking...' },
      { type: 'text', text: 'Hi!' },
    ],
    toolCalls: [],
  },
  { role: 'user', content: [{ type: 'text', text: 'How are you?' }], toolCalls: [] },
];

function createProvider(model = 'gpt-4.1'): OpenAILegacyChatProvider {
  return new OpenAILegacyChatProvider({
    model,
    apiKey: 'test-key',
    stream: false,
  });
}

function makeChatCompletionResponse(model = 'test-model') {
  return {
    id: 'chatcmpl-test123',
    object: 'chat.completion',
    created: 1234567890,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

async function captureRequestBody(
  provider: OpenAILegacyChatProvider,
  history: Message[],
): Promise<Record<string, unknown>> {
  let capturedBody: Record<string, unknown> | undefined;
  (
    provider as unknown as { _client: { chat: { completions: { create: unknown } } } }
  )._client.chat.completions.create = vi.fn().mockImplementation((params: unknown) => {
    capturedBody = params as Record<string, unknown>;
    return Promise.resolve(makeChatCompletionResponse());
  });

  const stream = await provider.generate('', [], history);
  for await (const part of stream) void part;

  if (capturedBody === undefined) {
    throw new Error('Expected provider.generate() to call chat.completions.create');
  }
  return capturedBody;
}

describe('OpenAILegacyChatProvider withThinking', () => {
  it('passes a concrete effort through verbatim and reports it', async () => {
    const provider = createProvider().withThinking('high');

    const body = await captureRequestBody(provider, [USER_TURN]);
    expect(body['reasoning_effort']).toBe('high');
    expect(provider.thinkingEffort).toBe('high');
  });

  it('reports a null thinkingEffort until withThinking is called', () => {
    expect(createProvider().thinkingEffort).toBeNull();
  });

  it('sends no reasoning_effort for "on" without ThinkPart history and reports "on"', async () => {
    const provider = createProvider().withThinking('on');

    const body = await captureRequestBody(provider, [USER_TURN]);
    expect(body['reasoning_effort']).toBeUndefined();
    expect(provider.thinkingEffort).toBe('on');
  });

  it('sends no reasoning_effort for "off" and reports "off"', async () => {
    const provider = createProvider().withThinking('off');

    const body = await captureRequestBody(provider, [USER_TURN]);
    expect(body['reasoning_effort']).toBeUndefined();
    expect(provider.thinkingEffort).toBe('off');
  });

  it('clears a concrete effort set earlier when turned off', async () => {
    const provider = createProvider().withThinking('high').withThinking('off');
    expect(provider.thinkingEffort).toBe('off');

    const body = await captureRequestBody(provider, [USER_TURN]);
    expect(body['reasoning_effort']).toBeUndefined();
  });

  it('auto-injects reasoning_effort when ThinkPart history exists and thinking is unconfigured', async () => {
    // Issue #1616: strict OpenAI-compatible gateways require a paired
    // reasoning_effort when the history carries reasoning_content.
    const body = await captureRequestBody(createProvider(), THINK_HISTORY);
    expect(body['reasoning_effort']).toBe('medium');
  });

  it('still auto-injects reasoning_effort for an explicit "on"', async () => {
    const body = await captureRequestBody(createProvider().withThinking('on'), THINK_HISTORY);
    expect(body['reasoning_effort']).toBe('medium');
  });

  it('does not auto-inject reasoning_effort when thinking was explicitly turned off', async () => {
    // An explicit withThinking('off') is not "never configured": with thinking
    // off, the auto-enable must not switch reasoning back on (or leak the field
    // to models that reject it).
    const provider = createProvider().withThinking('off');

    const body = await captureRequestBody(provider, THINK_HISTORY);
    expect(body['reasoning_effort']).toBeUndefined();
    expect(provider.thinkingEffort).toBe('off');
  });

  it('does not overwrite reasoning_effort pinned via withGenerationKwargs', async () => {
    const provider = createProvider().withGenerationKwargs({ reasoning_effort: 'high' });

    const body = await captureRequestBody(provider, THINK_HISTORY);
    expect(body['reasoning_effort']).toBe('high');
  });
});
