import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApp, createFeature, useToolHandler } from '#/app/index';
import { createUserEntry, type ToolEntry } from '#/history/message';
import { createAssistantMessage, createUserMessage, extractText, type ContentPart, type ToolCall } from '#/llm/message';
import type { LlmRequest } from '#/llm/request';
import type { LlmOutcome } from '#/llm/response';
import { createLoop, type LoopLlmRequester } from '#/loop/index';
import {
  createToolExecutor,
  defineTool,
  zodSchema,
  type ToolExecuteInput,
  type ToolResult,
} from '#/tool/index';

import { agentCaps } from '../app/fake-llm';

function call(name: string, args = '{}'): ToolCall {
  return { type: 'function', id: `call_${name}`, name, arguments: args };
}

function input(name: string, args = '{}'): ToolExecuteInput {
  return { toolCall: call(name, args), signal: new AbortController().signal };
}

function text(result: ToolResult): string {
  return result.content
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function toolEntry(entry: { message: { role: string } } | undefined): ToolEntry {
  if (entry === undefined || entry.message.role !== 'tool') throw new Error('missing tool result');
  return entry as ToolEntry;
}

function requester(outcomes: Array<() => LlmOutcome>): LoopLlmRequester {
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async () => {
      const next = outcomes.shift();
      if (next === undefined) throw new Error('no scripted outcome');
      return next();
    },
  };
  return self;
}

const reply =
  (textValue: string, toolCalls: ToolCall[] = []): (() => LlmOutcome) =>
  () => ({
    type: 'done',
    message: createAssistantMessage([{ type: 'text', text: textValue }], toolCalls),
  });

describe('createToolExecutor', () => {
  it('dispatches a registered handler and leaves a short result untouched', async () => {
    const tools = createToolExecutor();
    const result: ToolResult = { content: [{ type: 'text', text: 'ok' }], stopTurn: false };
    tools.register('lookup', { execute: async () => result });
    await expect(tools.execute(input('lookup'))).resolves.toBe(result);
    await expect(tools.execute(input('missing'))).resolves.toEqual({
      content: [{ type: 'text', text: 'unknown tool: missing' }],
      isError: true,
    });
  });

  it('skips an invalidated handler until restore', async () => {
    let calls = 0;
    const tools = createToolExecutor();
    tools.register('lookup', {
      execute: async () => {
        calls += 1;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
    tools.invalidate('lookup', 'runtime unavailable');
    const blocked = await tools.execute(input('lookup'));
    expect(blocked).toEqual({
      content: [{ type: 'text', text: 'tool unavailable: lookup: runtime unavailable' }],
      isError: true,
    });
    expect(calls).toBe(0);
    tools.restore('lookup');
    expect(text(await tools.execute(input('lookup')))).toBe('ok');
    expect(calls).toBe(1);
    tools.invalidate('missing', 'gone');
    tools.restore('missing');
  });

  it('keeps an in-flight call on the handler it resolved and releases that handler when idle', async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const idle: string[] = [];
    const tools = createToolExecutor();
    const dispose = tools.register(
      'lookup',
      {
        execute: async () => {
          await gate;
          return { content: [{ type: 'text', text: 'old' }] };
        },
      },
      { onIdle: () => idle.push('old') },
    );
    const pending = tools.execute(input('lookup'));
    tools.register('lookup', { execute: async () => ({ content: [{ type: 'text', text: 'new' }] }) });
    expect(idle).toEqual([]);
    dispose();
    expect(text(await tools.execute(input('lookup')))).toBe('new');
    release();
    expect(text(await pending)).toBe('old');
    expect(idle).toEqual(['old']);
  });

  it('truncates text parts and keeps the rest of the result', async () => {
    const image: ContentPart = { type: 'image_url', source: { kind: 'url', url: 'https://example.test/a.png' } };
    const tools = createToolExecutor({ policy: { maxResultChars: 5 } });
    tools.register('lookup', {
      execute: async () => ({
        content: [{ type: 'text', text: 'hello world' }, image, { type: 'text', text: 'tail' }],
        isError: true,
        stopTurn: true,
      }),
    });
    const truncated = await tools.execute(input('lookup'));
    expect(truncated.content).toEqual([
      { type: 'text', text: 'hello' },
      image,
      { type: 'text', text: '[truncated to 5 chars]' },
    ]);
    expect(truncated.isError).toBe(true);
    expect(truncated.stopTurn).toBe(true);
    expect(() => createToolExecutor({ policy: { maxResultChars: -1 } })).toThrow(TypeError);
  });

  it('parses arguments before the typed handler runs', async () => {
    let calls = 0;
    const tool = defineTool({
      name: 'get_weather',
      description: 'Get the weather.',
      schema: zodSchema(z.object({ city: z.string() })),
      async execute({ args }) {
        calls += 1;
        return { content: [{ type: 'text', text: args.city }] };
      },
    });
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    });
    expect(tool.parameters['$schema']).toBeUndefined();
    const tools = createToolExecutor();
    tools.register(tool);
    expect(text(await tools.execute(input('get_weather', '{"city":"Beijing"}')))).toBe('Beijing');
    expect(text(await tool.execute(input('get_weather', '{')))).toBe('invalid arguments: malformed JSON');
    expect((await tool.execute(input('get_weather', 'null'))).isError).toBe(true);
    expect(calls).toBe(1);
  });

  it('records a truncated tool result and an unknown tool error through the loop', async () => {
    const tools = createToolExecutor({ policy: { maxResultChars: 4 } });
    tools.register('lookup', {
      execute: async () => ({ content: [{ type: 'text', text: 'abcdefghij' }] }),
    });
    const scripted = requester([reply('', [call('lookup')]), reply('end')]);
    const loop = createLoop({
      requester: () => scripted,
      executor: tools,
    });
    expect(loop.executor).toBe(tools);
    expect((await loop.runTurn(createUserEntry(createUserMessage('hello')))).type).toBe('done');
    const recorded = toolEntry(loop.state.messages.find((entry) => entry.message.role === 'tool'));
    expect(extractText(recorded.message)).toBe('abcd[truncated to 4 chars]');
    await loop.close();

    const missingScript = requester([reply('', [call('missing')]), reply('end')]);
    const missing = createLoop({
      requester: () => missingScript,
      executor: createToolExecutor(),
    });
    expect((await missing.runTurn(createUserEntry(createUserMessage('hello')))).type).toBe('done');
    const failed = toolEntry(missing.state.messages.find((entry) => entry.message.role === 'tool'));
    expect(extractText(failed.message)).toBe('unknown tool: missing');
    expect(failed.meta?.isError).toBe(true);
    await missing.close();
  });

  it('registers from an agent feature and drops the handler when the feature is removed', async () => {
    const tools = createToolExecutor();
    const app = createApp();
    const session = await app.create({ sessionId: 'sess' });
    await session.open('main', agentCaps(tools));
    const remove = app.features.add(
      createFeature('ping', {
        agent: () => {
          useToolHandler('ping', {
            execute: async () => ({ content: [{ type: 'text', text: 'pong' }] }),
          });
        },
      }),
      { session: 'sess', agent: 'main' },
    );
    expect(text(await tools.execute(input('ping')))).toBe('pong');
    await remove();
    expect((await tools.execute(input('ping'))).isError).toBe(true);
    await app.close();
  });
});
