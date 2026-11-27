import { describe, expect, it } from 'vitest';

import { createLoop, type LoopEmitted } from '#/loop/index';
import type { LoopToolContext, LoopToolExecutor } from '#/loop/create-loop';
import { createMediaDegradeRecovery } from '#/llm/builtin/policy/media-degrade';
import { createAssistantMessage, createUserMessage, extractText, type Message } from '#/llm/message';
import { createLlmRequesterExecution, type LlmRunControl } from '#/llm/policy/policy';
import type { LlmRecoveryRecord } from '#/llm/policy/recovery';
import type { Protocol } from '#/llm/protocol/protocol';
import type { LlmRequest } from '#/llm/request';
import {
  contentsOf,
  createRequester,
  mergeFields,
  requesterContents,
  type LlmDimension,
  type LlmRequester,
  type LlmRequestPart,
} from '#/llm/requester';
import type { LlmOutcome, LlmRemoteErrorMessage } from '#/llm/response';
import { ToolExecutor } from '#/tool/tool-executor';
import type { FullLoopLlmRequester } from '#/loop/request';

type Fields = Readonly<Record<string, unknown>>;
type Generate = (request: LlmRequest, control: LlmRunControl) => LlmOutcome | Promise<LlmOutcome>;

function fullRequester(generate: Generate, filled: LlmRequestPart = {}): FullLoopLlmRequester {
  const complete = (rest: LlmRequestPart): LlmRequest =>
    mergeFields(filled as Fields, rest as Fields) as unknown as LlmRequest;
  return {
    [requesterContents]: filled,
    with: ((next: LlmRequestPart | LlmRequester<LlmDimension>) =>
      fullRequester(generate, mergeFields(filled as Fields, contentsOf(next) as Fields) as LlmRequestPart)) as FullLoopLlmRequester['with'],
    request: complete,
    generate: async (rest, control) => generate(complete(rest), control),
  };
}

function done(text: string): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }]) };
}

const executor: LoopToolExecutor = {
  execute: () => {
    throw new Error('unexpected tool call');
  },
};

describe('loop requester compatibility', () => {
  it('runs a real turn with a full requester and exposes the raw base', async () => {
    const seen: LlmRequest[] = [];
    const base = fullRequester((request) => {
      seen.push(request);
      return done('full response');
    });
    const loop = createLoop({
      requester: base,
      executor,
      input: { profile: { systemPrompt: 'loop system' } },
    });

    expect(loop.baseRequester).toBe(base);
    expect((await loop.runTurn(createUserMessage('hello'))).type).toBe('done');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.content.messages.map((message) => extractText(message))).toEqual(['hello']);
    expect(seen[0]?.profile).toEqual({ systemPrompt: 'loop system' });
    expect(loop.state.messages.map((message) => extractText(message))).toEqual(['hello', 'full response']);
    expect(loop.baseRequester).toBe(base);
    await loop.close();
  });

  it('uses the current full base for each turn', async () => {
    const seen: { readonly base: string; readonly messages: string[] }[] = [];
    const makeBase = (name: string): FullLoopLlmRequester => fullRequester((request) => {
      seen.push({
        base: name,
        messages: request.content.messages.map((message) => extractText(message)),
      });
      return done(`${name} response`);
    });
    const first = makeBase('first');
    const second = makeBase('second');
    const loop = createLoop({ requester: first, executor });

    expect(loop.baseRequester).toBe(first);
    expect((await loop.runTurn(createUserMessage('first'))).type).toBe('done');
    loop.setRequester(second);
    expect((await loop.runTurn(createUserMessage('second'))).type).toBe('done');
    expect(seen).toEqual([
      { base: 'first', messages: ['first'] },
      { base: 'second', messages: ['first', 'first response', 'second'] },
    ]);
    expect(loop.baseRequester).toBe(second);
    await loop.close();
  });
});

describe('loop side requester', () => {
  it('applies base, live, part, and rest priorities while sharing base recovery memory', async () => {
    const attempts: { readonly request: LlmRequest; readonly recoveries: readonly LlmRecoveryRecord[] }[] = [];
    const success = [{ text: 'side response', finish: { finishReason: 'completed' as const, rawFinishReason: 'stop' } }];
    const protocol: Protocol = {
      media: { kinds: {} },
      encode: (module) => module.content.messages,
      client: () => null,
      send: async () => ({ body: success }),
      sendStream: async () => {
        if (attempts.length === 1) throw new Error('request too large');
        return {
          body: (async function* () {
            yield* success;
          })(),
        };
      },
      decoder: (_module, sink) => ({
        push: (chunk: (typeof success)[number]) => {
          sink.onDelta({ type: 'text', text: chunk.text });
          sink.onFinish(chunk.finish);
        },
        end: () => {},
      }),
      replay: (response) => response,
      decodeError: (): LlmRemoteErrorMessage => ({
        kind: 'request_too_large',
        message: 'request too large',
        requestId: null,
        retryAfterMs: null,
        headers: null,
        retryable: false,
      }),
    };
    const mediaMessage = (text: string) => createUserMessage([
      { type: 'text', text },
      { type: 'image_url', imageUrl: { url: 'data:image/png;base64,c2lkZQ==' } },
    ]);
    const baseMessage = mediaMessage('base history');
    const liveMessage = mediaMessage('live history');
    const partMessage = mediaMessage('part history');
    const restMessage = mediaMessage('rest history');
    const baseTools = [{ name: 'base_tool', description: 'base tool', parameters: { type: 'object' } }];
    const liveTools = [{ name: 'live_tool', description: 'live tool', parameters: { type: 'object' } }];
    const execution = createLlmRequesterExecution();
    const base = createRequester(execution).with({
      protocol: { base: protocol, stream: true },
      endpoint: {},
      model: { spec: { provider: 'test', name: 'test-model' } },
      content: { messages: [baseMessage] },
      profile: { systemPrompt: 'base system', tools: baseTools },
      policy: { retry: { maxAttemptsPerStep: 1 }, recoveries: [createMediaDegradeRecovery()] },
    });
    const loop = createLoop({
      requester: base,
      executor,
      input: { messages: [liveMessage], profile: { systemPrompt: 'live system', tools: liveTools } },
    });
    const resolver = { id: 'probe', resolve: async (request: LlmRequest) => request };
    loop.policy.addResolver(resolver);

    const defaults = loop.requester.request({});
    expect(defaults.content.messages).toEqual([liveMessage]);
    expect(defaults.profile).toEqual({ systemPrompt: 'live system', tools: liveTools });
    const resolvers = defaults.policy?.resolvers;
    expect(typeof resolvers === 'function' ? resolvers() : resolvers).toEqual([resolver]);

    const derived = loop.requester.with({
      content: { messages: [partMessage] },
      profile: { systemPrompt: 'part system' },
    });
    const part = derived.request({});
    expect(part.content.messages).toEqual([partMessage]);
    expect(part.profile).toEqual({ systemPrompt: 'part system', tools: liveTools });
    const rest = {
      content: { messages: [restMessage] },
      profile: { systemPrompt: 'rest system' },
    };
    const explicit = derived.request(rest);
    expect(explicit.content.messages).toEqual([restMessage]);
    expect(explicit.profile).toEqual({ systemPrompt: 'rest system', tools: liveTools });

    const control = {
      signal: new AbortController().signal,
      onAttempt: (request: LlmRequest, context: { readonly appliedRecoveries: readonly LlmRecoveryRecord[] }) => {
        attempts.push({ request, recoveries: [...context.appliedRecoveries] });
      },
    };
    expect((await base.generate({}, control)).type).toBe('done');
    expect((await derived.generate(rest, control)).type).toBe('done');
    expect(attempts.map(({ request }) => request.profile?.systemPrompt)).toEqual([
      'base system',
      'base system',
      'rest system',
    ]);
    expect(attempts.map(({ request }) => request.content.messages.flatMap((message) => message.content)
      .filter((part) => part.type === 'image_url' && part.omitted === undefined).length)).toEqual([1, 0, 0]);
    expect(attempts.map(({ recoveries }) => recoveries.map((recovery) =>
      `${recovery.strategy}:${recovery.action}`))).toEqual([
        [],
        ['media-degrade:stripped'],
        ['media-degrade:stripped'],
      ]);
    expect(attempts[2]?.request.content.messages[0]?.content[0]).toEqual({ type: 'text', text: 'rest history' });
    expect(loop.requester.request({}).profile).toEqual({ systemPrompt: 'live system', tools: liveTools });
    expect(loop.requester.request({}).content.messages).toEqual([liveMessage]);
    expect(loop.baseRequester).toBe(base);
    await loop.close();
  });

  it('re-reads the latest raw base and live loop state on every call', async () => {
    const seen: { readonly base: string; readonly request: LlmRequest }[] = [];
    const makeBase = (name: string): FullLoopLlmRequester => fullRequester((request) => {
      seen.push({ base: name, request });
      return done(name);
    });
    const first = makeBase('first');
    const second = makeBase('second');
    const loop = createLoop({
      requester: first,
      executor,
      input: { messages: [createUserMessage('old')], profile: { systemPrompt: 'old system' } },
    });
    const control = { signal: new AbortController().signal };

    await loop.requester.generate({}, control);
    loop.setRequester(second);
    loop.setContext([createUserMessage('new')]);
    loop.setSystemPrompt('new system');
    await loop.requester.generate({}, control);

    expect(seen.map((entry) => entry.base)).toEqual(['first', 'second']);
    expect(seen[0]?.request.content.messages.map((message) => extractText(message))).toEqual(['old']);
    expect(seen[1]?.request.content.messages.map((message) => extractText(message))).toEqual(['new']);
    expect(seen[1]?.request.profile).toEqual({ systemPrompt: 'new system' });
    expect(loop.baseRequester).toBe(second);
    await loop.close();
  });

  it('reports missing full bases and recovers after installing one', async () => {
    const loop = createLoop({ executor });
    const control = { signal: new AbortController().signal };

    expect(() => loop.requester.request({})).toThrow('loop has no full core requester');
    expect(() => loop.requester.generate({}, control)).toThrow('loop has no full core requester');
    const base = fullRequester(() => done('full response'));
    loop.setRequester(base);
    expect((await loop.runTurn(createUserMessage('full'))).type).toBe('done');
    expect(loop.state.messages.map((message) => extractText(message))).toEqual(['full', 'full response']);
    expect(loop.requester.request({}).content.messages.map((message) => extractText(message))).toEqual([
      'full',
      'full response',
    ]);
    await loop.close();
  });
});

describe('loop llm observer and policy merging', () => {
  it('observes turns and side calls, freezes the current turn base, and concatenates policy lists', async () => {
    const seen: { readonly base: string; readonly request: LlmRequest }[] = [];
    let firstCalls = 0;
    const baseResolver = { id: 'base', resolve: async (request: LlmRequest) => request };
    const loopResolver = { id: 'loop', resolve: async (request: LlmRequest) => request };
    const callResolver = { id: 'call', resolve: async (request: LlmRequest) => request };
    const resolverIds = (request: LlmRequest) => {
      const resolvers = request.policy?.resolvers;
      return (typeof resolvers === 'function' ? resolvers() : resolvers)?.map((resolver) => resolver.id);
    };
    const first = createRequester().with({
      protocol: { base: {} as never },
      model: { spec: { provider: 'test', name: 'first' } },
      policy: { resolvers: [baseResolver], retry: { maxAttemptsPerStep: 4 } },
    }).with({
      endpoint: {},
      content: { messages: [] },
      profile: {},
    });
    const firstFull = fullRequester((request) => {
      seen.push({ base: 'first', request });
      firstCalls += 1;
      if (firstCalls === 1) {
        return {
          type: 'done',
          message: createAssistantMessage([], [
            { type: 'function', id: 'call-work', name: 'work', arguments: '{}' },
          ]),
        };
      }
      return done('first response');
    }, contentsOf(first));
    const second = fullRequester((request) => {
      seen.push({ base: 'second', request });
      return done('second response');
    });
    const started: LlmRequest[] = [];
    const settled: LlmOutcome[] = [];
    const tools = new ToolExecutor<LoopToolContext>([{
      name: 'work',
      description: 'switch the next turn base',
      parameters: { type: 'object' },
      execute: async () => {
        loop.setRequester(second);
        return { content: [] };
      },
    }]);
    const loop = createLoop({
      requester: firstFull,
      llmObserver: {
        start: (request) => {
          started.push(request);
          return { settle: (outcome) => settled.push(outcome) };
        },
      },
      executor: tools,
    });
    loop.policy.addResolver(loopResolver);

    expect((await loop.runTurn(createUserMessage('first turn'))).type).toBe('done');
    expect(seen.map((entry) => entry.base)).toEqual(['first', 'first']);
    expect(seen[0]?.request.attributes).toEqual({ kind: 'loop', turnId: 0, step: 1 });
    expect(seen[1]?.request.attributes).toEqual({ kind: 'loop', turnId: 0, step: 2 });
    expect(loop.baseRequester).toBe(second);

    await loop.requester.with({
      attributes: { kind: 'compaction', turnId: 1, modelAlias: 'alias-a', logFields: { droppedCount: 0 } },
      policy: { resolvers: [callResolver], retry: { maxAttemptsPerStep: 1 } },
    }).generate({}, { signal: new AbortController().signal });
    expect(seen.map((entry) => entry.base)).toEqual(['first', 'first', 'second']);
    expect(seen[2]?.request.attributes).toEqual({
      kind: 'compaction',
      turnId: 1,
      modelAlias: 'alias-a',
      logFields: { droppedCount: 0 },
    });
    expect(seen[2]?.request.policy?.retry).toEqual({ maxAttemptsPerStep: 1 });
    const withLoopPolicy = createRequester().with(first).with({
      policy: { ...loop.policy.asPolicy(), resolvers: undefined },
    }).with({ policy: { resolvers: [loopResolver] } }).request({});
    expect(resolverIds(withLoopPolicy)).toEqual(['base', 'loop']);
    const mergedPolicy = createRequester().with(first).with({
      policy: { ...loop.policy.asPolicy(), resolvers: undefined },
    }).with({ policy: { resolvers: [loopResolver, callResolver], retry: { maxAttemptsPerStep: 1 } } }).request({});
    expect(resolverIds(mergedPolicy)).toEqual(['base', 'loop', 'call']);
    expect(started).toHaveLength(3);
    expect(settled.map((outcome) => outcome.type)).toEqual(['done', 'done', 'done']);
    expect(loop.baseRequester).toBe(second);
    await loop.close();
  });
});

describe('loop event envelope', () => {
  it('stamps turn and step on step, llm, and tool events across retries, steps, and turns', async () => {
    interface Chunk {
      readonly text?: string;
      readonly toolCallId?: string;
      readonly finish?: boolean;
    }
    const stepOne = (toolCallId: string): Chunk[] => [{ text: 'calling' }, { toolCallId }, { finish: true }];
    const stepTwo: Chunk[] = [{ text: 'done' }, { finish: true }];
    const requests: number[] = [];
    let stepOneAttempts = 0;
    const protocol: Protocol<unknown, readonly Message[]> = {
      media: { kinds: {} },
      encode: (module) => module.content.messages,
      client: () => null,
      send: async () => ({ body: stepTwo }),
      sendStream: async (_client, messages) => {
        if (messages.at(-1)?.role === 'tool') {
          requests.push(2);
          return { body: (async function* () { yield* stepTwo; })() };
        }
        requests.push(1);
        stepOneAttempts += 1;
        if (stepOneAttempts === 1) throw new Error('rate limited');
        const id = messages.length === 1 ? 'call-work' : 'call-work-2';
        return { body: (async function* () { yield* stepOne(id); })() };
      },
      decoder: (_module, sink) => ({
        push: (chunk: Chunk) => {
          if (chunk.text !== undefined) sink.onDelta({ type: 'text', text: chunk.text });
          if (chunk.toolCallId !== undefined) {
            sink.onDelta({ type: 'function', id: chunk.toolCallId, name: 'work', arguments: '{}' });
            sink.onToolCallEnd();
          }
          if (chunk.finish === true) sink.onFinish({ finishReason: 'completed', rawFinishReason: 'stop' });
        },
        end: () => {},
      }),
      replay: (response) => response,
      decodeError: (): LlmRemoteErrorMessage => ({
        kind: 'rate_limit',
        message: 'rate limited',
        requestId: null,
        retryAfterMs: 1,
        headers: null,
        retryable: true,
      }),
    };
    const work = { name: 'work', description: 'work', parameters: { type: 'object' } };
    const requester = createRequester(createLlmRequesterExecution()).with({
      protocol: { base: protocol, stream: true },
      endpoint: {},
      model: { spec: { provider: 'test', name: 'envelope-model' } },
      policy: { retry: { maxAttemptsPerStep: 2 } },
    });
    const tools = new ToolExecutor<LoopToolContext>([{
      ...work,
      execute: async () => ({ content: [{ type: 'text', text: 'tool ok' }] }),
    }]);
    const loop = createLoop({ requester, executor: tools, input: { profile: { tools: [work] } } });
    const events: LoopEmitted[] = [];
    loop.subscribe((event) => events.push(event));

    expect((await loop.runTurn(createUserMessage('first'))).type).toBe('done');
    expect((await loop.runTurn(createUserMessage('second'))).type).toBe('done');
    expect(requests).toEqual([1, 1, 2, 1, 2]);

    const steps = events.filter((event) => event.type === 'step.started');
    expect(steps.map((event) => [event.turnId, event.step])).toEqual([
      [0, 1],
      [0, 2],
      [1, 1],
      [1, 2],
    ]);
    expect(steps.every((step) => typeof step.stepId === 'string' && step.stepId.length > 0)).toBe(true);
    expect(new Set(steps.map((step) => step.stepId)).size).toBe(steps.length);

    let active: { turnId: number; step: number } | undefined;
    const llmEnvelopes: Array<{
      turnId: number;
      step: number;
      activeTurnId: number | undefined;
      activeStep: number | undefined;
    }> = [];
    for (const event of events) {
      if (event.type === 'step.started') {
        active = { turnId: event.turnId, step: event.step };
        continue;
      }
      if (event.type === 'step.ended') {
        active = undefined;
        continue;
      }
      if (!('turnId' in event) || !('step' in event)) continue;
      if (event.type.startsWith('llm.')) {
        llmEnvelopes.push({
          turnId: event.turnId,
          step: event.step,
          activeTurnId: active?.turnId,
          activeStep: active?.step,
        });
      }
    }
    expect(llmEnvelopes.length).toBeGreaterThan(0);
    expect(llmEnvelopes).toEqual(
      llmEnvelopes.map(({ turnId, step }) => ({ turnId, step, activeTurnId: turnId, activeStep: step })),
    );

    expect(events.filter((event) => event.type === 'llm.started').map((event) => [event.turnId, event.step])).toEqual([
      [0, 1],
      [0, 2],
      [1, 1],
      [1, 2],
    ]);
    expect(events.filter((event) => event.type === 'llm.requested').map((event) => [event.turnId, event.step])).toEqual([
      [0, 1],
      [0, 1],
      [0, 2],
      [1, 1],
      [1, 2],
    ]);
    expect(events.filter((event) => event.type === 'llm.retry').map((event) => [event.turnId, event.step])).toEqual([[0, 1]]);
    expect(events.find((event) => event.type === 'llm.retry')).toMatchObject({ reason: 'backoff', failedAttempt: 1, nextAttempt: 2 });
    expect(events.filter((event) => event.type === 'llm.ended').map((event) => [event.turnId, event.step])).toEqual([
      [0, 1],
      [0, 2],
      [1, 1],
      [1, 2],
    ]);
    expect(events.filter((event) => event.type === 'llm.delta.part').map((event) => [
      event.turnId,
      event.step,
      event.part.type === 'text' ? event.part.text : event.part.type,
    ])).toEqual([
      [0, 1, 'calling'],
      [0, 1, 'function'],
      [0, 2, 'done'],
      [1, 1, 'calling'],
      [1, 1, 'function'],
      [1, 2, 'done'],
    ]);
    expect(events.filter((event) => event.type === 'tool.ended').map((event) => [
      event.turnId,
      event.step,
      event.toolCallId,
      event.outcome.type,
    ])).toEqual([
      [0, 1, 'call-work', 'succeeded'],
      [1, 1, 'call-work-2', 'succeeded'],
    ]);
    await loop.close();
  });
});
