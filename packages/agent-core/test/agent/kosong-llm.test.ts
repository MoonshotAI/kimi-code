import {
  emptyUsage,
  type ChatProvider,
  type StreamedMessagePart,
  type ToolCall,
} from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { KosongLLM, type GenerateFn } from '../../src/agent/turn/kosong-llm';
import type { ToolCallDelta } from '../../src/loop';

const provider: ChatProvider = {
  name: 'test',
  modelName: 'test-model',
  thinkingEffort: null,
  async generate() {
    throw new Error('generate should be injected by the test');
  },
  withThinking() {
    return this;
  },
};

describe('KosongLLM streaming tool-call deltas', () => {
  it('maps indexed argument deltas back to the provider tool call id', async () => {
    const deltas = await collectToolCallDeltas([
      {
        type: 'function',
        id: 'call_bash',
        name: 'Bash',
        arguments: null,
        _streamIndex: 0,
      },
      { type: 'tool_call_part', argumentsPart: '{"command"', index: 0 },
      { type: 'tool_call_part', argumentsPart: ':"pwd"}', index: 0 },
    ]);

    expect(deltas).toEqual([
      { toolCallId: 'call_bash', name: 'Bash' },
      { toolCallId: 'call_bash', name: 'Bash', argumentsPart: '{"command"' },
      { toolCallId: 'call_bash', name: 'Bash', argumentsPart: ':"pwd"}' },
    ]);
  });

  it('buffers indexed argument deltas until the provider tool call id is known', async () => {
    const deltas = await collectToolCallDeltas([
      { type: 'tool_call_part', argumentsPart: '{"command"', index: 0 },
      {
        type: 'function',
        id: 'call_bash',
        name: 'Bash',
        arguments: null,
        _streamIndex: 0,
      },
      { type: 'tool_call_part', argumentsPart: ':"pwd"}', index: 0 },
    ]);

    expect(deltas).toEqual([
      { toolCallId: 'call_bash', name: 'Bash' },
      { toolCallId: 'call_bash', name: 'Bash', argumentsPart: '{"command"' },
      { toolCallId: 'call_bash', name: 'Bash', argumentsPart: ':"pwd"}' },
    ]);
    expect(deltas.map((delta) => delta.toolCallId)).not.toContain('0');
  });

  it('uses the latest tool call identity for linear unindexed argument deltas', async () => {
    const deltas = await collectToolCallDeltas([
      {
        type: 'function',
        id: 'call_write',
        name: 'Write',
        arguments: null,
      },
      { type: 'tool_call_part', argumentsPart: '{"path"' },
      { type: 'tool_call_part', argumentsPart: ':"a.txt"}' },
    ]);

    expect(deltas).toEqual([
      { toolCallId: 'call_write', name: 'Write' },
      { toolCallId: 'call_write', name: 'Write', argumentsPart: '{"path"' },
      { toolCallId: 'call_write', name: 'Write', argumentsPart: ':"a.txt"}' },
    ]);
  });
});

async function collectToolCallDeltas(
  parts: readonly StreamedMessagePart[],
): Promise<ToolCallDelta[]> {
  const deltas: ToolCallDelta[] = [];
  const generate: GenerateFn = async (_provider, _systemPrompt, _tools, _history, callbacks) => {
    for (const part of parts) {
      await callbacks?.onMessagePart?.(part);
    }
    return {
      id: 'response-1',
      message: {
        role: 'assistant',
        content: [],
        toolCalls: parts
          .filter((part): part is ToolCall => isToolCall(part))
          .map((toolCall) => stripStreamIndex(toolCall)),
      },
      usage: emptyUsage(),
      finishReason: 'tool_calls',
      rawFinishReason: 'tool_calls',
    };
  };
  const llm = new KosongLLM({
    provider,
    modelName: 'test-model',
    systemPrompt: 'system',
    generate,
  });

  await llm.chat({
    messages: [],
    tools: [],
    signal: new AbortController().signal,
    onToolCallDelta: (delta) => deltas.push(delta),
  });

  return deltas;
}

function isToolCall(part: StreamedMessagePart): part is ToolCall {
  return part.type === 'function';
}

function stripStreamIndex(toolCall: ToolCall): ToolCall {
  const { _streamIndex: _, ...rest } = toolCall;
  return rest;
}
