import { describe, expect, it } from 'vitest';

import { createApp, createFeature, useRequester, type App } from '#/app/index';
import { extractText } from '#/llm/message';
import type { LlmModelSpec, LlmRequest } from '#/llm/request';
import { mergeFields, type LlmRequestPart } from '#/llm/requester';
import type { LlmOutcome } from '#/llm/response';
import type { LoopLlmRequester } from '#/loop/index';
import type { Agent } from '#/session/index';

import { noopExecutor, textOutcome, user } from './fake-llm';

const spec: LlmModelSpec = { provider: 'fake', name: 'fake-model' };

function fakeRequester(script: (request: LlmRequest) => LlmOutcome, filled: LlmRequestPart = {}): LoopLlmRequester {
  const complete = (part: LlmRequestPart) =>
    mergeFields(filled as Record<string, unknown>, part as Record<string, unknown>) as unknown as LlmRequest;
  return {
    with: (part) => fakeRequester(script, complete(part)),
    request: complete,
    generate: async (rest) => script(complete(rest)),
  };
}

interface Setup {
  readonly app: App;
  readonly agent: Agent;
  readonly requester: LoopLlmRequester;
  use(next: LoopLlmRequester): void;
}

async function setup(initial: LoopLlmRequester): Promise<Setup> {
  let current = initial;
  const app = createApp();
  const session = await app.create({ sessionId: 'sess' });
  const agent = await session.open('main', { executor: noopExecutor, requester: () => current });
  let captured: LoopLlmRequester | undefined;
  app.features.add(
    createFeature('capture', {
      agent: () => {
        captured = useRequester();
      },
    }),
    { session: 'sess', agent: 'main' },
  );
  if (captured === undefined) throw new Error('requester not captured');
  const requester = captured;
  return {
    app,
    agent,
    requester,
    use: (next) => {
      current = next;
    },
  };
}

describe('useRequester', () => {
  it('fills model, profile and the live context, resolved when the request is made', async () => {
    const { app, agent, requester } = await setup(
      fakeRequester(() => textOutcome('ok')).with({
        model: { spec },
        profile: { systemPrompt: 'You are helpful.' },
      }),
    );
    const empty = requester.request({});
    expect(empty.model.spec).toEqual(spec);
    expect(empty.profile?.systemPrompt).toBe('You are helpful.');
    expect(empty.content.messages).toEqual([]);
    agent.loop.submit(user('hello'));
    await agent.loop.waitForIdle();
    const filled = requester.request({});
    const texts = filled.content.messages.map((message) => extractText(message));
    expect(texts).toContain('hello');
    expect(texts).toContain('ok');
    expect(filled.content.usedTokens).toBeGreaterThan(0);
    await app.close();
  });

  it('merges .with parts over the agent configuration', async () => {
    const { app, requester } = await setup(
      fakeRequester(() => textOutcome('ok')).with({
        model: { spec, maxOutputTokens: 128 },
        profile: { systemPrompt: 'base prompt' },
      }),
    );
    const merged = requester
      .with({ model: { thinking: { effort: 'on' } }, profile: { systemPrompt: 'override' } })
      .request({});
    expect(merged.model.spec).toEqual(spec);
    expect(merged.model.maxOutputTokens).toBe(128);
    expect(merged.model.thinking).toEqual({ effort: 'on' });
    expect(merged.profile?.systemPrompt).toBe('override');
    await app.close();
  });

  it('generates with the latest context and an estimated usedTokens', async () => {
    const seen: LlmRequest[] = [];
    const { app, agent, requester } = await setup(
      fakeRequester((request) => {
        seen.push(request);
        return textOutcome('side');
      }).with({ model: { spec } }),
    );
    await agent.loop.runTurn(user('context-message'));
    seen.length = 0;
    const outcome = await requester
      .with({ profile: { systemPrompt: 'side quest' } })
      .generate({}, { signal: new AbortController().signal });
    expect(outcome.type).toBe('done');
    expect(seen).toHaveLength(1);
    const request = seen[0];
    if (request === undefined) throw new Error('no request');
    expect(request.profile?.systemPrompt).toBe('side quest');
    expect(request.content.messages.map((message) => extractText(message))).toContain('context-message');
    expect(typeof request.content.usedTokens).toBe('number');
    await app.close();
  });

  it('reads the caps requester getter on every request', async () => {
    const first = fakeRequester(() => textOutcome('a')).with({ model: { spec } });
    const second = fakeRequester(() => textOutcome('b')).with({
      model: { spec: { provider: 'fake', name: 'other-model' } },
    });
    const { app, requester, use } = await setup(first);
    expect(requester.request({}).model.spec.name).toBe('fake-model');
    use(second);
    expect(requester.request({}).model.spec.name).toBe('other-model');
    await app.close();
  });
});
