// Anthropic-compliance smoke tests for compaction.
//
// Anthropic (and strict Anthropic-compatible backends) reject a request unless
// roles strictly alternate user/assistant AND every assistant `tool_use` is
// answered by a matching `tool_result` in the immediately following message.
// Compaction's output and its summarizer request must satisfy both — but the
// guarantee spans two layers: the projector merges only `origin.kind === 'user'`
// messages, so the user-role summary, skill/plugin activations, and injected
// reminders stay as CONSECUTIVE user messages in the projected output, and it is
// the Anthropic provider's own consecutive-user merge that finally collapses
// them. Tool pairing likewise depends on the projector's adjacency repair and
// (for the summarizer request) synthetic results for still-open calls.
//
// These tests drive the real compaction/projection functions, run their output
// through the real AnthropicChatProvider conversion, and assert the wire request
// is well-formed — so a regression in any single layer turns red here.
import { createProvider } from '@moonshot-ai/kosong';
import type { Message, Tool } from '@moonshot-ai/kosong';
import { describe, expect, it, vi } from 'vitest';

import type { ContextMessage } from '../../../src/agent/context';
import { testAgent } from '../harness/agent';

const PROVIDER = { type: 'kimi', apiKey: 'test-key', model: 'kimi-code' } as const;
const CAPS = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;

type WireBlock = { type: string; id?: string; tool_use_id?: string; text?: string };
type WireMessage = { role: string; content: WireBlock[] };

function makeAnthropicResponse() {
  return {
    id: 'msg_test_smoke',
    type: 'message',
    role: 'assistant',
    model: 'k25',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

/**
 * Convert a projected `Message[]` through the real Anthropic provider and return
 * the wire `messages` it would POST — mirroring kosong's own captureRequestBody.
 */
async function toAnthropicWire(history: Message[], tools: Tool[] = []): Promise<WireMessage[]> {
  const provider = createProvider({
    type: 'anthropic',
    model: 'k25',
    apiKey: 'test-key',
    defaultMaxTokens: 1024,
    stream: false,
  });
  let captured: { messages?: WireMessage[] } | undefined;
  (provider as unknown as { _client: { messages: { create: unknown } } })._client.messages.create =
    vi.fn().mockImplementation((params: unknown) => {
      captured = params as { messages?: WireMessage[] };
      return Promise.resolve(makeAnthropicResponse());
    });

  const stream = await provider.generate('', tools, history);
  for await (const part of stream) {
    void part;
  }
  if (captured?.messages === undefined) {
    throw new Error('Expected provider.generate() to call messages.create with messages');
  }
  return captured.messages;
}

/** Assert the wire request satisfies Anthropic's alternation + tool-pairing rules. */
function assertValidAnthropic(messages: WireMessage[]): void {
  expect(messages.length).toBeGreaterThan(0);
  expect(messages[0]!.role).toBe('user');

  for (let i = 1; i < messages.length; i++) {
    expect(
      messages[i]!.role,
      `roles must alternate, but messages[${String(i - 1)}] and [${String(i)}] are both ${messages[i]!.role}`,
    ).not.toBe(messages[i - 1]!.role);
  }

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        expect(message.role, 'tool_use must be on an assistant message').toBe('assistant');
        const next = messages[i + 1];
        const answered =
          next?.content.some((b) => b.type === 'tool_result' && b.tool_use_id === block.id) ?? false;
        expect(answered, `tool_use ${String(block.id)} must be answered in the next message`).toBe(
          true,
        );
      }
      if (block.type === 'tool_result') {
        expect(message.role, 'tool_result must be on a user message').toBe('user');
        const prev = messages[i - 1];
        const hasUse =
          prev?.content.some((b) => b.type === 'tool_use' && b.id === block.tool_use_id) ?? false;
        expect(
          hasUse,
          `tool_result ${String(block.tool_use_id)} must immediately follow its tool_use`,
        ).toBe(true);
      }
    }
  }
}

const BASH_TOOL: Tool = {
  name: 'Bash',
  description: 'Run a shell command',
  parameters: { type: 'object', properties: { command: { type: 'string' } } },
};

describe('compaction — Anthropic wire compliance', () => {
  it('post-compaction context plus a follow-up tool turn is a valid Anthropic request', async () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    // A couple of real user prompts so some survive compaction verbatim.
    ctx.appendExchange(1, 'first request', 'assistant one', 40);
    ctx.appendExchange(2, 'second request', 'assistant two', 40);

    ctx.agent.context.applyCompaction({
      summary: 'Working summary.',
      compactedCount: ctx.agent.context.history.length,
      tokensBefore: 100,
    });
    // A follow-up turn that calls a tool, appended after the summary.
    ctx.appendToolExchange();

    const wire = await toAnthropicWire(ctx.agent.context.messages, [BASH_TOOL]);
    // [merged kept users + summary + new user] -> one user; then assistant
    // tool_use; then user tool_result.
    assertValidAnthropic(wire);
    expect(wire.some((m) => m.content.some((b) => b.type === 'tool_use'))).toBe(true);
    expect(wire.some((m) => m.content.some((b) => b.type === 'tool_result'))).toBe(true);
  });

  it('collapses mixed-origin kept users and the summary into a single Anthropic user turn', async () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    // Genuine user input the projector merges, plus a user-slash skill activation
    // it does NOT merge (different origin) — both kept by compaction.
    ctx.agent.context.appendUserMessage([{ type: 'text', text: 'real prompt' }], { kind: 'user' });
    ctx.agent.context.appendUserMessage([{ type: 'text', text: '/do-thing' }], {
      kind: 'skill_activation',
      activationId: 'a1',
      skillName: 'do-thing',
      trigger: 'user-slash',
    });

    ctx.agent.context.applyCompaction({
      summary: 'Working summary.',
      compactedCount: ctx.agent.context.history.length,
      tokensBefore: 100,
    });

    // Projected output still has consecutive user messages (skill + summary are
    // not merged by the projector); only the Anthropic merge collapses them.
    const projected = ctx.agent.context.messages;
    expect(projected.filter((m) => m.role === 'user').length).toBeGreaterThan(1);

    const wire = await toAnthropicWire(projected);
    assertValidAnthropic(wire);
    expect(wire).toHaveLength(1);
    expect(wire[0]!.role).toBe('user');
  });

  it('keeps the request valid across repeated compactions', async () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    ctx.appendExchange(1, 'first request', 'assistant one', 40);
    ctx.agent.context.applyCompaction({
      summary: 'First summary.',
      compactedCount: ctx.agent.context.history.length,
      tokensBefore: 100,
    });
    ctx.appendExchange(2, 'second request', 'assistant two', 40);
    ctx.agent.context.applyCompaction({
      summary: 'Second summary.',
      compactedCount: ctx.agent.context.history.length,
      tokensBefore: 100,
    });
    ctx.appendToolExchange();

    const wire = await toAnthropicWire(ctx.agent.context.messages, [BASH_TOOL]);
    assertValidAnthropic(wire);
  });

  it('produces a valid summarizer request when a tool result is non-adjacent to its call', async () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    // A background-task notification (user role) landed between the tool call and
    // its result, so they are non-adjacent in history.
    const messy: ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'run it' }], toolCalls: [], origin: { kind: 'user' } },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'calling' }],
        toolCalls: [{ type: 'function', id: 'call_1', name: 'Bash', arguments: '{"command":"ls"}' }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'background task finished' }],
        toolCalls: [],
        origin: { kind: 'background_task', taskId: 't', status: 'completed', notificationId: 'n' },
      },
      { role: 'tool', content: [{ type: 'text', text: 'a.ts b.ts' }], toolCalls: [], toolCallId: 'call_1' },
    ];

    // Mirrors FullCompaction's summarizer projection.
    const projected = ctx.agent.context.project(messy, { synthesizeMissing: true });
    const wire = await toAnthropicWire(projected, [BASH_TOOL]);
    assertValidAnthropic(wire);
  });

  it('closes a mid-history tool call whose result is missing on the normal send path', async () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    // 'call_1' was issued but its result was never recorded; a later real turn
    // ('call_2' + result) proves it is not in-flight. On a strict provider this
    // bricks the session — every normal send re-rejects. The projector closes the
    // mid-history orphan WITHOUT synthesizeMissing (the normal send path).
    const orphaned: ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'run it' }], toolCalls: [], origin: { kind: 'user' } },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'first call' }],
        toolCalls: [{ type: 'function', id: 'call_1', name: 'Bash', arguments: '{}' }],
      },
      { role: 'user', content: [{ type: 'text', text: 'next thing' }], toolCalls: [], origin: { kind: 'user' } },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'second call' }],
        toolCalls: [{ type: 'function', id: 'call_2', name: 'Bash', arguments: '{}' }],
      },
      { role: 'tool', content: [{ type: 'text', text: 'done' }], toolCalls: [], toolCallId: 'call_2' },
    ];

    // Normal send path: no synthesizeMissing, no dropOrphanResults.
    const projected = ctx.agent.context.project(orphaned);
    const wire = await toAnthropicWire(projected, [BASH_TOOL]);
    assertValidAnthropic(wire);
    // The mid-history orphan 'call_1' is closed by a synthetic tool_result.
    const call1Index = wire.findIndex((m) =>
      m.content.some((b) => b.type === 'tool_use' && b.id === 'call_1'),
    );
    expect(call1Index).toBeGreaterThanOrEqual(0);
    expect(
      wire[call1Index + 1]!.content.some(
        (b) => b.type === 'tool_result' && b.tool_use_id === 'call_1',
      ),
    ).toBe(true);
  });

  it('drops a stray tool result with no matching call on the strict resend path', async () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    // A tool_result whose tool_use is gone (e.g. an undo removed the assistant).
    // The normal path leaves it (it has no anchor); the strict resend drops it.
    const stray: ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [], origin: { kind: 'user' } },
      { role: 'tool', content: [{ type: 'text', text: 'orphan output' }], toolCalls: [], toolCallId: 'gone' },
    ];

    const projected = ctx.agent.context.project(stray, {
      synthesizeMissing: true,
      dropOrphanResults: true,
    });
    expect(projected.some((m) => m.role === 'tool')).toBe(false);
    const wire = await toAnthropicWire(projected);
    assertValidAnthropic(wire);
  });

  it('closes a still-open tool call in the summarizer request with a synthetic result', async () => {
    const ctx = testAgent();
    ctx.configure({ provider: PROVIDER, modelCapabilities: CAPS });
    // History ends on an assistant tool call whose result never arrived (sliced
    // out by overflow shrink, or interrupted) — a dangling tool_use.
    const dangling: ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'do it' }], toolCalls: [], origin: { kind: 'user' } },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'calling' }],
        toolCalls: [{ type: 'function', id: 'call_x', name: 'Bash', arguments: '{}' }],
      },
    ];

    const projected = ctx.agent.context.project(dangling, { synthesizeMissing: true });
    const wire = await toAnthropicWire(projected, [BASH_TOOL]);
    assertValidAnthropic(wire);
    // The dangling call is closed by a synthetic tool_result.
    const lastUser = wire.at(-1)!;
    expect(lastUser.role).toBe('user');
    expect(lastUser.content.some((b) => b.type === 'tool_result' && b.tool_use_id === 'call_x')).toBe(
      true,
    );
  });
});
