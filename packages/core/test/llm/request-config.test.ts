import { describe, expect, it, vi } from 'vitest';

import { anthropicProtocol } from '#/llm/builtin/protocol/anthropic/index';
import { googleGenAIProtocol } from '#/llm/builtin/protocol/google-genai/index';
import { openAIResponsesProtocol } from '#/llm/builtin/protocol/openai-responses/index';
import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import { kimiOpenAIProtocol } from '#/llm/builtin/provider/kimi/protocol';
import {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
  type Message,
} from '#/llm/message';
import type { Protocol } from '#/llm/protocol/protocol';
import {
  defaultThinkingEffortForModel,
  modelSupportsThinking,
  resolveThinkingEffortForModel,
  resolveThinkingKeep,
} from '#/llm/thinking';
import type { LlmRequestModel, LlmRequestProfile } from '#/llm/request';

import { asyncChunks, runGenerate, TEST_MODEL, testModule } from './harness';

function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function records(value: unknown): Record<string, unknown>[] {
  return value as Record<string, unknown>[];
}

function toolHistory(): readonly Message[] {
  return [
    createUserMessage('hi'),
    createAssistantMessage([], [
      { type: 'function', id: 'call_1', name: 'snap', arguments: '{}' },
    ]),
    createToolMessage('call_1', [
      { type: 'text', text: 'shot taken' },
      { type: 'image_url', imageUrl: { url: 'https://example.test/shot.png' } },
    ]),
  ];
}

function modelWith<TOptions = never>(profile: {
  readonly model?: LlmRequestModel;
  readonly profile?: LlmRequestProfile;
  readonly messages?: readonly Message[];
  readonly options?: TOptions;
} = {}) {
  return testModule<TOptions>({
    model: profile.model ?? TEST_MODEL,
    profile: profile.profile,
    messages: profile.messages ?? [createUserMessage('hi')],
    options: profile.options,
  });
}

describe('response format and tool result conversion', () => {
  it('maps json_object and json_schema to response_format', () => {
    const jsonObject = openAIProtocol.encode(modelWith({
      model: { ...TEST_MODEL, responseFormat: { type: 'json_object' } },
    }));
    expect(record(jsonObject.params)['response_format']).toEqual({ type: 'json_object' });

    const jsonSchema = {
      name: 'answer',
      schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
      strict: true,
      description: 'structured answer',
    };
    const schemaRequest = openAIProtocol.encode(modelWith({
      model: { ...TEST_MODEL, responseFormat: { type: 'json_schema', jsonSchema } },
    }));
    expect(record(schemaRequest.params)['response_format']).toEqual({
      type: 'json_schema',
      json_schema: jsonSchema,
    });
  });

  it('forces tool results to plain text when set to extract_text', () => {
    const request = openAIProtocol.encode(modelWith({
      messages: toolHistory(),
      options: { toolMessageConversion: 'extract_text' },
    }));
    const messages = records(record(request.params)['messages']);
    expect(messages.find((message) => message['role'] === 'tool')?.['content']).toBe(
      'shot taken\n(image omitted: tool result converted to plain text)',
    );
    expect(messages.filter((message) => message['role'] === 'user')).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain('image_url');
  });

  it('applies request-level extract_text on the openai path', () => {
    const request = openAIProtocol.encode(modelWith({
      messages: toolHistory(),
      options: { toolMessageConversion: 'extract_text' },
    }));
    const tool = records(record(request.params)['messages']).find((message) => message['role'] === 'tool');
    expect(tool?.['content']).toBe('shot taken\n(image omitted: tool result converted to plain text)');
  });

  it('applies request-level keep_parts on the openai path', () => {
    const request = openAIProtocol.encode(modelWith({
      messages: toolHistory(),
      options: { toolMessageConversion: 'keep_parts' },
    }));
    const tool = records(record(request.params)['messages']).find((message) => message['role'] === 'tool');
    expect(tool?.['content']).toEqual([
      { type: 'text', text: 'shot taken' },
      { type: 'image_url', image_url: { url: 'https://example.test/shot.png' } },
    ]);
  });

  it('lets the request config override the kimi keep_parts default', () => {
    const keeping = kimiOpenAIProtocol.encode(modelWith({ messages: toolHistory() }));
    const keptTool = records(record(keeping.params)['messages']).find((message) => message['role'] === 'tool');
    expect(keptTool?.['content']).toEqual([
      { type: 'text', text: 'shot taken' },
      { type: 'image_url', image_url: { url: 'https://example.test/shot.png' } },
    ]);

    const extracting = kimiOpenAIProtocol.encode(modelWith({
      messages: toolHistory(),
      options: { toolMessageConversion: 'extract_text' },
    }));
    const extractedTool = records(record(extracting.params)['messages']).find((message) => message['role'] === 'tool');
    expect(extractedTool?.['content']).toBe('shot taken\n(image omitted: tool result converted to plain text)');
  });

  it('applies request-level extract_text on the responses path', () => {
    const request = openAIResponsesProtocol.encode(modelWith({
      messages: toolHistory(),
      options: { toolMessageConversion: 'extract_text' },
    }));
    const input = records(record(request.params)['input']);
    expect(input.find((item) => item['type'] === 'function_call_output')?.['output']).toBe(
      'shot taken\n(image omitted: tool result converted to plain text)',
    );
    expect(JSON.stringify(input)).not.toContain('input_image');
  });
});

describe('non-streaming protocol replay', () => {
  it('issues non-streaming requests with isomorphic event sequence', async () => {
    const cases: { readonly protocol: Protocol<never>; readonly response: unknown; readonly model: string }[] = [
      {
        protocol: openAIProtocol,
        model: 'gpt-4o',
        response: {
          id: 'chatcmpl-1',
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{}' } }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        },
      },
      {
        protocol: openAIResponsesProtocol,
        model: 'gpt-5-codex',
        response: {
          id: 'resp_1',
          status: 'completed',
          output: [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'hi' }],
          }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
      {
        protocol: anthropicProtocol,
        model: 'claude-sonnet-4-20250514',
        response: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 2 },
        },
      },
      {
        protocol: googleGenAIProtocol,
        model: 'gemini-2.5-flash',
        response: {
          candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
        },
      },
    ];

    for (const { protocol, response, model } of cases) {
      const calls: string[] = [];
      const patched: Protocol<never> = {
        ...protocol,
        send: async () => {
          calls.push('send');
          return { body: response, headers: { 'x-request-id': 'req-1' } };
        },
        sendStream: async () => {
          calls.push('sendStream');
          return { body: asyncChunks(protocol.replay(response)), headers: { 'x-request-id': 'req-1' } };
        },
      };
      const modelConfig = { ...TEST_MODEL, spec: { ...TEST_MODEL.spec, name: model } };
      const profile = {
        tools: [{
          name: 'Bash',
          description: 'Run a command',
          parameters: { type: 'object', properties: {} },
        }],
      };
      const nonStream = await runGenerate(patched, {
        module: testModule({ model: modelConfig, profile }),
        stream: false,
      });
      const streamed = await runGenerate(patched, {
        module: testModule({ model: modelConfig, profile }),
        stream: true,
      });
      const semantic = (events: typeof nonStream.events) => events
        .filter((event) => event.type.startsWith('llm.delta.') || event.type === 'llm.ended')
        .map((event) => {
          if (event.type === 'llm.delta.timing') {
            return {
              ...event,
              firstTokenLatencyMs: undefined,
              streamDurationMs: undefined,
              requestBuildMs: undefined,
              serverFirstTokenMs: undefined,
              serverDecodeMs: undefined,
              clientConsumeMs: undefined,
              clientBlockedMs: undefined,
            };
          }
          return event.type === 'llm.ended'
            ? { ...event, outcome: { ...event.outcome, timing: undefined } }
            : event;
        });

      expect(calls).toEqual(['send', 'sendStream']);
      expect(nonStream.outcome.type).toBe('done');
      expect(semantic(nonStream.events)).toEqual(semantic(streamed.events));
      expect(semantic(nonStream.events).map((event) => event.type)).toContain('llm.delta.part');
      expect(semantic(nonStream.events).map((event) => event.type)).toContain('llm.delta.finish');
      expect(semantic(nonStream.events).at(-1)?.type).toBe('llm.ended');
    }
  });
});

describe('thinking request configuration', () => {
  it('encodes thinking configs and resolves thinking defaults and keep', () => {
    const declared = {
      ...TEST_MODEL.spec,
      capability: { thinking: true },
      thinking: { supportEfforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
    };
    const withoutDefault = {
      ...declared,
      thinking: { supportEfforts: ['low', 'medium', 'high'] },
    };
    expect(modelSupportsThinking(declared)).toBe(true);
    expect(modelSupportsThinking(TEST_MODEL.spec)).toBe(true);
    expect(modelSupportsThinking({ ...TEST_MODEL.spec, capability: { thinking: false }, thinking: undefined })).toBe(false);
    expect(defaultThinkingEffortForModel(declared)).toBe('high');
    expect(defaultThinkingEffortForModel(withoutDefault)).toBe('medium');
    expect(defaultThinkingEffortForModel({ ...TEST_MODEL.spec, capability: { thinking: false }, thinking: undefined })).toBe('off');

    expect(resolveThinkingEffortForModel(' Max ', undefined, declared)).toBe('max');
    expect(resolveThinkingEffortForModel(undefined, { enabled: false }, declared)).toBe('off');
    expect(resolveThinkingEffortForModel(undefined, { effort: 'low' }, declared)).toBe('low');
    expect(resolveThinkingEffortForModel('high', { enabled: false }, declared)).toBe('high');
    expect(resolveThinkingEffortForModel(undefined, undefined, declared)).toBe('high');
    expect(resolveThinkingEffortForModel(undefined, undefined, withoutDefault)).toBe('medium');
    expect(resolveThinkingEffortForModel('max', undefined, declared, true)).toBe('high');
    expect(resolveThinkingEffortForModel('on', undefined, declared, true)).toBe('high');
    expect(resolveThinkingEffortForModel('off', undefined, declared, true)).toBe('off');

    const always = {
      ...declared,
      thinking: { supportEfforts: ['low', 'high'], alwaysThinking: true },
    };
    expect(resolveThinkingEffortForModel('off', undefined, always)).toBe('high');
    expect(resolveThinkingEffortForModel(undefined, { enabled: false, effort: 'low' }, always)).toBe('low');

    expect(resolveThinkingKeep(undefined, undefined, 'high')).toBe('all');
    expect(resolveThinkingKeep(undefined, undefined, 'off')).toBeUndefined();
    expect(resolveThinkingKeep('0', 'all', 'high')).toBeUndefined();
    expect(resolveThinkingKeep(undefined, 'none', 'high')).toBeUndefined();
    expect(resolveThinkingKeep('2', 'all', 'high')).toBe('2');
    expect(resolveThinkingKeep(undefined, '1', 'high')).toBe('1');
  });

  it('sends disabled thinking for off', () => {
    const request = kimiOpenAIProtocol.encode(modelWith({
      model: { ...TEST_MODEL, thinking: { effort: 'off' } },
    }));
    expect(record(request.params)['thinking']).toEqual({ type: 'disabled' });
  });

  it('sends the configured offEffort when thinking is off', () => {
    const request = openAIProtocol.encode(modelWith({
      model: {
        ...TEST_MODEL,
        spec: {
          ...TEST_MODEL.spec,
          thinking: { supportEfforts: ['low', 'high'], offEffort: 'none' },
        },
        thinking: { effort: 'off' },
      },
    }));
    expect(record(request.params)['reasoning_effort']).toBe('none');
  });

  it('sends nothing for on without a thinking strategy', () => {
    const request = openAIProtocol.encode(modelWith({
      model: { ...TEST_MODEL, thinking: { effort: 'on' } },
    }));
    expect(record(request.params)['reasoning_effort']).toBeUndefined();
    expect(record(request.params)['thinking']).toBeUndefined();
  });

  it('selects the outbound reasoning key from the requester option or inbound detection', () => {
    const messages = [
      createUserMessage('hi'),
      createAssistantMessage([
        { type: 'think', think: 'A', reasoningKey: 'reasoning_content' },
        { type: 'think', think: 'B' },
      ]),
    ];
    const request = openAIProtocol.encode(modelWith({
      model: { ...TEST_MODEL, thinking: { effort: 'off' } },
      messages,
      options: { reasoningKey: 'reasoning' },
    }));
    const assistant = records(record(request.params)['messages'])[1]!;
    expect(assistant['reasoning_content']).toBe('A');
    expect(assistant['reasoning']).toBe('B');
  });
});

describe('Google thinking levels', () => {
  it.each(['gemini-3-pro-preview', 'gemini-4-argon'])('encodes thinking as a level for %s', (name) => {
    const request = googleGenAIProtocol.encode(modelWith({
      model: {
        ...TEST_MODEL,
        spec: { ...TEST_MODEL.spec, name },
        thinking: { effort: 'high' },
      },
    }));
    expect(record(record(request.params)['config'])['thinkingConfig']).toEqual({
      includeThoughts: true,
      thinkingLevel: 'HIGH',
    });
  });

  it('encodes effort off for gemini-3 as MINIMAL with thoughts hidden', () => {
    const request = googleGenAIProtocol.encode(modelWith({
      model: {
        ...TEST_MODEL,
        spec: { ...TEST_MODEL.spec, name: 'gemini-3-pro-preview' },
        thinking: { effort: 'off' },
      },
    }));
    expect(record(record(request.params)['config'])['thinkingConfig']).toEqual({
      includeThoughts: false,
      thinkingLevel: 'MINIMAL',
    });
  });

  it('rejects effort off for gemini-4 (thinking cannot be disabled)', async () => {
    const clientFactory = vi.fn(() => null);
    const { outcome } = await runGenerate(googleGenAIProtocol, {
      module: testModule({
        model: {
          ...TEST_MODEL,
          spec: { ...TEST_MODEL.spec, name: 'gemini-4-argon' },
          thinking: { effort: 'off' },
        },
      }),
      endpoint: { clientFactory },
    });

    expect(outcome).toMatchObject({
      type: 'failed',
      error: { kind: 'syntax', code: 'thinking_config', message: expect.stringContaining('always reasons') },
    });
    expect(clientFactory).not.toHaveBeenCalled();
  });
});
