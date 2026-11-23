import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Message } from '@moonshot-ai/core/llm/message';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { toolSelectKey } from '#/agent/toolSelect/toolSelectOps';
import { IFlagService } from '#/app/flag/flag';
import { IAgentTowerService, TOWER_FLAG_ID } from '#/features/tower/tower';
import { _setTowerFeatureAssembledForTests } from '#/features/tower/towerFeature';
import { TOWER_MODE_TOOLS } from '#/features/tower/towerService';
import type { ToolCall } from '#human/message';

import { stubFlag } from '../../app/flag/stubs';
import { appService, createTestAgent, type TestAgentContext } from '../../harness';

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

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function startAgent(
  capabilities: typeof DYNAMIC_CAPABILITIES | typeof STATIC_CAPABILITIES,
): Promise<TestAgentContext> {
  const cwd = await mkdtemp(join(tmpdir(), 'tower-deferred-e2e-'));
  const ctx = createTestAgent(
    { cwd },
    appService(IFlagService, stubFlag((id) => id === TOWER_FLAG_ID)),
  );
  ctx.configure({ modelCapabilities: capabilities });
  cleanups.push(async () => {
    await ctx.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  return ctx;
}

async function enterBeforeLoopStart(ctx: TestAgentContext): Promise<IAgentTowerService> {
  const tower = ctx.get(IAgentTowerService);
  await tower.enter();
  await ctx.restorePersisted();
  await ctx.rpc.setPermission({ mode: 'yolo' });
  return tower;
}

async function startLoop(ctx: TestAgentContext): Promise<IAgentTowerService> {
  await ctx.restorePersisted();
  await ctx.rpc.setPermission({ mode: 'yolo' });
  return ctx.get(IAgentTowerService);
}

async function prompt(ctx: TestAgentContext, text: string): Promise<void> {
  await ctx.rpc.prompt({ input: [{ type: 'text', text }] });
  await ctx.untilTurnEnd();
}

function selectToolsCall(id: string, names: readonly string[]): ToolCall {
  return { type: 'function', id, name: 'select_tools', arguments: JSON.stringify({ names }) };
}

function towerToolCall(id: string, name: string): ToolCall {
  return { type: 'function', id, name, arguments: '{}' };
}

function toolNames(tools: readonly { readonly name: string }[]): string[] {
  return tools.map((tool) => tool.name);
}

function towerNamesIn(tools: readonly { readonly name: string }[]): string[] {
  return toolNames(tools)
    .filter((name) => TOWER_MODE_TOOLS.includes(name))
    .toSorted();
}

function historyText(history: readonly Message[]): string {
  return history
    .flatMap((message) => message.content)
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

function announcementNames(text: string, kind: 'added' | 'removed'): string[] {
  const block = new RegExp(`<tools_${kind}>\\n([\\s\\S]*?)\\n</tools_${kind}>`).exec(text)?.[1];
  return block === undefined ? [] : block.split('\n').toSorted();
}

function toolsOf(message: Message | undefined) {
  return message?.role === 'system' ? message.tools : undefined;
}

function toolResultText(history: readonly Message[], toolCallId: string): string {
  const message = history.find((entry) => entry.role === 'tool' && entry.toolCallId === toolCallId);
  expect(message, `tool result for ${toolCallId}`).toBeDefined();
  return historyText([message!]);
}

describe('tower deferred tools end-to-end', () => {
  it('session-start enter: a dynamically-loaded-tools model gets the tower tools as deferred baseline loadables', async () => {
    const ctx = await startAgent(DYNAMIC_CAPABILITIES);
    await enterBeforeLoopStart(ctx);

    ctx.mockNextResponse(selectToolsCall('call_select_1', ['TowerStatus']));
    ctx.mockNextResponse(towerToolCall('call_status_1', 'TowerStatus'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await prompt(ctx, 'check the tower');

    const baseline = ctx.get(IAgentLoopService).baselineTools();
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
    const initial = ctx.get(IAgentStateService).get(toolSelectKey).initial ?? [];
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

    expect(ctx.llmCalls).toHaveLength(3);
    const [first, second, third] = ctx.llmCalls;
    expect(toolNames(first!.tools)).toContain('select_tools');
    expect(towerNamesIn(first!.tools)).toEqual([]);
    const announced = announcementNames(historyText(first!.history), 'added');
    for (const name of TOWER_MODE_TOOLS) expect(announced).toContain(name);

    expect(historyText(second!.history)).toContain('Loaded: TowerStatus');
    expect(
      second!.history.some((message) =>
        toolsOf(message)?.some((tool) => tool.name === 'TowerStatus'),
      ),
    ).toBe(true);

    expect(toolResultText(third!.history, 'call_status_1')).toContain('tower is not initialized');
  });

  it('session-start enter: a model without dynamic loading gets the tower tools inline and callable', async () => {
    const ctx = await startAgent(STATIC_CAPABILITIES);
    await enterBeforeLoopStart(ctx);

    ctx.mockNextResponse(towerToolCall('call_status_1', 'TowerStatus'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await prompt(ctx, 'check the tower');

    expect(ctx.llmCalls).toHaveLength(2);
    const [first, second] = ctx.llmCalls;
    expect(towerNamesIn(first!.tools)).toEqual([...SORTED_TOWER_MODE_TOOLS]);
    expect(toolNames(first!.tools)).not.toContain('select_tools');

    expect(toolResultText(second!.history, 'call_status_1')).toContain('tower is not initialized');
  });

  it('mid-session toggle: a dynamically-loaded-tools model gets delta announcements, loadable and stale-gated tools', async () => {
    const ctx = await startAgent(DYNAMIC_CAPABILITIES);
    const tower = await startLoop(ctx);

    ctx.mockNextResponse({ type: 'text', text: 'plain turn' });
    await prompt(ctx, 'hello');
    const before = ctx.llmCalls[0]!;
    expect(towerNamesIn(before.tools)).toEqual([]);

    await tower.enter();

    ctx.mockNextResponse(selectToolsCall('call_select_1', ['TowerStatus']));
    ctx.mockNextResponse(towerToolCall('call_status_1', 'TowerStatus'));
    ctx.mockNextResponse({ type: 'text', text: 'status reported' });
    await prompt(ctx, 'start tower work');

    const [addedWire, loadedWire, calledWire] = ctx.llmCalls.slice(1);
    expect(addedWire!.tools).toEqual(before.tools);
    expect(announcementNames(historyText(addedWire!.history), 'added')).toEqual([
      ...SORTED_TOWER_MODE_TOOLS,
    ]);

    expect(historyText(loadedWire!.history)).toContain('Loaded: TowerStatus');
    expect(
      loadedWire!.history.some((message) =>
        toolsOf(message)?.some((tool) => tool.name === 'TowerStatus'),
      ),
    ).toBe(true);
    expect(toolResultText(calledWire!.history, 'call_status_1')).toContain('tower is not initialized');

    await tower.exit();
    expect(ctx.get(IAgentToolRegistryService).resolve('TowerStatus')).toBeUndefined();

    ctx.mockNextResponse(towerToolCall('call_status_2', 'TowerStatus'));
    ctx.mockNextResponse({ type: 'text', text: 'understood' });
    await prompt(ctx, 'status again');

    const [removedWire, staleWire] = ctx.llmCalls.slice(4);
    expect(announcementNames(historyText(removedWire!.history), 'removed')).toEqual([
      ...SORTED_TOWER_MODE_TOOLS,
    ]);
    expect(toolResultText(staleWire!.history, 'call_status_2')).toContain(
      'was loaded but is no longer',
    );

    await tower.enter();
    ctx.mockNextResponse({ type: 'text', text: 'back again' });
    await prompt(ctx, 're-enter tower');

    expect(ctx.llmCalls).toHaveLength(7);
    const reenterWire = ctx.llmCalls[6]!;
    expect(announcementNames(historyText(reenterWire.history), 'added')).toEqual([
      ...SORTED_TOWER_MODE_TOOLS,
    ]);
    expect(
      towerNamesIn(ctx.get(IAgentToolRegistryService).list()),
    ).toEqual([...SORTED_TOWER_MODE_TOOLS]);
  });

  it('mid-session toggle: a model without dynamic loading keeps request tools unchanged and sees the runtime-change reminder', async () => {
    const ctx = await startAgent(STATIC_CAPABILITIES);
    const tower = await startLoop(ctx);

    ctx.mockNextResponse({ type: 'text', text: 'plain turn' });
    await prompt(ctx, 'hello');
    const before = ctx.llmCalls[0]!;
    expect(towerNamesIn(before.tools)).toEqual([]);

    await tower.enter();
    ctx.mockNextResponse({ type: 'text', text: 'noted' });
    await prompt(ctx, 'start tower work');

    const addedWire = ctx.llmCalls[1]!;
    expect(addedWire.tools).toEqual(before.tools);
    expect(towerNamesIn(addedWire.tools)).toEqual([]);
    const addedText = historyText(addedWire.history);
    expect(addedText).toContain('<tools_added>');
    expect(addedText).toContain(
      'The current model cannot load runtime tool additions with select_tools.',
    );

    await tower.exit();
    ctx.mockNextResponse({ type: 'text', text: 'back to normal' });
    await prompt(ctx, 'stop tower work');

    expect(ctx.llmCalls).toHaveLength(3);
    const removedWire = ctx.llmCalls[2]!;
    expect(removedWire.tools).toEqual(before.tools);
    const removedText = historyText(removedWire.history);
    expect(removedText).toContain('<tools_removed>');
    expect(removedText).toContain(
      'The current model cannot load runtime tool additions with select_tools.',
    );

    for (const call of ctx.llmCalls) {
      expect(towerNamesIn(call.tools)).toEqual([]);
      expect(toolNames(call.tools)).not.toContain('select_tools');
    }
  });
});
