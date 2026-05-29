import { describe, expect, it, vi } from 'vitest';
import { testAgent } from '../harness/agent';

const CATALOGUED_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'kimi-code',
} as const;
const CATALOGUED_MODEL_CAPABILITIES = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;

describe('MicroCompaction', () => {
  it('truncates old tool results after cache miss', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 4,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * 60 * 1000,
      },
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    expect(ctx.agent.context.messages).toHaveLength(9);

    vi.setSystemTime(61 * 60 * 1000);

    const messages = ctx.agent.context.messages;
    const marker = '[Old tool result content cleared]';

    expect(messages[2]).toMatchObject({
      role: 'tool',
      content: [{ type: 'text', text: marker }],
    });
    expect(messages[5]).toMatchObject({
      role: 'tool',
      content: [{ type: 'text', text: 'lookup result' }],
    });
    expect(messages[8]).toMatchObject({
      role: 'tool',
      content: [{ type: 'text', text: 'lookup result' }],
    });
  });

  it('does nothing before cache miss threshold', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 4,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * 60 * 1000,
      },
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    vi.setSystemTime(30 * 60 * 1000);

    const messages = ctx.agent.context.messages;
    expect(messages.every((m) => m.role !== 'tool' || (m.content[0] as { text: string })?.text !== '[Old tool result content cleared]')).toBe(true);
  });

  it('persists cutoff across calls until cache miss resets it', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 2,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * 60 * 1000,
      },
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    vi.setSystemTime(61 * 60 * 1000);

    const first = ctx.agent.context.messages;
    expect(first[2]).toMatchObject({
      role: 'tool',
      content: [{ type: 'text', text: '[Old tool result content cleared]' }],
    });

    vi.setSystemTime(62 * 60 * 1000);

    const second = ctx.agent.context.messages;
    expect(second[2]).toMatchObject({
      role: 'tool',
      content: [{ type: 'text', text: '[Old tool result content cleared]' }],
    });
  });

  it('clears cutoff on reset', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 4,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * 60 * 1000,
      },
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    vi.setSystemTime(61 * 60 * 1000);

    ctx.agent.microCompaction.reset();

    const messages = ctx.agent.context.messages;
    expect(messages.every((m) => m.role !== 'tool' || (m.content[0] as { text: string })?.text !== '[Old tool result content cleared]')).toBe(true);
  });

  it('skips tool results below minContentTokens', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 2,
        minContentTokens: 100,
        cacheMissedThresholdMs: 60 * 60 * 1000,
      },
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    vi.setSystemTime(61 * 60 * 1000);

    const messages = ctx.agent.context.messages;
    expect(
      messages.every(
        (m) => m.role !== 'tool' || (m.content[0] as { text: string })?.text !== '[Old tool result content cleared]',
      ),
    ).toBe(true);
  });

  it('skips non-tool messages', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 2,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * 60 * 1000,
      },
    });

    vi.setSystemTime(0);
    ctx.appendExchange(1, 'user one', 'assistant one', 10);
    ctx.appendExchange(2, 'user two', 'assistant two', 10);
    ctx.appendExchange(3, 'user three', 'assistant three', 10);

    vi.setSystemTime(61 * 60 * 1000);

    const messages = ctx.agent.context.messages;
    expect(messages.every((m) => m.role === 'user' || m.role === 'assistant')).toBe(true);
    expect(
      messages.every(
        (m) => m.role !== 'tool' || (m.content[0] as { text: string })?.text !== '[Old tool result content cleared]',
      ),
    ).toBe(true);
  });

  it('clears cutoff on context clear', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 2,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * 60 * 1000,
      },
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    vi.setSystemTime(61 * 60 * 1000);

    ctx.agent.context.clear();

    expect(ctx.agent.context.messages).toHaveLength(0);
    expect(ctx.agent.context.lastAssistantAt).toBe(0);
  });

  it('clears cutoff on full compaction', async () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 2,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * 60 * 1000,
      },
    });
    ctx.configure({
      provider: CATALOGUED_PROVIDER,
      modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
    });

    vi.setSystemTime(0);
    ctx.appendExchange(1, 'old user', 'old assistant', 20);
    ctx.appendExchange(2, 'recent user', 'recent assistant', 80);

    vi.setSystemTime(61 * 60 * 1000);

    const compacted = ctx.once('context.apply_compaction');
    ctx.mockNextResponse({ type: 'text', text: 'Summary.' });
    await ctx.rpc.beginCompaction({});
    await compacted;

    expect(ctx.agent.context.messages).toHaveLength(1);
    expect(ctx.agent.context.messages[0]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'Summary.' }],
    });
  });

  it('does not truncate when messages are fewer than keepRecentMessages', () => {
    vi.useFakeTimers();
    const ctx = testAgent({
      microCompaction: {
        keepRecentMessages: 20,
        minContentTokens: 1,
        cacheMissedThresholdMs: 60 * 60 * 1000,
      },
    });

    vi.setSystemTime(0);
    ctx.appendToolExchange();
    ctx.appendToolExchange();

    vi.setSystemTime(61 * 60 * 1000);

    const messages = ctx.agent.context.messages;
    expect(
      messages.every(
        (m) => m.role !== 'tool' || (m.content[0] as { text: string })?.text !== '[Old tool result content cleared]',
      ),
    ).toBe(true);
  });
});
