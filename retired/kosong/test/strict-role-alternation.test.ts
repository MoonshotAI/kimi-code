import type { Message } from '#/message';
import { AnthropicChatProvider } from '#/providers/anthropic';
import { GoogleGenAIChatProvider } from '#/providers/google-genai';
import { describe, expect, it, vi } from 'vitest';

/**
 * Conformance suite: strict providers (those whose APIs require alternating
 * user/model turns) must never emit two consecutive same-role turns, no matter
 * what valid history they are handed. The two shapes below — the post-compaction
 * history (`[kept prompts, user-role summary, injected reminders]`) and a user
 * turn steered in right after a tool result — are the realistic sources of
 * consecutive user turns. A new strict provider added without the consecutive-
 * user merge will fail here rather than 400 in production.
 */

const POST_COMPACTION_SHAPE: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'An earlier user prompt' }], toolCalls: [] },
  {
    role: 'user',
    content: [{ type: 'text', text: '<summary>Conversation so far…</summary>' }],
    toolCalls: [],
  },
  {
    role: 'user',
    content: [{ type: 'text', text: '<system-reminder>Stay on task.</system-reminder>' }],
    toolCalls: [],
  },
];

const STEER_AFTER_TOOL_RESULT: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'Add 2 and 3' }], toolCalls: [] },
  {
    role: 'assistant',
    content: [],
    toolCalls: [{ type: 'function', id: 'call_1', name: 'add', arguments: '{"a": 2, "b": 3}' }],
  },
  { role: 'tool', content: [{ type: 'text', text: '5' }], toolCallId: 'call_1', toolCalls: [] },
  { role: 'user', content: [{ type: 'text', text: 'Now multiply them instead' }], toolCalls: [] },
];

function assertNoConsecutiveSameRole(roles: readonly string[]): void {
  for (let i = 1; i < roles.length; i++) {
    expect(
      roles[i],
      `consecutive '${roles[i]}' turns at index ${i} in ${JSON.stringify(roles)}`,
    ).not.toBe(roles[i - 1]);
  }
}

/** Drives a provider with `history` and returns the wire turn roles, in order. */
type WireRoles = (history: Message[]) => Promise<string[]>;

async function anthropicWireRoles(history: Message[]): Promise<string[]> {
  const provider = new AnthropicChatProvider({
    model: 'k25',
    apiKey: 'test-key',
    defaultMaxTokens: 1024,
    stream: false,
  });
  let captured: Record<string, unknown> | undefined;
  (provider as unknown as { _client: { messages: { create: unknown } } })._client.messages.create =
    vi.fn().mockImplementation((params: Record<string, unknown>) => {
      captured = params;
      return Promise.resolve({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'k25',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });

  const stream = await provider.generate('', [], history);
  for await (const part of stream) void part;

  if (captured === undefined) throw new Error('Anthropic provider did not call messages.create');
  return (captured['messages'] as Array<{ role: string }>).map((m) => m.role);
}

async function googleWireRoles(history: Message[]): Promise<string[]> {
  const provider = new GoogleGenAIChatProvider({
    model: 'gemini-2.5-flash',
    apiKey: 'test-key',
    stream: false,
  });
  let captured: Record<string, unknown> | undefined;
  const response = {
    candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    modelVersion: 'gemini-2.5-flash',
  };
  async function* stream() {
    yield response;
  }
  const models = (provider as unknown as { _client: { models: Record<string, unknown> } })._client
    .models;
  models['generateContent'] = vi.fn().mockImplementation((params: Record<string, unknown>) => {
    captured = params;
    return Promise.resolve(response);
  });
  models['generateContentStream'] = vi
    .fn()
    .mockImplementation((params: Record<string, unknown>) => {
      captured = params;
      return Promise.resolve(stream());
    });

  const generated = await provider.generate('', [], history);
  for await (const part of generated) void part;

  if (captured === undefined) throw new Error('Google provider did not call a model endpoint');
  return (captured['contents'] as Array<{ role: string }>).map((c) => c.role);
}

const STRICT_PROVIDERS: ReadonlyArray<{ name: string; wireRoles: WireRoles }> = [
  { name: 'anthropic', wireRoles: anthropicWireRoles },
  { name: 'google-genai', wireRoles: googleWireRoles },
];

describe('strict provider role alternation', () => {
  for (const { name, wireRoles } of STRICT_PROVIDERS) {
    describe(name, () => {
      it('collapses the post-compaction shape into alternating turns', async () => {
        assertNoConsecutiveSameRole(await wireRoles(POST_COMPACTION_SHAPE));
      });

      it('stays alternating when a user turn is steered in after a tool result', async () => {
        assertNoConsecutiveSameRole(await wireRoles(STEER_AFTER_TOOL_RESULT));
      });
    });
  }
});
