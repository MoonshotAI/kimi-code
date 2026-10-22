import { describe, expect, it } from 'vitest';

import { createFeature } from '#/app/index';
import { createUserEntry, type UserMeta } from '@moonshot-ai/agent-core/history/index';
import { useInject, type ShallowRef } from '#/composition-api/index';
import { createAssistantMessage, createUserMessage } from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import { memorySessionSpace } from '@moonshot-ai/agent-core/session/index';

import { timing, TimingRef, type TimingFace } from '#/features/timing/index';
import { createApp, type App } from '#/app/index';

function user(text: string, meta: UserMeta = {}) {
  return createUserEntry(createUserMessage(text), { source: 'input', ...meta });
}

function setRequester(harness: App, sessionId: string, agentId: string, requester: LoopLlmRequester): void {
  const session = harness.sessions.get(sessionId);
  const agent =
    session !== undefined ? session.liveAgents.get(agentId) : undefined;
  if (agent === undefined) throw new Error(`no live agent '${agentId}'`);
  agent.loop.setRequester(requester);
}

function timedRequester(streamed: boolean): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (_rest, control) => {
      control.onEvent?.({ type: 'llm.started', provider: 'fake', model: 'fake-model', messageCount: 0 });
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
    const harness = createApp({ space: memorySessionSpace() });
    harness.features.add(timing);
    harness.features.add(probe);
    const session = await harness.open('s1');
    const { agent } = await session.ensureAgent('main');
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
    const harness = createApp({ space: memorySessionSpace() });
    harness.features.add(timing);
    harness.features.add(probe);
    const session = await harness.open('s1');
    const { agent } = await session.ensureAgent('main');
    setRequester(harness, 's1', 'main', timedRequester(false));

    const outcome = await agent.loop.runTurn(user('hello'));
    expect(outcome.type).toBe('done');
    expect(face?.value?.timing.value).toBeUndefined();
    await harness.close();
  });
});
