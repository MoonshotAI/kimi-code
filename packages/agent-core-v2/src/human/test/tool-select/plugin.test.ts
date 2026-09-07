import { describe, expect, it } from 'vitest';

import { createActor, waitFor } from '#/xstate2';
import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import {
  createAssistantMessage,
  createUserMessage,
  extractText,
  type SystemMessage,
  type ToolCall,
  type UserMessage,
} from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { createLlmMachine } from '#/llm/requester/machine';
import type { LlmRequestConfig, LlmRequester, LlmRequestEvent } from '#/llm/requester/requester';
import { connectPlugins, type AgentPluginTarget } from '#/plugin';
import { createAgentMachine, type AgentEmitted } from '#/agent/machine';
import { createTurnMachine, type HistoryMessage } from '#/agent/turn';
import type { ToolExecuteInput } from '#/tool/executor';
import { defineTool, type ToolDefinition } from '#/tool/tool';
import {
  createToolSelectState,
  SELECT_TOOLS_TOOL_NAME,
  type ToolSelectState,
} from '#/tool-select/state';
import { createSelectToolsTool, deferTool } from '#/tool-select/tool';
import {
  createToolSelectPlugin,
  DYNAMIC_TOOL_SCHEMA_REMINDER_KEY,
  LOADABLE_TOOLS_REMINDER_KEY,
} from '#/tool-select/plugin';
import { createToolSelectMessageResolver } from '#/tool-select/resolver';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

function toolCall(name: string, args: unknown, id = 'call-1'): ToolCall {
  return { type: 'function', id, name, arguments: JSON.stringify(args) };
}

function executeInput(name: string, args: unknown): ToolExecuteInput {
  return { toolCall: toolCall(name, args), signal: new AbortController().signal };
}

function weatherTool(execute?: ToolDefinition['execute']): ToolDefinition {
  return defineTool({
    name: 'get_weather',
    description: 'get weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
    execute:
      execute ??
      (() => Promise.resolve({ content: [{ type: 'text', text: 'sunny' }] })),
  });
}

function enabledState(loadable: readonly ToolDefinition[] = [weatherTool()]): ToolSelectState {
  return createToolSelectState({ loadable: () => loadable, enabled: () => true });
}

describe('select_tools tool', () => {
  it('errors when the feature is not enabled', async () => {
    const state = createToolSelectState({ loadable: () => [weatherTool()], enabled: () => false });
    const result = await createSelectToolsTool(state).execute(
      executeInput(SELECT_TOOLS_TOOL_NAME, { names: ['get_weather'] }),
    );
    expect(result.isError).toBe(true);
    expect(extractText({ role: 'tool', toolCallId: 'call-1', content: result.content })).toContain(
      'not available',
    );
  });

  it('loads known tools, reports already available and unknown names', async () => {
    const state = enabledState();
    const tool = createSelectToolsTool(state);

    const first = await tool.execute(
      executeInput(SELECT_TOOLS_TOOL_NAME, { names: ['get_weather', 'missing'] }),
    );
    const firstText = extractText({ role: 'tool', toolCallId: 'call-1', content: first.content });
    expect(firstText).toContain('Loaded: get_weather');
    expect(firstText).toContain('Unknown tool: missing');
    expect(state.pendingSchemas().map((schema) => schema.name)).toEqual(['get_weather']);

    state.markSchemasLanded();
    const second = await tool.execute(
      executeInput(SELECT_TOOLS_TOOL_NAME, { names: ['get_weather'] }),
    );
    expect(extractText({ role: 'tool', toolCallId: 'call-1', content: second.content })).toContain(
      'Already available: get_weather',
    );
  });

  it('rejects an empty names list', async () => {
    const state = enabledState();
    const result = await createSelectToolsTool(state).execute(
      executeInput(SELECT_TOOLS_TOOL_NAME, { names: [] }),
    );
    expect(result.isError).toBe(true);
  });
});

describe('tool select announcements', () => {
  it('diffs against the announced set and folds removals', () => {
    const tools = [weatherTool()];
    const state = createToolSelectState({ loadable: () => tools, enabled: () => true });

    const first = state.announcement();
    expect(first).toContain('<tools_added>');
    expect(first).toContain('get_weather');

    state.markAnnounced();
    expect(state.announcement()).toBeUndefined();

    tools.pop();
    const removed = state.announcement();
    expect(removed).toContain('<tools_removed>');
    expect(removed).toContain('get_weather');
  });

  it('stays silent when disabled', () => {
    const state = createToolSelectState({ loadable: () => [weatherTool()], enabled: () => false });
    expect(state.announcement()).toBeUndefined();
  });
});

describe('deferTool', () => {
  it('intercepts calls to tools that are not loaded', async () => {
    const state = enabledState();
    const deferred = deferTool(weatherTool(), state);
    expect(deferred.deferred).toBe(true);

    const result = await deferred.execute(executeInput('get_weather', { city: 'sh' }));
    expect(result.isError).toBe(true);
    expect(extractText({ role: 'tool', toolCallId: 'call-1', content: result.content })).toContain(
      'Call select_tools with ["get_weather"] first',
    );
  });

  it('passes through once the tool is loaded', async () => {
    const state = enabledState();
    const deferred = deferTool(weatherTool(), state);
    state.load(['get_weather']);
    const result = await deferred.execute(executeInput('get_weather', { city: 'sh' }));
    expect(result.isError).toBeUndefined();
    expect(extractText({ role: 'tool', toolCallId: 'call-1', content: result.content })).toBe(
      'sunny',
    );
  });
});

function createTarget() {
  const handlers = new Map<string, ((event: AgentEmitted) => void)[]>();
  const reminded: { key: string; message: UserMessage | SystemMessage }[] = [];
  const target: AgentPluginTarget = {
    kind: 'agent',
    on: (type, handler) => {
      handlers.set(type, [...(handlers.get(type) ?? []), handler]);
    },
    notify: () => undefined,
    remind: (key, message) => {
      reminded.push({ key, message });
    },
  };
  const emit = (event: AgentEmitted) => {
    for (const handler of handlers.get(event.type) ?? []) handler(event);
  };
  return { target, reminded, emit };
}

describe('tool select plugin', () => {
  it('announces on turn start and pushes schemas after a tool completes', async () => {
    const state = enabledState();
    const plugin = createToolSelectPlugin(state);
    const { target, reminded, emit } = createTarget();
    plugin.connect?.(target);

    emit({ type: 'turn.start', turnId: 1, branchId: 'main' });
    expect(reminded).toHaveLength(1);
    expect(reminded[0]?.key).toBe(LOADABLE_TOOLS_REMINDER_KEY);
    expect(extractText(reminded[0]?.message as UserMessage)).toContain('get_weather');

    state.load(['get_weather']);
    emit({ type: 'tool.done', toolCallId: 'call-1', result: { content: [] } });
    expect(reminded).toHaveLength(2);
    expect(reminded[1]?.key).toBe(DYNAMIC_TOOL_SCHEMA_REMINDER_KEY);
    const schemaMessage = reminded[1]?.message as SystemMessage;
    expect(schemaMessage.role).toBe('system');
    expect(schemaMessage.tools?.map((tool) => tool.name)).toEqual(['get_weather']);

    emit({
      type: 'turn.remindersConsumed',
      reminders: [
        { message: reminded[0]?.message as UserMessage, meta: { source: 'reminder', key: LOADABLE_TOOLS_REMINDER_KEY } },
        { message: schemaMessage, meta: { source: 'reminder', key: DYNAMIC_TOOL_SCHEMA_REMINDER_KEY } },
      ],
    });
    expect(state.isLoaded('get_weather')).toBe(true);
    expect(state.pendingSchemas()).toEqual([]);

    emit({ type: 'tool.done', toolCallId: 'call-2', result: { content: [] } });
    expect(reminded).toHaveLength(2);
  });

  it('resets state on context.reset', () => {
    const state = enabledState();
    const plugin = createToolSelectPlugin(state);
    const { target, emit } = createTarget();
    plugin.connect?.(target);

    emit({ type: 'turn.start', turnId: 1, branchId: 'main' });
    state.load(['get_weather']);
    emit({ type: 'context.reset', branchId: 'main' });
    expect(state.isLoaded('get_weather')).toBe(false);
    expect(state.announcement()).toContain('get_weather');
  });
});

describe('tool select message resolver', () => {
  const declaration: SystemMessage = {
    role: 'system',
    content: [],
    tools: [
      { name: 'get_weather', description: 'get weather', parameters: { type: 'object' } },
      { name: 'get_time', description: 'get time', parameters: { type: 'object' } },
    ],
  };

  it('strips tool declarations when disabled', async () => {
    const state = createToolSelectState({ loadable: () => [weatherTool()], enabled: () => false });
    const resolver = createToolSelectMessageResolver(state);
    const resolved = await resolver.resolve([declaration, createUserMessage('hi')], {
      model,
      signal: new AbortController().signal,
    });
    expect(resolved).toEqual([createUserMessage('hi')]);
  });

  it('drops declarations for tools that are no longer loadable', async () => {
    const state = enabledState();
    const resolver = createToolSelectMessageResolver(state);
    const resolved = await resolver.resolve([declaration], {
      model,
      signal: new AbortController().signal,
    });
    const message = resolved[0] as SystemMessage;
    expect(message.tools?.map((tool) => tool.name)).toEqual(['get_weather']);
  });
});

describe('tool select agent flow', () => {
  function streamMessage(
    message: ReturnType<typeof createAssistantMessage>,
    onEvent: ((event: LlmRequestEvent) => void) | undefined,
  ): void {
    for (const part of [...message.content, ...message.toolCalls]) {
      onEvent?.({ type: 'llm.delta', part });
    }
    onEvent?.({
      type: 'llm.finish',
      finish: { finishReason: 'completed', rawFinishReason: 'stop' },
    });
    onEvent?.({ type: 'llm.done' });
  }

  it('loads a deferred tool via select_tools and calls it with its schema in context', async () => {
    const configs: LlmRequestConfig[] = [];
    const responses = [
      createAssistantMessage([], [toolCall(SELECT_TOOLS_TOOL_NAME, { names: ['get_weather'] })]),
      createAssistantMessage([], [toolCall('get_weather', { city: 'sh' }, 'call-2')]),
      createAssistantMessage([{ type: 'text', text: 'done' }]),
    ];
    let call = 0;
    const requester: LlmRequester = {
      generate: (config, _content, { onEvent }) => {
        configs.push(config);
        streamMessage(responses[Math.min(call, responses.length - 1)], onEvent);
        call += 1;
        return Promise.resolve();
      },
    };

    const executed: string[] = [];
    const state = enabledState();
    const plugin = createToolSelectPlugin(state);
    const deferred = deferTool(
      weatherTool(() => {
        executed.push('get_weather');
        return Promise.resolve({ content: [{ type: 'text', text: 'sunny' }] });
      }),
      state,
    );
    const actor = createActor(
      createAgentMachine({
        tools: [createSelectToolsTool(state), deferred],
        turnActor: createTurnMachine(createLlmMachine({ requester })),
      }),
      { input: { request: { model } } },
    );
    connectPlugins(actor, [plugin]);
    actor.start();
    actor.send({ type: 'input.submit', message: createUserMessage('weather?') });
    const snapshot = await waitFor(
      actor,
      (s) => s.matches('idle') && s.context.messages.length > 1,
      { timeout: 5000 },
    );

    const firstTools = configs[0]?.tools?.map((tool) => tool.name) ?? [];
    expect(firstTools).toContain(SELECT_TOOLS_TOOL_NAME);
    expect(firstTools).not.toContain('get_weather');
    expect(executed).toEqual(['get_weather']);

    const schemaEntry = snapshot.context.messages.find(
      (entry: HistoryMessage) => entry.message.role === 'system',
    );
    expect(schemaEntry?.meta.key).toBe(DYNAMIC_TOOL_SCHEMA_REMINDER_KEY);
    const schemaMessage = schemaEntry?.message as SystemMessage;
    expect(schemaMessage.tools?.map((tool) => tool.name)).toEqual(['get_weather']);

    const secondRequest = configs[1];
    expect(secondRequest).toBeDefined();
  });
});
