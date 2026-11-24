import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { call, say, type ModelRequest } from '@moonshot-ai/testkit/model';
import { describe, expect, it, type TestContext } from 'vitest';

import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { toolSelectKey } from '#/agent/toolSelect/toolSelectOps';
import { IFlagService } from '#/app/flag/flag';
import { IAgentTowerService, TOWER_FLAG_ID } from '#/features/tower/tower';
import { _setTowerFeatureAssembledForTests } from '#/features/tower/towerFeature';
import { TOWER_MODE_TOOLS } from '#/features/tower/towerService';

import { appService, testkitAgentFixtures, type TestkitAgentFixtures } from '../../harness';
import { stubFlag } from '../../app/flag/stubs';

_setTowerFeatureAssembledForTests(true);

const DYNAMIC_CAPABILITIES = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  dynamically_loaded_tools: true,
  maxContextSize: 128_000,
} as const;
const STATIC_CAPABILITIES = { ...DYNAMIC_CAPABILITIES, dynamically_loaded_tools: false } as const;

const SORTED_TOWER_MODE_TOOLS: readonly string[] = [...TOWER_MODE_TOOLS].toSorted();

type TowerAgent = TestkitAgentFixtures['agent'];
type TowerModel = TestkitAgentFixtures['model'];

interface TowerAgentOptions {
  readonly capabilities: typeof DYNAMIC_CAPABILITIES | typeof STATIC_CAPABILITIES;
  readonly enterBeforeLoopStart?: boolean;
}

async function withTowerAgent(
  context: TestContext,
  options: TowerAgentOptions,
  body: (agent: TowerAgent, model: TowerModel) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'tower-deferred-e2e-'));
  try {
    const fixtures = testkitAgentFixtures(
      appService(IFlagService, stubFlag((id) => id === TOWER_FLAG_ID)),
      { cwd },
    );
    await fixtures.model(context, async (model) => {
      await fixtures.agent({ model }, async (agent) => {
        agent.configure({ modelCapabilities: options.capabilities });
        if (options.enterBeforeLoopStart === true) await agent.get(IAgentTowerService).enter();
        await agent.restorePersisted();
        await agent.rpc.setPermission({ mode: 'yolo' });
        await body(agent, model);
      });
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function requestToolNames(request: ModelRequest): string[] {
  return request.view.tools.map((tool) => tool.name);
}

function towerNamesIn(tools: readonly { readonly name: string }[]): string[] {
  return tools
    .map((tool) => tool.name)
    .filter((name) => TOWER_MODE_TOOLS.includes(name))
    .toSorted();
}

function viewText(request: ModelRequest): string {
  return request.view.messages.map((message) => message.text).join('\n');
}

function announcementNames(text: string, kind: 'added' | 'removed'): string[] {
  const block = new RegExp(`<tools_${kind}>\\n([\\s\\S]*?)\\n</tools_${kind}>`).exec(text)?.[1];
  return block === undefined ? [] : block.split('\n').toSorted();
}

function schemaToolNames(request: ModelRequest): string[] {
  const body = request.body as {
    readonly messages?: readonly {
      readonly tools?: readonly { readonly function?: { readonly name?: string } }[];
    }[];
  };
  return (body.messages ?? []).flatMap((message) =>
    (message.tools ?? []).map((tool) => tool.function?.name ?? ''),
  );
}

function toolResultText(request: ModelRequest, callId: string): string {
  const message = request.view.messages.find(
    (entry) => entry.role === 'tool' && entry.callId === callId,
  );
  expect(message, `tool result for ${callId}`).toBeDefined();
  return message!.text;
}

describe('tower deferred tools end-to-end', () => {
  it('session-start enter: a dynamically-loaded-tools model gets the tower tools as deferred baseline loadables', async (context) => {
    await withTowerAgent(context, { capabilities: DYNAMIC_CAPABILITIES, enterBeforeLoopStart: true }, async (agent, model) => {
      model.script(
        call('select_tools', { names: ['TowerStatus'] }, { id: 'call_select_1' }),
        call('TowerStatus', {}, { id: 'call_status_1', invalid: true }),
        say('done'),
      );
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'check the tower' }] });
      await agent.untilTurnEnd();

      const baseline = agent.get(IAgentLoopService).baselineTools();
      expect(
        baseline
          .filter((tool) => TOWER_MODE_TOOLS.includes(tool.name))
          .map((tool) => tool.name)
          .toSorted(),
      ).toEqual([...SORTED_TOWER_MODE_TOOLS]);
      expect(
        baseline
          .filter((tool) => TOWER_MODE_TOOLS.includes(tool.name))
          .every((tool) => tool.deferred === true),
      ).toBe(true);
      const initial = agent.get(IAgentStateService).get(toolSelectKey).initial ?? [];
      expect(
        initial
          .filter((tool) => TOWER_MODE_TOOLS.includes(tool.name))
          .map((tool) => tool.name)
          .toSorted(),
      ).toEqual([...SORTED_TOWER_MODE_TOOLS]);
      expect(
        initial
          .filter((tool) => TOWER_MODE_TOOLS.includes(tool.name))
          .every((tool) => tool.disclosure === 'deferred'),
      ).toBe(true);

      const requests = model.requests('main');
      expect(requests).toHaveLength(3);
      const [first, second, third] = requests;
      expect(requestToolNames(first!)).toContain('select_tools');
      expect(towerNamesIn(first!.view.tools)).toEqual([]);
      const announced = announcementNames(viewText(first!), 'added');
      for (const name of TOWER_MODE_TOOLS) expect(announced).toContain(name);

      expect(viewText(second!)).toContain('Loaded: TowerStatus');
      expect(schemaToolNames(second!)).toContain('TowerStatus');

      expect(toolResultText(third!, 'call_status_1')).toContain('tower is not initialized');
    });
  });

  it('session-start enter: a model without dynamic loading gets the tower tools inline and callable', async (context) => {
    await withTowerAgent(context, { capabilities: STATIC_CAPABILITIES, enterBeforeLoopStart: true }, async (agent, model) => {
      model.script(call('TowerStatus', {}, { id: 'call_status_1' }), say('done'));
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'check the tower' }] });
      await agent.untilTurnEnd();

      const requests = model.requests('main');
      expect(requests).toHaveLength(2);
      const [first, second] = requests;
      expect(towerNamesIn(first!.view.tools)).toEqual([...SORTED_TOWER_MODE_TOOLS]);
      expect(requestToolNames(first!)).not.toContain('select_tools');

      expect(toolResultText(second!, 'call_status_1')).toContain('tower is not initialized');
    });
  });

  it('mid-session toggle: a dynamically-loaded-tools model gets delta announcements, loadable and stale-gated tools', async (context) => {
    await withTowerAgent(context, { capabilities: DYNAMIC_CAPABILITIES }, async (agent, model) => {
      const tower = agent.get(IAgentTowerService);

      model.script(say('plain turn'));
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
      await agent.untilTurnEnd();
      const before = model.requests('main')[0]!;
      expect(towerNamesIn(before.view.tools)).toEqual([]);

      await tower.enter();

      model.script(
        call('select_tools', { names: ['TowerStatus'] }, { id: 'call_select_1' }),
        call('TowerStatus', {}, { id: 'call_status_1', invalid: true }),
        say('status reported'),
      );
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'start tower work' }] });
      await agent.untilTurnEnd();

      const [addedWire, loadedWire, calledWire] = model.requests('main').slice(1);
      expect(addedWire!.view.tools).toEqual(before.view.tools);
      expect(announcementNames(viewText(addedWire!), 'added')).toEqual([
        ...SORTED_TOWER_MODE_TOOLS,
      ]);

      expect(viewText(loadedWire!)).toContain('Loaded: TowerStatus');
      expect(schemaToolNames(loadedWire!)).toContain('TowerStatus');
      expect(toolResultText(calledWire!, 'call_status_1')).toContain('tower is not initialized');

      await tower.exit();
      expect(agent.get(IAgentToolRegistryService).resolve('TowerStatus')).toBeUndefined();

      model.script(
        call('TowerStatus', {}, { id: 'call_status_2', invalid: true }),
        say('understood'),
      );
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'status again' }] });
      await agent.untilTurnEnd();

      const [removedWire, staleWire] = model.requests('main').slice(4);
      expect(announcementNames(viewText(removedWire!), 'removed')).toEqual([
        ...SORTED_TOWER_MODE_TOOLS,
      ]);
      expect(toolResultText(staleWire!, 'call_status_2')).toContain('was loaded but is no longer');

      await tower.enter();
      model.script(say('back again'));
      await agent.rpc.prompt({ input: [{ type: 'text', text: 're-enter tower' }] });
      await agent.untilTurnEnd();

      const requests = model.requests('main');
      expect(requests).toHaveLength(7);
      expect(announcementNames(viewText(requests[6]!), 'added')).toEqual([
        ...SORTED_TOWER_MODE_TOOLS,
      ]);
      expect(
        towerNamesIn(agent.get(IAgentToolRegistryService).list()),
      ).toEqual([...SORTED_TOWER_MODE_TOOLS]);
    });
  });

  it('mid-session toggle: a model without dynamic loading keeps request tools unchanged and sees the runtime-change reminder', async (context) => {
    await withTowerAgent(context, { capabilities: STATIC_CAPABILITIES }, async (agent, model) => {
      const tower = agent.get(IAgentTowerService);

      model.script(say('plain turn'));
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
      await agent.untilTurnEnd();
      const before = model.requests('main')[0]!;
      expect(towerNamesIn(before.view.tools)).toEqual([]);

      await tower.enter();
      model.script(say('noted'));
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'start tower work' }] });
      await agent.untilTurnEnd();

      const addedWire = model.requests('main')[1]!;
      expect(addedWire.view.tools).toEqual(before.view.tools);
      expect(towerNamesIn(addedWire.view.tools)).toEqual([]);
      const addedText = viewText(addedWire);
      expect(addedText).toContain('<tools_added>');
      expect(addedText).toContain(
        'The current model cannot load runtime tool additions with select_tools.',
      );

      await tower.exit();
      model.script(say('back to normal'));
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'stop tower work' }] });
      await agent.untilTurnEnd();

      const requests = model.requests('main');
      expect(requests).toHaveLength(3);
      const removedWire = requests[2]!;
      expect(removedWire.view.tools).toEqual(before.view.tools);
      const removedText = viewText(removedWire);
      expect(removedText).toContain('<tools_removed>');
      expect(removedText).toContain(
        'The current model cannot load runtime tool additions with select_tools.',
      );

      for (const request of requests) {
        expect(towerNamesIn(request.view.tools)).toEqual([]);
        expect(requestToolNames(request)).not.toContain('select_tools');
      }
    });
  });
});
