import { describe, expect, it } from 'vitest';

import { createFeature } from '@moonshot-ai/agent-core/app/index';
import { createUserEntry, type UserMeta } from '@moonshot-ai/agent-core/history/index';
import { useInject, type ShallowRef } from '@moonshot-ai/agent-core/kernel/index';
import { createAssistantMessage, createUserMessage } from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';

import { timing, TimingRef, type TimingFace } from '#/features/timing/index';
import { createHarness, harnessInternals, memoryHarnessSpace, type Harness } from '#/runtime/harness';

function user(text: string, meta: UserMeta = {}) {
  return createUserEntry(createUserMessage(text), { source: 'input', ...meta });
}

function setRequester(harness: Harness, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime =
    session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

function timedRequester(streamed: boolean): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (_rest, control) => {
      control.onEvent?.({ type: 'llm.started' });
      if (streamed) {
        control.onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: 'hello' } });
        control.onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: ' world' } });
      }
      return { type: 'done', message: createAssistantMessage([{ type: 'text', text: 'hello world' }]) };
    },
  };
  return self;
}

describe('timing feature', () => {
  it('exposes llm request timing after a streamed turn', async () => {
    let face: Readonly<ShallowRef<TimingFace | undefined>> | undefined;
    const probe = createFeature('timing-probe', {
      agent: () => {
        face = useInject(TimingRef);
      },
    });
    const harness = createHarness({ space: memoryHarnessSpace() });
    await harness.app.features.add(timing);
    await harness.app.features.add(probe);
    const session = await harness.app.create({ sessionId: 's1' });
    const agent = await harness.ensureAgent(session, 'main');
    setRequester(harness, 's1', 'main', timedRequester(true));
    if (face === undefined) throw new Error('timing facade was not injected');
    expect(face.value?.timing.value).toBeUndefined();

    const outcome = await agent.loop.runTurn(user('hello'));
    expect(outcome.type).toBe('done');

    const sample = face.value?.timing.value;
    if (sample === undefined) throw new Error('timing was not recorded');
    expect(sample.requestBuildMs).toBeDefined();
    expect(sample.requestBuildMs ?? -1).toBeGreaterThanOrEqual(0);
    expect(sample.requestBuildMs ?? 0).toBeLessThan(5000);
    for (const key of ['ttftMs', 'serverFirstTokenMs', 'streamDurationMs', 'serverDecodeMs', 'clientConsumeMs'] as const) {
      expect(sample[key]).toBeGreaterThanOrEqual(0);
      expect(sample[key]).toBeLessThan(5000);
    }
    await harness.close();
  });

  it('keeps timing undefined when the reply is not streamed', async () => {
    let face: Readonly<ShallowRef<TimingFace | undefined>> | undefined;
    const probe = createFeature('timing-probe', {
      agent: () => {
        face = useInject(TimingRef);
      },
    });
    const harness = createHarness({ space: memoryHarnessSpace() });
    await harness.app.features.add(timing);
    await harness.app.features.add(probe);
    const session = await harness.app.create({ sessionId: 's1' });
    const agent = await harness.ensureAgent(session, 'main');
    setRequester(harness, 's1', 'main', timedRequester(false));

    const outcome = await agent.loop.runTurn(user('hello'));
    expect(outcome.type).toBe('done');
    expect(face?.value?.timing.value).toBeUndefined();
    await harness.close();
  });
});
