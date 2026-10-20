import { describe, expect, it } from 'vitest';

import { createUserEntry } from '@moonshot-ai/agent-core/history/index';
import {
  createAssistantMessage,
  createUserMessage,
  type ToolCall,
  type ToolDescription,
} from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import type { ToolDefinition } from '@moonshot-ai/agent-core/tool/index';

import {
  createHarness,
  harnessInternals,
  memoryHarnessSpace,
  type Harness,
} from '#/runtime/index';
import {
  createSelectToolsTool,
  createToolSelect,
  createToolSelectState,
  deferTool,
} from '#/features/tool-select/index';

type GenerateRest = Parameters<LoopLlmRequester['generate']>[0];

const fakeTool: ToolDefinition = {
  name: 'FakeLoadable',
  description: 'A fake loadable tool.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: () => Promise.resolve({ content: [{ type: 'text', text: 'fake ok' }] }),
};

function textOutcome(text: string, toolCalls: ToolCall[] = []): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls) };
}

function captureTools(): { requester: LoopLlmRequester; seen: ToolDescription[][] } {
  const seen: ToolDescription[][] = [];
  const self: LoopLlmRequester = {
    with: () => self,
    request: (part) => part as unknown as LlmRequest,
    generate: async (rest: GenerateRest) => {
      seen.push([...(rest.profile?.tools ?? [])]);
      return textOutcome('ok');
    },
  };
  return { requester: self, seen };
}

function user(text: string) {
  return createUserEntry(createUserMessage(text), { source: 'input' });
}

function setRequester(
  harness: Harness,
  sessionId: string,
  agentId: string,
  requester: LoopLlmRequester,
): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime =
    session !== undefined
      ? harnessInternals(harness.app).agents.get(session)?.get(agentId)
      : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

async function openAgent(
  enabled: boolean,
): Promise<{ seen: ToolDescription[][]; harness: Harness; runTurn: () => Promise<unknown> }> {
  const harness = createHarness({ space: memoryHarnessSpace() });
  await harness.app.features.add(
    createToolSelect({ loadable: () => [fakeTool], enabled: () => enabled }),
  );
  const session = await harness.app.create({ sessionId: 's1' });
  const agent = await harness.ensureAgent(session, 'main');
  const { requester, seen } = captureTools();
  setRequester(harness, 's1', 'main', requester);
  return {
    seen,
    harness,
    runTurn: async () => {
      const outcome = await agent.loop.runTurn(user('hi'));
      expect(outcome.type).toBe('done');
      return outcome;
    },
  };
}

describe('tool-select feature', () => {
  it('registers loadable tools directly and hides select_tools when dynamic loading is disabled', async () => {
    const { seen, harness, runTurn } = await openAgent(false);
    await runTurn();
    const tools = seen[0] ?? [];
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('FakeLoadable');
    expect(tools.find((tool) => tool.name === 'FakeLoadable')?.deferred).toBeUndefined();
    expect(names).not.toContain('select_tools');
    await harness.close();
  });

  it('defers loadable tools behind select_tools when dynamic loading is enabled', async () => {
    const { seen, harness, runTurn } = await openAgent(true);
    await runTurn();
    const tools = seen[0] ?? [];
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('select_tools');
    expect(tools.find((tool) => tool.name === 'FakeLoadable')?.deferred).toBe(true);
    await harness.close();
  });

  it('marks select_tools and deferred-tool error results with isError', async () => {
    const state = createToolSelectState({ loadable: () => [fakeTool], enabled: () => true });
    const executeOn = (
      tool: ToolDefinition,
      name: string,
      args: unknown,
    ): ReturnType<ToolDefinition['execute']> =>
      tool.execute({
        toolCall: { type: 'function', id: `call-${name}`, name, arguments: JSON.stringify(args) },
        signal: new AbortController().signal,
      });

    const deferred = deferTool(fakeTool, state);
    const notLoaded = await executeOn(deferred, 'FakeLoadable', {});
    expect(notLoaded.isError).toBe(true);

    const selectTools = createSelectToolsTool(state);
    const emptyNames = await executeOn(selectTools, 'select_tools', { names: [] });
    expect(emptyNames.isError).toBe(true);
    const unknownOnly = await executeOn(selectTools, 'select_tools', { names: ['nope'] });
    expect(unknownOnly.isError).toBe(true);
    const loaded = await executeOn(selectTools, 'select_tools', { names: ['FakeLoadable'] });
    expect(loaded.isError).toBeUndefined();

    const disabled = createSelectToolsTool(
      createToolSelectState({ loadable: () => [fakeTool], enabled: () => false }),
    );
    const unavailable = await executeOn(disabled, 'select_tools', { names: ['FakeLoadable'] });
    expect(unavailable.isError).toBe(true);
  });
});
