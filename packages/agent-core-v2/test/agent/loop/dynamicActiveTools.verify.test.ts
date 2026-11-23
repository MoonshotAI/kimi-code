import { call, say, type ModelRequest } from '@moonshot-ai/testkit/model';
import { expect, test as base } from 'vitest';

import { createUserMessage } from '@moonshot-ai/core/llm/message';
import { historyFromContext } from '#/agent/loop/history';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import type { ExecutableTool } from '#/tool/toolContract';

import { testkitAgentFixtures, type TestkitAgentFixtures } from '../../harness';

const test = base.extend<TestkitAgentFixtures>(testkitAgentFixtures());

function executableTool(name: string): ExecutableTool<Record<string, unknown>> {
  return {
    name,
    description: `${name} verification tool.`,
    parameters: { type: 'object', properties: {} },
    resolveExecution: () => ({
      description: `${name} verification tool.`,
      approvalRule: name,
      execute: async () => ({ output: 'ok' }),
    }),
  };
}

function toolNames(request: ModelRequest): string[] {
  return request.view.tools.map((tool) => tool.name);
}

test('keeps turn and operation request tools frozen at the loop-start baseline', async ({ agent, model }) => {
  const loop = agent.get(IAgentLoopService);
  const registry = agent.get(IAgentToolRegistryService);
  const userTools = agent.get(IAgentUserToolService);

  model.script(say('turn one'), say('turn two'), say('turn three'), say('operation done'));
  await agent.rpc.prompt({ input: [{ type: 'text', text: 'first' }] });
  await agent.untilTurnEnd();
  const first = toolNames(model.requests('main')[0]!);
  expect(first).toContain('Read');

  loop.update({ activeToolNames: [...first] });
  registry.register(executableTool('TowerMid'));
  loop.addActiveTool('TowerMid');
  userTools.register({
    name: 'UserMid',
    description: 'UserMid tool.',
    parameters: { type: 'object', properties: {} },
  });
  expect(loop.getActiveToolNames()).toContain('TowerMid');
  expect(loop.getActiveToolNames()).toContain('UserMid');

  await agent.rpc.prompt({ input: [{ type: 'text', text: 'second' }] });
  await agent.untilTurnEnd();
  expect(toolNames(model.requests('main')[1]!)).toEqual(first);

  loop.removeActiveTool('Read');
  expect(loop.getActiveToolNames()).not.toContain('Read');

  await agent.rpc.prompt({ input: [{ type: 'text', text: 'third' }] });
  await agent.untilTurnEnd();
  expect(toolNames(model.requests('main')[2]!)).toEqual(first);

  userTools.unregister('UserMid');
  const signal = new AbortController().signal;
  const requester = await loop.requester.prepareOperation(
    { source: () => ({ type: 'operation', requestKind: 'verify_active_tools' }) },
    signal,
  );
  await requester.generate(
    { content: { messages: [{ role: 'user', content: [{ type: 'text', text: 'summarize' }] }] }, profile: {} },
    { signal },
  );
  const requests = model.requests('main');
  expect(requests).toHaveLength(4);
  expect(toolNames(requests[3]!)).toEqual(first);
});

test('keeps the compaction-style operation request prefix-aligned with the turn request', async ({
  agent,
  model,
}) => {
  const loop = agent.get(IAgentLoopService);
  const lookupTool: ExecutableTool<{ query: string }> = {
    name: 'Lookup',
    description: 'Look up a short test value.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: false,
    },
    resolveExecution: () => ({
      approvalRule: 'Lookup',
      execute: async () => ({ output: 'lookup-result' }),
    }),
  };
  agent.get(IAgentToolRegistryService).register(lookupTool);
  model.script(
    call('Lookup', { query: 'moon' }, { text: 'I will look it up.' }),
    say('The lookup result is lookup-result.'),
  );
  model.lane('compaction').script(say('summary'));

  await agent.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
  await agent.untilApproval(true);
  await agent.untilTurnEnd();
  expect(model.requests('main')).toHaveLength(2);
  const turn = model.requests('main')[1]!;

  loop.update({ activeToolNames: [...toolNames(turn), 'Lookup'] });
  loop.removeActiveTool('Read');
  expect(loop.getActiveToolNames()).not.toContain('Read');

  const instruction = createUserMessage('Compact the conversation.');
  const messages = historyFromContext([...loop.history(), instruction]);
  const signal = new AbortController().signal;
  const requester = await loop.requester.prepareOperation(
    { source: () => ({ type: 'operation', requestKind: 'full_compaction' }) },
    signal,
  );
  await requester.generate({ content: { messages }, profile: {} }, { signal });

  const operations = model.requests('compaction');
  expect(operations).toHaveLength(1);
  const operation = operations[0]!;
  expect(operation.view.system).toBe(turn.view.system);
  expect(operation.view.tools).toEqual(turn.view.tools);
  expect(operation.view.messages.length).toBe(turn.view.messages.length + 2);
  expect(operation.view.messages.slice(0, turn.view.messages.length)).toEqual(turn.view.messages);
});
