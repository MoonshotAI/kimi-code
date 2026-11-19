import { describe, expect, it } from 'vitest';

import { createLoop } from '#/loop/index';
import type { LoopToolExecutor } from '#/loop/create-loop';
import { createAssistantMessage, createUserMessage, extractText } from '#/llm/message';
import type { LlmRunControl } from '#/llm/policy/policy';
import type { LlmRequest } from '#/llm/request';
import {
  contentsOf,
  mergeFields,
  requesterContents,
  type LlmDimension,
  type LlmRequester,
  type LlmRequestPart,
} from '#/llm/requester';
import type { LlmOutcome } from '#/llm/response';
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
