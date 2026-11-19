import { describe, expect, it } from 'vitest';

import { createLoop } from '#/loop/index';
import type { LoopToolContext, LoopToolExecutor } from '#/loop/create-loop';
import { createMediaDegradeRecovery } from '#/llm/builtin/policy/media-degrade';
import { createAssistantMessage, createUserMessage, extractText } from '#/llm/message';
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
import type { FullLoopLlmRequester, LoopLlmRequester } from '#/loop/request';

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

  it('keeps legacy snapshot requesters on the existing per-turn path', async () => {
    const seen: string[][] = [];
    let snapshots = 0;
    const base: LoopLlmRequester = {
      snapshot: () => {
        snapshots += 1;
        return {
          generate: (rest) => {
            seen.push(rest.content?.messages?.map((message) => extractText(message)) ?? []);
            return Promise.resolve(done(`legacy ${String(snapshots)}`));
          },
        };
      },
      generate: () => Promise.reject(new Error('unsnapshotted requester must not run')),
    };
    const loop = createLoop({ requester: base, executor });

    expect(loop.baseRequester).toBe(base);
    expect((await loop.runTurn(createUserMessage('first'))).type).toBe('done');
    expect((await loop.runTurn(createUserMessage('second'))).type).toBe('done');
    expect(snapshots).toBe(2);
    expect(seen).toEqual([
      ['first'],
      ['first', 'legacy 1', 'second'],
    ]);
    expect(loop.baseRequester).toBe(base);
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
      .filter((part) => part.type === 'image_url').length)).toEqual([1, 0, 0]);
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

  it('reports missing full bases without affecting legacy normal turns', async () => {
    const loop = createLoop({ executor });
    const control = { signal: new AbortController().signal };

    expect(() => loop.requester.request({})).toThrow('loop has no full core requester');
    expect(() => loop.requester.generate({}, control)).toThrow('loop has no full core requester');
    const legacy: LoopLlmRequester = { generate: () => Promise.resolve(done('legacy response')) };
    loop.setRequester(legacy);
    expect(() => loop.requester.request({})).toThrow('loop has no full core requester');
    expect((await loop.runTurn(createUserMessage('legacy'))).type).toBe('done');
    expect(loop.state.messages.map((message) => extractText(message))).toEqual(['legacy', 'legacy response']);
    await loop.close();
  });
});

describe('turn requester decoration', () => {
  it('decorates once per turn, freezes the current turn, and keeps side requests raw', async () => {
    const seen: { readonly base: string; readonly request: LlmRequest }[] = [];
    let firstCalls = 0;
    const first = fullRequester((request) => {
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
    });
    const second = fullRequester((request) => {
      seen.push({ base: 'second', request });
      return done('second response');
    });
    const decorated: FullLoopLlmRequester[] = [];
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
      requester: first,
      decorateTurnRequester: (requester) => {
        decorated.push(requester);
        return requester.with({ endpoint: { headers: { 'x-turn-requester': 'true' } } });
      },
      executor: tools,
    });

    expect((await loop.runTurn(createUserMessage('first turn'))).type).toBe('done');
    expect(decorated).toHaveLength(1);
    expect(decorated[0]).toBe(first);
    expect(seen.map((entry) => entry.base)).toEqual(['first', 'first']);
    expect(seen.every((entry) => entry.request.endpoint?.headers?.['x-turn-requester'] === 'true')).toBe(true);
    expect(loop.baseRequester).toBe(second);

    expect((await loop.runTurn(createUserMessage('second turn'))).type).toBe('done');
    expect(decorated).toHaveLength(2);
    expect(decorated[1]).toBe(second);
    expect(seen.map((entry) => entry.base)).toEqual(['first', 'first', 'second']);
    expect(seen[2]?.request.endpoint?.headers?.['x-turn-requester']).toBe('true');

    await loop.requester.generate({}, { signal: new AbortController().signal });
    expect(seen.map((entry) => entry.base)).toEqual(['first', 'first', 'second', 'second']);
    expect(seen[3]?.request.endpoint?.headers?.['x-turn-requester']).toBeUndefined();
    expect(decorated).toHaveLength(2);
    expect(loop.baseRequester).toBe(second);
    await loop.close();
  });
});
