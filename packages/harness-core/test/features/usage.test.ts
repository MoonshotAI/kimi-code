import { describe, expect, it } from 'vitest';

import { createFeature } from '@moonshot-ai/agent-core/app/index';
import { createUserEntry } from '@moonshot-ai/agent-core/history/index';
import { useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import { createAssistantMessage, createUserMessage, type ToolCall } from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome, TokenUsage } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';

import { usage, UsageRef, type UsageFace } from '#/features/usage/index';
import { createHarness, harnessInternals, memoryHarnessSpace, useAgentTools, type Harness } from '#/runtime/index';

type GenerateRest = Parameters<LoopLlmRequester['generate']>[0];

function usageOutcome(text: string, usage: TokenUsage, toolCalls: ToolCall[] = []): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls), usage };
}

function scriptedRequester(next: (rest: GenerateRest) => LlmOutcome | Promise<LlmOutcome>): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (rest, _control) => next(rest),
  };
  return self;
}

function user(text: string) {
  return createUserEntry(createUserMessage(text), { source: 'input' });
}

function setRequester(harness: Harness, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime = session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

const USAGE_A: TokenUsage = { inputOther: 100, output: 10, inputCacheRead: 5, inputCacheCreation: 2 };
const USAGE_B: TokenUsage = { inputOther: 50, output: 5, inputCacheRead: 0, inputCacheCreation: 0 };
const USAGE_C: TokenUsage = { inputOther: 20, output: 3, inputCacheRead: 7, inputCacheCreation: 1 };

const SUM_AB: TokenUsage = { inputOther: 150, output: 15, inputCacheRead: 5, inputCacheCreation: 2 };
const SUM_ABC: TokenUsage = { inputOther: 170, output: 18, inputCacheRead: 12, inputCacheCreation: 3 };

describe('usage feature', () => {
  it('accumulates assistant usage across steps and turns', async () => {
    let face: Readonly<ShallowRef<UsageFace | undefined>> | undefined;
    const probe = createFeature('usage-probe', {
      agent: () => {
        useAgentTools({
          name: 'probe_tool',
          description: 'probe',
          parameters: { type: 'object' },
          execute: async () => ({ content: [{ type: 'text', text: 'tool-output' }] }),
        });
        face = useInject(UsageRef);
      },
    });
    const harness = createHarness({ space: memoryHarnessSpace() });
    await harness.app.features.add(usage);
    await harness.app.features.add(probe);
    const session = await harness.app.create({ sessionId: 's1' });
    const agent = await harness.ensureAgent(session, 'main');
    let calls = 0;
    setRequester(
      harness,
      's1',
      'main',
      scriptedRequester(() => {
        calls += 1;
        if (calls === 1) {
          return usageOutcome('calling', USAGE_A, [{ type: 'function', id: 'c1', name: 'probe_tool', arguments: '{}' }]);
        }
        if (calls === 2) return usageOutcome('done', USAGE_B);
        return usageOutcome('again', USAGE_C);
      }),
    );

    expect(face?.value?.usage.value).toEqual({ inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 });
    expect(face?.value?.total.value).toBe(0);

    await agent.loop.runTurn(user('go'));
    await agent.flush();
    expect(calls).toBe(2);
    expect(face?.value?.usage.value).toEqual(SUM_AB);
    expect(face?.value?.total.value).toBe(172);

    await agent.loop.runTurn(user('more'));
    await agent.flush();
    expect(calls).toBe(3);
    expect(face?.value?.usage.value).toEqual(SUM_ABC);
    expect(face?.value?.total.value).toBe(203);
    await harness.close();
  });

  it('restores accumulated usage when the agent reopens', async () => {
    let face: Readonly<ShallowRef<UsageFace | undefined>> | undefined;
    const probe = createFeature('usage-probe', {
      agent: () => {
        face = useInject(UsageRef);
      },
    });
    const space = memoryHarnessSpace();
    const harness = createHarness({ space });
    await harness.app.features.add(usage);
    await harness.app.features.add(probe);
    const session = await harness.app.create({ sessionId: 's1' });
    const agent = await harness.ensureAgent(session, 'main');
    let calls = 0;
    setRequester(
      harness,
      's1',
      'main',
      scriptedRequester(() => {
        calls += 1;
        return usageOutcome('ok', calls === 1 ? USAGE_A : USAGE_B);
      }),
    );
    await agent.loop.runTurn(user('one'));
    await agent.loop.runTurn(user('two'));
    await agent.flush();
    expect(face?.value?.usage.value).toEqual(SUM_AB);

    await harness.app.close('s1');
    const resumed = await harness.app.create({ sessionId: 's1' });
    await harness.ensureAgent(resumed, 'main');
    expect(face?.value?.usage.value).toEqual(SUM_AB);
    expect(face?.value?.total.value).toBe(172);
    await harness.close();
  });
});
