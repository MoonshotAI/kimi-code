import { describe, expect, it } from 'vitest';

import type { Message, ToolDescription } from '#/llm/message';
import { kimiOpenAIProtocol } from '#/llm/builtin/provider/kimi/protocol';

const AGENT_TOOL: ToolDescription = {
  name: 'Agent',
  description: 'Launch a subagent.',
  parameters: { type: 'object', properties: {} },
};

const OTHER_TOOL: ToolDescription = {
  name: 'Other',
  description: 'Another tool.',
  parameters: { type: 'object', properties: {} },
};

function schemaMessage(tools: readonly ToolDescription[], text = ''): Message {
  return {
    role: 'system',
    content: text === '' ? [] : [{ type: 'text', text }],
    tools: [...tools],
  };
}

function encode(profileTools: readonly ToolDescription[], messages: readonly Message[]) {
  return kimiOpenAIProtocol.encode({
    model: { spec: { provider: 'kimi', name: 'test-model' } },
    profile: { tools: profileTools },
    content: { messages },
    options: undefined,
  });
}

function messageToolNames(params: {
  messages: unknown[];
}): string[] {
  return params.messages.flatMap((message) => {
    const tools = (message as { tools?: Array<{ function: { name: string } }> }).tools;
    return tools?.map((tool) => tool.function.name) ?? [];
  });
}

describe('kimi protocol message-level tools', () => {
  it('drops message-level tools that duplicate request-level tools', () => {
    const { params } = encode([AGENT_TOOL], [schemaMessage([AGENT_TOOL]), {
      role: 'user',
      content: [{ type: 'text', text: 'go' }],
    }]);

    expect(params.tools).toContainEqual({
      type: 'function',
      function: {
        name: 'Agent',
        description: 'Launch a subagent.',
        parameters: { type: 'object', properties: {} },
      },
    });
    expect(messageToolNames(params as { messages: unknown[] })).not.toContain('Agent');
    expect((params as { messages: unknown[] }).messages).toHaveLength(1);
  });

  it('keeps only the non-duplicate entries of a mixed schema message', () => {
    const { params } = encode([AGENT_TOOL], [
      schemaMessage([AGENT_TOOL, OTHER_TOOL], 'keep body'),
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
    ]);

    expect(messageToolNames(params as { messages: unknown[] })).toEqual(['Other']);
    const [first] = (params as { messages: Array<{ role: string; content?: unknown }> }).messages;
    expect(first?.role).toBe('system');
    expect(first?.content).toBe('keep body');
  });

  it('leaves message-level tools without a request-level duplicate untouched', () => {
    const { params } = encode([AGENT_TOOL], [
      schemaMessage([OTHER_TOOL]),
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
    ]);

    expect(messageToolNames(params as { messages: unknown[] })).toEqual(['Other']);
    expect((params as { messages: unknown[] }).messages).toHaveLength(2);
  });

  it('ignores request-level tools that are deferred', () => {
    const { params } = encode([{ ...AGENT_TOOL, deferred: true }], [
      schemaMessage([AGENT_TOOL]),
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
    ]);

    expect(messageToolNames(params as { messages: unknown[] })).toEqual(['Agent']);
    expect((params as { messages: unknown[] }).messages).toHaveLength(2);
  });
});
