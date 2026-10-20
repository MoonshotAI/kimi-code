import { describe, expect, it } from 'vitest';

import { createFeature } from '@moonshot-ai/agent-core/app/index';
import { useInject } from '@moonshot-ai/agent-core/kernel/index';
import {
  createAssistantEntry,
  createToolEntry,
  createUserEntry,
  type AssistantMeta,
  type HistoryMessage,
} from '@moonshot-ai/agent-core/history/index';
import {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
  extractText,
  type TokenUsage,
} from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';

import { createConfig } from '#/features/config/index';
import { createHarness, harnessInternals, memoryHarnessSpace } from '#/runtime/index';
import {
  DEFAULT_TOKEN_COUNTING_CONFIG,
  get,
  latestMeasured,
  requestSize,
  statusSize,
  TOKEN_COUNTING_SECTION,
  TOKEN_COUNTING_STRATEGY_ENV,
  tokenCounting,
  TokenCountingRef,
} from '#/features/tokenCounting/index';

function usage(inputOther: number, output: number): TokenUsage {
  return { inputOther, output, inputCacheRead: 0, inputCacheCreation: 0 };
}

function userEntry(text: string): HistoryMessage {
  return createUserEntry(createUserMessage(text));
}

function assistantEntry(text: string, usageValue?: TokenUsage): HistoryMessage {
  return createAssistantEntry(createAssistantMessage([{ type: 'text', text }]), {
    usage: usageValue,
  } as AssistantMeta);
}

function toolEntry(text: string): HistoryMessage {
  return createToolEntry(createToolMessage('call-1', text));
}

const anchored: HistoryMessage[] = [
  userEntry('one'),
  assistantEntry('first', usage(100, 50)),
  userEntry('two'),
  toolEntry('result'),
  assistantEntry('later'),
];

function scriptedRequester(outcome: () => LlmOutcome): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async () => outcome(),
  };
  return self;
}

describe('tokenCounting primitives', () => {
  it('computes anchored, measured and estimated sizes', () => {
    expect(latestMeasured(anchored)).toBe(150);
    const whole = get(anchored);
    expect(whole.measured).toBe(150);
    expect(whole.size).toBeGreaterThan(150);
    expect(get(anchored, 2).measured).toBe(0);
    expect(get(anchored, 2).estimated).toBeGreaterThan(0);
    expect(statusSize(anchored, 'measured')).toBe(150);
    expect(statusSize(anchored, 'estimated')).toBeGreaterThan(0);
    expect(statusSize(anchored, DEFAULT_TOKEN_COUNTING_CONFIG.strategy)).toBeGreaterThanOrEqual(150);
    expect(
      requestSize({ systemPrompt: 'sys', tools: [], messages: [createUserMessage('hello')] }),
    ).toBeGreaterThan(0);
  });
});

describe('tokenCounting feature', () => {
  it('exposes facade and refreshes status after a turn', async () => {
    let face: { status: { value: number } } | undefined;
    const probe = createFeature('probe', {
      agent: () => {
        const ref = useInject(TokenCountingRef);
        face = { get status() { return { get value() { return ref.value?.status.value ?? -1; } }; } };
      },
    });
    const harness = createHarness({ space: memoryHarnessSpace() });
    await harness.app.features.add(createConfig({}));
    await harness.app.features.add(tokenCounting);
    await harness.app.features.add(probe);
    const session = await harness.app.create({ sessionId: 's1' });
    const agent = await harness.ensureAgent(session, 'main', { systemPrompt: 'HOST' });
    const runtime = harnessInternals(harness.app).agents.get(session)?.get('main');
    if (runtime === undefined) throw new Error('runtime missing');
    runtime.requester = scriptedRequester(() => ({
      type: 'done',
      message: createAssistantMessage([{ type: 'text', text: 'hi' }]),
      usage: usage(120, 30),
    }));
    expect(face?.status.value).toBe(0);
    const outcome = await agent.loop.runTurn(createUserEntry(createUserMessage('go'), { source: 'input' }));
    expect(outcome.type).toBe('done');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(face?.status.value).toBe(150);
    await harness.close();
  });

  it('honors the strategy config section', () => {
    expect(TOKEN_COUNTING_SECTION).toBe('tokenCounting');
    expect(TOKEN_COUNTING_STRATEGY_ENV).toBe('KIMI_TOKEN_COUNTING_STRATEGY');
    expect(statusSize(anchored, 'measured')).toBe(150);
    expect(extractText(anchored[0]!.message)).toBe('one');
  });
});
