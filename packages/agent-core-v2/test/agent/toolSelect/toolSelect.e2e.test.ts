import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from 'vitest';
import { appendContext } from '../contextMemory/stubs';
import { createControlledPromise } from '@antfu/utils';
import { call, say } from '@moonshot-ai/testkit/model';

import { IAgentConversationUndoService } from '#/agent/undo/undo';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import type { ExecutableTool, ToolExecution } from '#/tool/toolContract';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IAgentToolSelectAnnouncementsService } from '#/agent/toolSelect/toolSelectAnnouncements';
import { isToolSelectAnnouncementDisclosure, LOADABLE_TOOLS_VARIANT } from '#/agent/toolSelect/dynamicTools';
import { toolSelectKey } from '#/agent/toolSelect/toolSelectOps';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { McpConnectionManager } from '#/mcpCore/connection-manager';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import '#/agent/tools/select-tools/selectToolsTool';

import {
  createTestAgent,
  InMemoryWireRecordPersistence,
  mcpServices,
  sessionService,
  testkitAgentFixtures,
  wireRecordPersistenceServices,
  type TestAgentContext,
  type TestkitAgentFixtures,
} from '../../harness';
import { createMemoryMcpOAuthStore, startEchoHttpMcpServer } from '../../mcpCore/stubs';
import type { Message } from '@moonshot-ai/core/llm/message';

function toolsOf(message: Message | undefined) {
  return message?.role === 'system' ? message.tools : undefined;
}

const MCP_ALPHA = 'mcp__srv__alpha';
const DASHBOARD_TOOL = 'dashboard_create';

const DISCLOSURE_CAPABILITIES = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  maxContextSize: 128_000,
  dynamically_loaded_tools: true,
} as const;

class StubMcpTool implements ExecutableTool<Record<string, unknown>> {
  description: string;
  readonly parameters: Record<string, unknown> = {
    type: 'object',
    properties: { query: { type: 'string' } },
    additionalProperties: false,
  };
  calls = 0;

  constructor(readonly name: string) {
    this.description = `${name} desc`;
  }

  resolveExecution(): ToolExecution {
    return {
      description: `stub ${this.name}`,
      approvalRule: this.name,
      execute: async () => {
        this.calls += 1;
        return { output: 'mcp ok' };
      },
    };
  }
}

function selectToolsCall(id: string, names: readonly string[]) {
  return {
    type: 'function' as const,
    id,
    name: 'select_tools',
    arguments: JSON.stringify({ names }),
  };
}

function toolNames(tools: readonly { readonly name: string }[]): string[] {
  return tools.map((tool) => tool.name);
}

function historyText(history: readonly ContextMessage[]): string {
  return history
    .flatMap((message) => message.content)
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

function viewText(request: { readonly view: { readonly messages: readonly { readonly text: string }[] } }): string {
  return request.view.messages.map((message) => message.text).join('\n');
}

async function withTestkitMcpAgent(
  context: TestContext,
  mcp: { readonly ready: Promise<void>; readonly onWait: () => void },
  body: (agent: TestkitAgentFixtures['agent'], model: TestkitAgentFixtures['model']) => Promise<void>,
): Promise<void> {
  const fixtures = testkitAgentFixtures(sessionService(ISessionMcpHandle, {
    _serviceBrand: undefined,
    get ready() {
      mcp.onWait();
      return mcp.ready;
    },
    connectionManager: new McpConnectionManager(),
    isBaselineServer: () => true,
  }));
  await fixtures.model(context, async (model) => {
    await fixtures.agent({ model }, async (agent) => body(agent, model));
  });
}

describe('progressive tool disclosure end-to-end', () => {
  let ctx: TestAgentContext;
  let alpha: StubMcpTool;
  let registration: { dispose(): void } | undefined;
  let mcpReady: Promise<void>;
  let onMcpWait: () => void;

  beforeEach(async () => {
    mcpReady = Promise.resolve();
    onMcpWait = () => {};
    ctx = createTestAgent(sessionService(ISessionMcpHandle, {
      _serviceBrand: undefined,
      get ready() {
        onMcpWait();
        return mcpReady;
      },
      connectionManager: new McpConnectionManager(),
      isBaselineServer: () => true,
    }));
    ctx.get(IAgentToolSelectService);
    ctx.get(IAgentToolSelectAnnouncementsService);
    ctx.get(IAgentToolExecutorService);
    ctx.configure({ modelCapabilities: DISCLOSURE_CAPABILITIES });
    await ctx.restorePersisted();
    await ctx.rpc.setPermission({ mode: 'yolo' });
    alpha = new StubMcpTool(MCP_ALPHA);
    registration = ctx
      .get(IAgentToolRegistryService)
      .register(alpha, { source: 'mcp', disclosure: 'deferred' });
  });

  afterEach(async () => {
    registration?.dispose();
    vi.unstubAllEnvs();
    await ctx.dispose();
  });

  it('announces MCP tools discovered during startup in the first model request', async (context) => {
    const ready = createControlledPromise<void>();
    const waiting = createControlledPromise<void>();
    await withTestkitMcpAgent(context, { ready, onWait: waiting.resolve }, async (agent, model) => {
      agent.get(IAgentToolSelectService);
      agent.get(IAgentToolSelectAnnouncementsService);
      agent.get(IAgentToolExecutorService);
      agent.configure({ modelCapabilities: DISCLOSURE_CAPABILITIES });

      const restored = agent.restorePersisted();
      await waiting;
      expect(model.requests('main')).toHaveLength(0);
      registration = agent.get(IAgentToolRegistryService)
        .register(alpha, { source: 'mcp', disclosure: 'deferred' });
      ready.resolve();
      await restored;
      await agent.rpc.setPermission({ mode: 'yolo' });
      model.script(say('done'));
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'use the server tool' }] });
      await agent.untilTurnEnd();

      const firstWire = model.requests('main')[0]!;
      expect(firstWire.view.tools.map((tool) => tool.name)).not.toContain(MCP_ALPHA);
      expect(firstWire.view.tools.map((tool) => tool.name)).toContain('select_tools');
      expect(agent.get(IAgentStateService).get(toolSelectKey).initial?.map((tool) => tool.name))
        .toContain(MCP_ALPHA);
      expect(viewText(firstWire)).toContain(MCP_ALPHA);
    });
  });

  async function expectStartupToolExposed(
    context: TestContext,
    disclosure: 'inline' | 'deferred',
    dynamicallyLoaded: boolean,
  ): Promise<void> {
    const ready = createControlledPromise<void>();
    const waiting = createControlledPromise<void>();
    await withTestkitMcpAgent(context, { ready, onWait: waiting.resolve }, async (agent, model) => {
      agent.get(IAgentToolSelectService);
      agent.get(IAgentToolSelectAnnouncementsService);
      agent.get(IAgentToolExecutorService);
      agent.configure({
        modelCapabilities: { ...DISCLOSURE_CAPABILITIES, dynamically_loaded_tools: dynamicallyLoaded },
      });

      const restored = agent.restorePersisted();
      await waiting;
      expect(model.requests('main')).toHaveLength(0);
      registration = agent.get(IAgentToolRegistryService)
        .register(alpha, { source: 'mcp', disclosure });
      ready.resolve();
      await restored;
      await agent.rpc.setPermission({ mode: 'yolo' });
      model.script(say('done'));
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'use the server tool' }] });
      await agent.untilTurnEnd();

      const firstWire = model.requests('main')[0]!;
      expect(firstWire.view.tools.map((tool) => tool.name)).toContain(MCP_ALPHA);
      expect(agent.get(IAgentStateService).get(toolSelectKey).initial?.map((tool) => tool.name))
        .toContain(MCP_ALPHA);
      const schema = firstWire.view.tools.find((tool) => tool.name === MCP_ALPHA);
      expect(schema?.parameters).toEqual(alpha.parameters);
      expect(schema).not.toHaveProperty('deferred', true);
    });
  }

  it('exposes inline MCP tools discovered during startup in the first request tools (dynamic: true)', (context) =>
    expectStartupToolExposed(context, 'inline', true));

  it('exposes inline MCP tools discovered during startup in the first request tools (dynamic: false)', (context) =>
    expectStartupToolExposed(context, 'inline', false));

  it('exposes deferred MCP tools discovered during startup in the first request tools (dynamic: false)', (context) =>
    expectStartupToolExposed(context, 'deferred', false));

  it('cancels a prompt queued while startup MCP discovery is pending without sending a request', async (context) => {
    const ready = createControlledPromise<void>();
    const waiting = createControlledPromise<void>();
    await withTestkitMcpAgent(context, { ready, onWait: waiting.resolve }, async (agent, model) => {
      agent.configure({ modelCapabilities: DISCLOSURE_CAPABILITIES });

      const loop = agent.get(IAgentLoopService);
      const { id } = loop.submit({
        role: 'user',
        content: [{ type: 'text', text: 'use the server tool' }],
      });
      const handle = loop.promptHandle(id)!;
      await waiting;
      expect(model.requests('main')).toHaveLength(0);
      loop.cancel({ promptId: id });
      ready.resolve();
      await agent.restorePersisted();
      await handle.completion;

      expect(handle.state).toBe('cancelled');
      expect(model.requests('main')).toHaveLength(0);
    });
  });

  it('announces, loads, preserves schemas through replacements and restore, and keeps the baseline stable', async () => {
    const inlineName = 'mcp__srv__inline';
    const inlineTool = new StubMcpTool(inlineName);
    const inlineRegistration = ctx.get(IAgentToolRegistryService).register(inlineTool, {
      source: 'mcp',
      disclosure: 'deferred',
    });
    ctx.mockNextResponse(selectToolsCall('call_select_1', [MCP_ALPHA, inlineName]));
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_alpha_1',
      name: MCP_ALPHA,
      arguments: JSON.stringify({ query: 'moon' }),
    });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'try the srv alpha tool' }] });
    await ctx.untilTurnEnd();
    const initialTools = ctx.get(IAgentStateService).get(toolSelectKey).initial;
    const initialAnnouncements = ctx.get(IAgentLoopService).history().filter(
      (message) => message.origin?.kind === 'injection' && message.origin.variant === LOADABLE_TOOLS_VARIANT,
    );
    expect(initialAnnouncements).toHaveLength(1);
    expect(initialAnnouncements[0]).toMatchObject({
      origin: { disclosure: { kind: 'delta', added: [
        { name: MCP_ALPHA },
        { name: inlineName },
      ] } },
    });

    inlineRegistration.dispose();
    const updatedInlineTool = new StubMcpTool(inlineName);
    updatedInlineTool.description = `${inlineName} updated desc`;
    ctx.get(IAgentToolRegistryService).register(updatedInlineTool, { source: 'mcp', disclosure: 'inline' });
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_inline_1',
      name: inlineName,
      arguments: JSON.stringify({ query: 'moon' }),
    });
    ctx.mockNextResponse({ type: 'text', text: 'after inline replacement' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'try the replacement inline tool' }] });
    await ctx.untilTurnEnd();

    const runtimeTool = 'mcp__srv__runtime';
    const runtimeRegistration = ctx.get(IAgentToolRegistryService).register(new StubMcpTool(runtimeTool), {
      source: 'mcp',
      disclosure: 'deferred',
    });
    ctx.mockNextResponse({ type: 'text', text: 'runtime added' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'announce the runtime addition' }] });
    await ctx.untilTurnEnd();
    runtimeRegistration.dispose();
    ctx.mockNextResponse({ type: 'text', text: 'runtime removed' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'announce the runtime removal' }] });
    await ctx.untilTurnEnd();

    ctx.configure({
      provider: { type: 'kimi', model: 'no-dynamic-tools' },
      modelCapabilities: { ...DISCLOSURE_CAPABILITIES, dynamically_loaded_tools: false },
    });
    ctx.mockNextResponse({ type: 'text', text: 'after switch' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue after the model switch' }] });
    await ctx.untilTurnEnd();
    ctx.configure({ provider: { type: 'kimi', model: 'mock-model' }, modelCapabilities: DISCLOSURE_CAPABILITIES });
    ctx.mockNextResponse({ type: 'text', text: 'dynamic again' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'switch back to dynamic tools' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(9);
    const previous = ctx;
    const priorCalls = [...previous.llmCalls];
    const previousRegistry = previous.get(IAgentToolRegistryService);
    const previousToolSelect = previous.get(IAgentToolSelectService);
    const previousLoop = previous.get(IAgentLoopService);
    const records = await previous.persistedWireRecords();
    await previous.dispose();
    registration = undefined;
    ctx = createTestAgent(wireRecordPersistenceServices(new InMemoryWireRecordPersistence(records)));
    await ctx.restorePersisted();
    await ctx.rpc.setPermission({ mode: 'yolo' });
    expect(ctx.get(IAgentStateService).get(toolSelectKey).initial).toEqual(initialTools);
    expect(ctx.get(IAgentToolRegistryService).resolve(MCP_ALPHA)).toBeUndefined();
    ctx.configure({ provider: { type: 'kimi', model: 'mock-model' }, modelCapabilities: DISCLOSURE_CAPABILITIES });
    ctx.mockNextResponse({ type: 'text', text: 'after restore' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue after restore' }] });
    await ctx.untilTurnEnd();
    await ctx.dispatcher.flush();
    expect(ctx.llmCalls).toHaveLength(1);

    const firstWire = priorCalls[0]!;
    expect(toolNames(firstWire.tools)).not.toContain(MCP_ALPHA);
    expect(toolNames(firstWire.tools)).not.toContain(inlineName);
    expect(toolNames(firstWire.tools)).toContain('select_tools');
    expect(historyText(firstWire.history)).toContain('<tools_added>');
    expect(historyText(firstWire.history)).toContain(MCP_ALPHA);

    const secondWire = priorCalls[1]!;
    const schemaMessages = secondWire.history.filter(
      (message) => toolsOf(message)?.some((tool) => tool.name === MCP_ALPHA),
    );
    expect(schemaMessages).toHaveLength(1);
    const alphaFromSchema = toolsOf(schemaMessages[0])!.find((tool) => tool.name === MCP_ALPHA)!;
    expect(alphaFromSchema.parameters).toEqual(alpha.parameters);
    expect(secondWire.tools).toEqual(firstWire.tools);
    expect(priorCalls[2]!.tools).toEqual(firstWire.tools);

    const beforeInlineCall = priorCalls[3]!;
    const afterInlineCall = priorCalls[4]!;
    for (const wire of [beforeInlineCall, afterInlineCall]) {
      expect(wire.tools).toEqual(firstWire.tools);
      expect(toolNames(wire.tools)).not.toContain(inlineName);
      const historical = wire.history.flatMap((message) => toolsOf(message) ?? [])
        .filter((tool) => tool.name === inlineName);
      expect(historical).toHaveLength(1);
      expect(historical[0]?.description).toBe(`${inlineName} desc`);
    }
    expect(historyText(beforeInlineCall.history)).toContain('not applied in this session');
    expect(previousRegistry.resolve(inlineName)).toBe(updatedInlineTool);
    const currentInlineSchema = previousToolSelect.shapeTools(previousRegistry.list())
      .find((tool) => tool.name === inlineName);
    expect(currentInlineSchema?.description).toBe(`${inlineName} updated desc`);
    expect(currentInlineSchema).not.toHaveProperty('deferred');
    expect(previousLoop.history().filter(
      (message) => message.origin?.kind === 'injection' && message.origin.variant === 'tool_update_pending',
    )).toHaveLength(1);

    const addedWire = priorCalls[5]!;
    const removedWire = priorCalls[6]!;
    expect(addedWire.tools).toEqual(firstWire.tools);
    expect(removedWire.tools).toEqual(firstWire.tools);
    expect(historyText(addedWire.history)).toContain(`<tools_added>\n${runtimeTool}\n</tools_added>`);
    expect(historyText(removedWire.history)).toContain(`<tools_removed>\n${runtimeTool}\n</tools_removed>`);
    const runtimeHistory = historyText(previousLoop.history());
    const addedIndex = runtimeHistory.indexOf(`<tools_added>\n${runtimeTool}\n</tools_added>`);
    const removedIndex = runtimeHistory.indexOf(`<tools_removed>\n${runtimeTool}\n</tools_removed>`);
    expect(addedIndex).toBeGreaterThanOrEqual(0);
    expect(removedIndex).toBeGreaterThan(addedIndex);

    const switchWire = priorCalls[7]!;
    expect(ctx.get(IAgentLoopService).data().activeToolNames).toBeUndefined();
    expect(ctx.get(IAgentToolSelectService).defaultTools(false).map((tool) => tool.name))
      .toContain(MCP_ALPHA);
    expect(toolNames(switchWire.tools)).not.toContain(MCP_ALPHA);
    expect(toolNames(switchWire.tools)).not.toContain(inlineName);
    expect(toolNames(switchWire.tools)).not.toContain(runtimeTool);
    expect(toolNames(switchWire.tools)).not.toContain('select_tools');
    expect(historyText(switchWire.history)).toContain(runtimeTool);
    expect(historyText(switchWire.history)).toContain('The available tools changed during this session.');
    expect(historyText(switchWire.history)).not.toContain('Use the select_tools tool');
    expect(switchWire.history.flatMap((message) => message.content).some(
      (part) => part.type === 'text' && part.meta?.kind === 'tool_lifecycle',
    )).toBe(false);

    const dynamicAgainWire = priorCalls[8]!;
    expect(toolNames(dynamicAgainWire.tools)).toContain('select_tools');
    expect(toolNames(dynamicAgainWire.tools)).not.toContain(MCP_ALPHA);
    expect(toolNames(dynamicAgainWire.tools)).not.toContain(inlineName);
    expect(toolNames(dynamicAgainWire.tools)).not.toContain(runtimeTool);
    expect(dynamicAgainWire.history.flatMap((message) => toolsOf(message) ?? [])
      .filter((tool) => tool.name === inlineName)).toHaveLength(1);

    const restoredWire = ctx.llmCalls[0]!;
    expect(toolNames(restoredWire.tools)).toContain('select_tools');
    expect(toolNames(restoredWire.tools)).not.toContain(MCP_ALPHA);
    expect(restoredWire.history.flatMap((message) => toolsOf(message) ?? [])
      .filter((tool) => tool.name === inlineName)).toHaveLength(1);
    expect(historyText(restoredWire.history)).toContain(`<tools_removed>\n${MCP_ALPHA}\n${inlineName}\n</tools_removed>`);

    const restoredRecords = await ctx.persistedWireRecords();
    const snapshotHashes = new Set([...records, ...restoredRecords].flatMap((record) =>
      record.type === 'llm.tools_snapshot' ? [record['hash'] as string] : []));
    expect(snapshotHashes.size).toBe(2);
    expect(ctx.get(IAgentLoopService).history().some((message) =>
      message.origin?.kind === 'injection' && message.origin.variant === LOADABLE_TOOLS_VARIANT)).toBe(true);
    expect(ctx.get(IAgentLoopService).history().flatMap((message) => message.content)).toContainEqual(
      expect.objectContaining({
        type: 'text',
        meta: expect.objectContaining({ kind: 'tool_lifecycle', removed: [runtimeTool] }),
      }),
    );

    expect(alpha.calls).toBe(1);
    expect(inlineTool.calls).toBe(0);
    expect(updatedInlineTool.calls).toBe(1);
  });

  it('loads and dispatches a user tool registered through the domain service', async () => {
    ctx.get(IAgentUserToolService).register({
      name: DASHBOARD_TOOL,
      description: 'Create a dashboard.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false,
      },
      disclosure: 'deferred',
    });
    ctx.mockNextResponse(selectToolsCall('call_select_1', [DASHBOARD_TOOL]));
    ctx.mockNextResponse({
      type: 'function',
      id: 'call_dashboard_1',
      name: DASHBOARD_TOOL,
      arguments: JSON.stringify({ title: 'Operations' }),
    });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'create a dashboard' }] });
    await ctx.untilToolCall({ output: 'dashboard-created' });
    await ctx.untilTurnEnd();

    const firstWire = ctx.llmCalls[0]!;
    expect(toolNames(firstWire.tools)).not.toContain(DASHBOARD_TOOL);
    expect(historyText(firstWire.history)).toContain(DASHBOARD_TOOL);

    const secondWire = ctx.llmCalls[1]!;
    const injected = secondWire.history.find((message) =>
      toolsOf(message)?.some((tool) => tool.name === DASHBOARD_TOOL),
    );
    expect(toolsOf(injected)?.find((tool) => tool.name === DASHBOARD_TOOL)?.parameters).toEqual({
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    });
    expect(secondWire.tools).toEqual(firstWire.tools);
    expect(historyText(ctx.get(IAgentLoopService).history())).toContain(
      `Loaded: ${DASHBOARD_TOOL}`,
    );
    expect(historyText(ctx.get(IAgentLoopService).history())).toContain(
      'dashboard-created',
    );
  });

  it('keeps the selected schema across undo and reports it as already available on reselect', async () => {
    appendContext(ctx.get(IAgentLoopService),{
      role: 'user',
      content: [{ type: 'text', text: 'earlier question' }],
      origin: { kind: 'user' },
    });

    ctx.mockNextResponse(selectToolsCall('call_select_1', [MCP_ALPHA]));
    ctx.mockNextResponse({ type: 'text', text: 'alpha is loaded' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load alpha' }] });
    await ctx.untilTurnEnd();

    ctx.expectCacheBreak('undo rewrites the history', { at: 'history' });
    await ctx.get(IAgentConversationUndoService).undo(1);
    const afterUndo = ctx.get(IAgentLoopService).history();
    expect(afterUndo.some((message) => toolsOf(message)?.some((tool) => tool.name === MCP_ALPHA))).toBe(
      true,
    );

    ctx.mockNextResponse(selectToolsCall('call_select_2', [MCP_ALPHA]));
    ctx.mockNextResponse({ type: 'text', text: 'reloaded' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load alpha again' }] });
    await ctx.untilTurnEnd();

    const afterReload = ctx.get(IAgentLoopService).history();
    expect(
      afterReload.some((message) => toolsOf(message)?.some((tool) => tool.name === MCP_ALPHA)),
    ).toBe(true);
    expect(historyText(afterReload)).toContain('Already available: mcp__srv__alpha');
    expect(historyText(afterReload)).not.toContain('Loaded: mcp__srv__alpha');
  });

  it('reports select_tools as callable despite a profile allowlist omission, but respects an explicit deny', async () => {
    ctx.get(IAgentLoopService).update({ activeToolNames: ['Read'] });
    ctx.mockNextResponse(selectToolsCall('call_select_self', ['select_tools']));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'select the selection tool' }] });
    await ctx.untilTurnEnd();

    const text = historyText(ctx.get(IAgentLoopService).history());
    expect(text).toContain('"select_tools" is already available — call it directly;');
    expect(text).not.toContain('disabled by the current tool policy');
    expect(text).not.toContain('Unknown tool: select_tools');
    expect(ctx.get(IAgentToolSelectService).load(['select_tools'])).toMatchObject({
      alreadyCallable: ['select_tools'],
      consecutiveFailures: 0,
    });

    ctx.get(IAgentLoopService).update({ disallowedTools: ['select_tools'] });
    expect(ctx.get(IAgentToolSelectService).load(['select_tools'])).toMatchObject({
      alreadyCallable: [],
      policyDenied: ['select_tools'],
    });
  });

  it('answers not-available-in-this-session for a host-denied name', async () => {
    ctx.get(IAgentLoopService).update({ disallowedTools: ['Automation'] });

    ctx.mockNextResponse(selectToolsCall('call_select_1', ['Automation']));
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'select automation' }] });
    await ctx.untilTurnEnd();

    const text = historyText(ctx.get(IAgentLoopService).history());
    expect(text).toContain(
      '"Automation" is disabled by the current tool policy. select_tools cannot enable it. ' +
        'Do not retry unless the policy changes; use an available tool instead.',
    );
  });

  it('loads an announced user tool with an MCP-like name despite an MCP deny glob', async () => {
    registration?.dispose();
    registration = ctx.get(IAgentToolRegistryService).register(alpha, {
      source: 'user',
      disclosure: 'deferred',
    });
    ctx.get(IAgentLoopService).update({ disallowedTools: ['mcp__srv__*'] });
    ctx.mockNextResponse(selectToolsCall('call_select_1', [MCP_ALPHA]));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load the announced tool' }] });
    await ctx.untilTurnEnd();

    const text = historyText(ctx.get(IAgentLoopService).history());
    expect(text).toContain(`<tools_added>\n${MCP_ALPHA}\n</tools_added>`);
    expect(text).toContain(`Loaded: ${MCP_ALPHA}`);
    expect(text).not.toContain('disabled by the current tool policy');
  });

  it('reports a loaded MCP tool as currently unavailable after its server disconnects', async () => {
    ctx.mockNextResponse(selectToolsCall('call_select_1', [MCP_ALPHA]));
    ctx.mockNextResponse({ type: 'text', text: 'loaded' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load alpha' }] });
    await ctx.untilTurnEnd();
    expect(historyText(ctx.get(IAgentLoopService).history())).toContain(
      `Loaded: ${MCP_ALPHA}`,
    );

    registration?.dispose();
    registration = undefined;

    ctx.mockNextResponse(selectToolsCall('call_select_2', [MCP_ALPHA]));
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'select alpha again' }] });
    await ctx.untilTurnEnd();

    const text = historyText(ctx.get(IAgentLoopService).history());
    expect(text).toContain(
      `"${MCP_ALPHA}" was previously selected or loaded but is no longer registered. ` +
        'select_tools cannot restore it. Do not select it again unless a new <tools_added> announcement lists it.',
    );
    expect(text).not.toContain(`Already available: ${MCP_ALPHA}`);
  });

  it('resets the call streak on success but preserves unrelated name failures in the same turn', async () => {
    ctx.mockNextResponse(selectToolsCall('guess_1', ['Automation']));
    ctx.mockNextResponse(selectToolsCall('guess_2', ['AutomationList']));
    ctx.mockNextResponse(selectToolsCall('guess_3', ['mcp__example__automation']));
    ctx.mockNextResponse(selectToolsCall('load_alpha', [MCP_ALPHA]));
    ctx.mockNextResponse(selectToolsCall('guess_4', ['Automation']));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'select a tool' }] });
    await ctx.untilTurnEnd();

    const text = historyText(ctx.get(IAgentLoopService).history());
    expect(text).toContain('Unknown tool: mcp__example__automation.');
    expect(text.match(/3 consecutive select_tools calls/g)).toHaveLength(1);
    expect(text).toContain(`Loaded: ${MCP_ALPHA}`);
    expect(text).not.toContain('4 consecutive select_tools calls');
    expect(text).toContain('"Automation" has already failed selection 2 times');
  });

  it('escalates to stop-retry wording when the same unknown name is selected twice', async () => {
    ctx.mockNextResponse(selectToolsCall('call_select_1', ['mcp__srv__ghost']));
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load ghost' }] });
    await ctx.untilTurnEnd();
    expect(historyText(ctx.get(IAgentLoopService).history())).toContain(
      'Unknown tool: mcp__srv__ghost.',
    );

    ctx.mockNextResponse(selectToolsCall('call_select_2', ['mcp__srv__ghost']));
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load ghost again' }] });
    await ctx.untilTurnEnd();
    expect(historyText(ctx.get(IAgentLoopService).history())).toContain(
      '"mcp__srv__ghost" has already failed selection 2 times. ' +
        'Stop retrying this name until its availability changes.',
    );
  });
});

describe('same-turn MCP tool replacement', () => {
  it.each([true, false])('authenticates and calls the replacement tool with deferred=%s', async (deferred) => {
    const server = await startEchoHttpMcpServer({ bearerToken: 'test-token' });
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const authenticating = createControlledPromise<void>();
    const authorized = createControlledPromise<void>();
    vi.spyOn(oauthService, 'beginAuthorization').mockResolvedValue({
      waitId: 'tool-select-auth-wait',
      authorizationUrl: new URL('https://example.test/authorize'),
      complete: async () => {
        authenticating.resolve();
        await authorized;
        await oauthService.getProvider('srv', server.url).saveTokens({
          access_token: 'test-token',
          token_type: 'Bearer',
        });
      },
      cancel: async () => {},
    });
    const manager = new McpConnectionManager({ oauthService });
    const ctx = createTestAgent(mcpServices({ manager }));
    const authenticate = 'mcp__srv__authenticate';
    const echo = 'mcp__srv__echo';
    try {
      ctx.get(IAgentToolSelectService);
      ctx.get(IAgentToolSelectAnnouncementsService);
      ctx.get(IAgentToolExecutorService);
      ctx.configure({ modelCapabilities: DISCLOSURE_CAPABILITIES });
      await ctx.restorePersisted();
      await ctx.rpc.setPermission({ mode: 'yolo' });
      await manager.connectAll({ srv: { transport: 'http', url: server.url, deferred } });
      expect(manager.get('srv')?.status).toBe('needs-auth');
      expect(ctx.get(IAgentToolRegistryService).resolve(authenticate)).toBeDefined();

      if (deferred) ctx.mockNextResponse(selectToolsCall('select_authenticate', [authenticate]));
      ctx.mockNextResponse({ type: 'function', id: 'authenticate', name: authenticate, arguments: '{}' });
      ctx.mockNextResponse(selectToolsCall('select_echo', [echo]));
      ctx.mockNextResponse({
        type: 'function', id: 'echo', name: echo, arguments: JSON.stringify({ text: 'authorized echo' }),
      });
      ctx.mockNextResponse({ type: 'text', text: 'done' });

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'authenticate and echo' }] });
      await authenticating;
      expect(ctx.llmCalls).toHaveLength(deferred ? 2 : 1);
      authorized.resolve();
      await ctx.untilTurnEnd();

      expect(manager.get('srv')?.status).toBe('connected');
      expect(ctx.get(IAgentToolRegistryService).resolve(authenticate)).toBeUndefined();
      expect(ctx.get(IAgentToolRegistryService).resolve(echo)).toBeDefined();
      expect(ctx.llmCalls).toHaveLength(deferred ? 5 : 4);
      const afterAuthentication = ctx.llmCalls[deferred ? 2 : 1]!;
      const beforeEcho = ctx.llmCalls[deferred ? 3 : 2]!;
      const context = ctx.get(IAgentLoopService).history();
      expect(context.filter((message) => message.origin?.kind === 'user')).toHaveLength(1);
      expect(context.some((message) => message.role === 'tool' &&
        message.content.some((part) => part.type === 'text' && part.text === 'authorized echo'))).toBe(true);
      const announcements = context.filter((message) =>
        message.origin?.kind === 'injection' && message.origin.variant === LOADABLE_TOOLS_VARIANT);
      const catalog = historyText(afterAuthentication.history);
      expect([...catalog.matchAll(/<tools_added>\n([\s\S]*?)\n<\/tools_added>/g)]
        .map((match) => match[1])).toEqual(deferred ? [authenticate, echo] : [echo]);
      expect([...catalog.matchAll(/<tools_removed>\n([\s\S]*?)\n<\/tools_removed>/g)]
        .map((match) => match[1])).toEqual([authenticate]);
      expect(announcements).toHaveLength(deferred ? 2 : 1);
      expect(announcements.every((message) =>
        message.origin?.kind === 'injection' &&
        isToolSelectAnnouncementDisclosure(message.origin.disclosure) &&
        message.origin.disclosure.kind === 'delta')).toBe(true);
      expect(afterAuthentication.history.flatMap((message) => toolsOf(message) ?? [])
        .some((tool) => tool.name === echo)).toBe(false);
      const schema = beforeEcho.history.flatMap((message) => toolsOf(message) ?? [])
        .find((tool) => tool.name === echo);
      expect(schema).toBeDefined();
      expect(schema!.parameters).toEqual(manager.resolved('srv')?.tools[0]?.parameters);
      expect(toolNames(beforeEcho.tools)).not.toContain(echo);
      expect(ctx.llmCalls.every((call) => JSON.stringify(call.tools) ===
        JSON.stringify(ctx.llmCalls[0]!.tools))).toBe(true);
    } finally {
      authorized.resolve();
      await ctx.dispose();
      await manager.shutdown();
      await oauthService.shutdown();
      await server.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });
});

const correctionTest = it.extend<TestkitAgentFixtures>(testkitAgentFixtures());

describe('deferred tool argument correction', () => {
  correctionTest('retries schema-invalid deferred tool arguments with a correction instead of executing', async ({ agent, model }) => {
    agent.configure({ modelCapabilities: DISCLOSURE_CAPABILITIES });
    const weather = new StubMcpTool('deferred_weather');
    const registration = agent.get(IAgentToolRegistryService).register(weather, {
      source: 'mcp',
      disclosure: 'deferred',
    });
    try {
      await agent.restorePersisted();
      await agent.rpc.setPermission({ mode: 'yolo' });
      model.script(
        call('select_tools', { names: ['deferred_weather'] }, { id: 'select-weather', invalid: true }),
        call('deferred_weather', {}, { id: 'rejected-deferred', rawArguments: '{"query":42}', invalid: true }),
        call('deferred_weather', { query: 'sf' }, { id: 'valid-deferred', invalid: true }),
        say('done'),
      );

      model.expectCacheBreak('the retry drops the trailing argument correction, which only costs that message', { at: 'history' });
      await agent.rpc.prompt({ input: [{ type: 'text', text: 'load and call the deferred weather tool' }] });
      await agent.untilTurnEnd();

      expect(model.requests('main')).toHaveLength(4);
      const correction = model.requests('main')[2]!;
      expect(correction.view.system).toContain('was not executed because its arguments were invalid');
      expect(JSON.stringify(correction.view.messages)).not.toContain('rejected-deferred');
      expect(weather.calls).toBe(1);
    } finally {
      registration.dispose();
    }
  });
});
