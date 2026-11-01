import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createControlledPromise } from '@antfu/utils';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentConversationUndoService } from '#/agent/undo/undo';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentProfileService } from '#/agent/profile/profile';
import type { ExecutableTool, ToolExecution } from '#/tool/toolContract';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentStateService } from '#/agent/state/agentState';
import { TOOL_SELECT_FLAG_ENV } from '#/agent/toolSelect/flag';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IAgentToolSelectAnnouncementsService } from '#/agent/toolSelect/toolSelectAnnouncements';
import { LOADABLE_TOOLS_VARIANT } from '#/agent/toolSelect/dynamicTools';
import { toolSelectKey } from '#/agent/toolSelect/toolSelectOps';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IAgentLoopService } from '#/agent/loop/loop';
import { McpConnectionManager } from '#/mcpCore/connection-manager';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import '#/agent/tools/select-tools/selectToolsTool';

import { createTestAgent, mcpServices, sessionService, type TestAgentContext } from '../../harness';
import { createMemoryMcpOAuthStore, startInProcessHttpMcpServer } from '../../mcpCore/stubs';
import type { Message } from '#human/llm/message';

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
  max_context_tokens: 128_000,
  dynamically_loaded_tools: true,
} as const;

type WireEvent = Extract<
  TestAgentContext['allEvents'][number],
  { readonly type: '[wire]' }
>;

class StubMcpTool implements ExecutableTool<Record<string, unknown>> {
  readonly description: string;
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

function wireEvents(ctx: TestAgentContext, eventName: string): readonly WireEvent[] {
  return ctx.allEvents.filter(
    (event): event is WireEvent => event.type === '[wire]' && event.event === eventName,
  );
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

describe('progressive tool disclosure end-to-end', () => {
  let ctx: TestAgentContext;
  let alpha: StubMcpTool;
  let registration: { dispose(): void } | undefined;
  let mcpReady: Promise<void>;
  let onMcpWait: () => void;

  beforeEach(async () => {
    vi.stubEnv(TOOL_SELECT_FLAG_ENV, '1');
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

  it('announces MCP tools discovered during startup in the first model request', async () => {
    registration?.dispose();
    const ready = createControlledPromise<void>();
    const waiting = createControlledPromise<void>();
    mcpReady = ready;
    onMcpWait = waiting.resolve;
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'use the server tool' }] });
    await waiting;
    expect(ctx.llmCalls).toHaveLength(0);
    registration = ctx.get(IAgentToolRegistryService)
      .register(alpha, { source: 'mcp', disclosure: 'deferred' });
    ready.resolve();
    await ctx.untilTurnEnd();

    const firstWire = ctx.llmCalls[0]!;
    expect(toolNames(firstWire.tools)).not.toContain(MCP_ALPHA);
    expect(historyText(firstWire.history)).toContain('<tools_added>');
    expect(historyText(firstWire.history)).toContain(MCP_ALPHA);
  });

  it('can cancel the first turn while MCP discovery is still pending', async () => {
    const waiting = createControlledPromise<void>();
    mcpReady = new Promise(() => {});
    onMcpWait = waiting.resolve;
    ctx.mockNextResponse({ type: 'text', text: 'must not be requested' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'use the server tool' }] });
    await waiting;
    expect(ctx.get(IAgentLoopService).cancel()).toBe(true);
    await ctx.untilTurnEnd();

    const turnEnded = ctx.allEvents.find(
      (entry) => entry.type === '[rpc]' && entry.event === 'turn.ended',
    );
    expect(turnEnded?.args).toMatchObject({ reason: 'cancelled' });
    expect(ctx.llmCalls).toHaveLength(0);
  });

  it('announces the manifest, loads by name, keeps the top-level table byte-stable, and dispatches across model switches', async () => {
    ctx.mockNextResponse(selectToolsCall('call_select_1', [MCP_ALPHA]));
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
    const runtimeTool = 'mcp__srv__runtime';
    ctx.get(IAgentToolRegistryService).register(new StubMcpTool(runtimeTool), {
      source: 'mcp',
      disclosure: 'deferred',
    });
    await ctx.restorePersisted();
    expect(ctx.get(IAgentStateService).get(toolSelectKey).initial).toEqual(initialTools);
    ctx.configure({
      provider: { type: 'kimi', model: 'no-dynamic-tools' },
      modelCapabilities: { ...DISCLOSURE_CAPABILITIES, dynamically_loaded_tools: false },
    });
    ctx.mockNextResponse({ type: 'text', text: 'after switch' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue after the model switch' }] });
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(4);

    const firstWire = ctx.llmCalls[0]!;
    expect(ctx.get(IAgentStateService).get(toolSelectKey).initial?.map((tool) => tool.name))
      .toContain(MCP_ALPHA);
    expect(toolNames(firstWire.tools)).not.toContain(MCP_ALPHA);
    expect(toolNames(firstWire.tools)).toContain('select_tools');
    const announcementText = firstWire.history
      .map((message) =>
        message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
      )
      .join('\n');
    expect(announcementText).toContain('<tools_added>');
    expect(announcementText).toContain(MCP_ALPHA);

    const requests = wireEvents(ctx, 'llm.request').filter(
      (event) => (event.args as { kind?: string }).kind === 'loop',
    );
    expect(requests.map((request) => (request.args as { toolSelect?: boolean }).toolSelect))
      .toEqual([true, true, true, false]);

    const secondWire = ctx.llmCalls[1]!;
    const schemaMessages = secondWire.history.filter(
      (message) => toolsOf(message)?.some((tool) => tool.name === MCP_ALPHA),
    );
    expect(schemaMessages).toHaveLength(1);

    const alphaFromSchema = toolsOf(schemaMessages[0])!.find((tool) => tool.name === MCP_ALPHA)!;
    expect(alphaFromSchema.parameters).toEqual(alpha.parameters);

    expect(secondWire.tools).toEqual(firstWire.tools);
    expect(ctx.llmCalls[2]!.tools).toEqual(firstWire.tools);

    const fourthWire = ctx.llmCalls[3]!;
    expect(ctx.get(IAgentProfileService).data().activeToolNames).toBeUndefined();
    expect(ctx.get(IAgentToolSelectService).defaultTools(false).map((tool) => tool.name))
      .toContain(MCP_ALPHA);
    expect(ctx.get(IAgentToolSelectService).defaultTools(false).find((tool) => tool.name === MCP_ALPHA)
      ?.deferred).toBeUndefined();
    expect(toolNames(fourthWire.tools)).toContain(MCP_ALPHA);
    expect(toolNames(fourthWire.tools)).not.toContain(runtimeTool);
    expect(toolNames(fourthWire.tools)).not.toContain('select_tools');
    expect(historyText(fourthWire.history)).toContain(runtimeTool);
    expect(historyText(fourthWire.history)).toContain('The available tools changed during this session.');
    expect(historyText(fourthWire.history)).not.toContain('Use the select_tools tool');
    expect(wireEvents(ctx, 'llm.tools_snapshot')).toHaveLength(2);
    expect(ctx.get(IAgentContextMemoryService).get().some((message) =>
      message.origin?.kind === 'injection' && message.origin.variant === LOADABLE_TOOLS_VARIANT)).toBe(true);

    expect(alpha.calls).toBe(1);
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
    expect(historyText(ctx.get(IAgentContextMemoryService).get())).toContain(
      `Loaded: ${DASHBOARD_TOOL}`,
    );
    expect(historyText(ctx.get(IAgentContextMemoryService).get())).toContain(
      'dashboard-created',
    );
  });

  it('keeps the selected schema across undo and reports it as already available on reselect', async () => {
    ctx.get(IAgentContextMemoryService).append({
      role: 'user',
      content: [{ type: 'text', text: 'earlier question' }],
      origin: { kind: 'user' },
    });

    ctx.mockNextResponse(selectToolsCall('call_select_1', [MCP_ALPHA]));
    ctx.mockNextResponse({ type: 'text', text: 'alpha is loaded' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load alpha' }] });
    await ctx.untilTurnEnd();

    await ctx.get(IAgentConversationUndoService).undo(1);
    const afterUndo = ctx.get(IAgentContextMemoryService).get();
    expect(afterUndo.some((message) => toolsOf(message)?.some((tool) => tool.name === MCP_ALPHA))).toBe(
      true,
    );

    ctx.mockNextResponse(selectToolsCall('call_select_2', [MCP_ALPHA]));
    ctx.mockNextResponse({ type: 'text', text: 'reloaded' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load alpha again' }] });
    await ctx.untilTurnEnd();

    const afterReload = ctx.get(IAgentContextMemoryService).get();
    expect(
      afterReload.some((message) => toolsOf(message)?.some((tool) => tool.name === MCP_ALPHA)),
    ).toBe(true);
    expect(historyText(afterReload)).toContain('Already available: mcp__srv__alpha');
    expect(historyText(afterReload)).not.toContain('Loaded: mcp__srv__alpha');
  });

  it('reports select_tools as callable despite a profile allowlist omission, but respects an explicit deny', async () => {
    ctx.get(IAgentProfileService).update({ activeToolNames: ['Read'] });
    ctx.mockNextResponse(selectToolsCall('call_select_self', ['select_tools']));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'select the selection tool' }] });
    await ctx.untilTurnEnd();

    const text = historyText(ctx.get(IAgentContextMemoryService).get());
    expect(text).toContain('"select_tools" is already available — call it directly;');
    expect(text).not.toContain('disabled by the current tool policy');
    expect(text).not.toContain('Unknown tool: select_tools');
    expect(ctx.get(IAgentToolSelectService).load(['select_tools'])).toMatchObject({
      alreadyCallable: ['select_tools'],
      consecutiveFailures: 0,
    });

    ctx.get(IAgentProfileService).update({ disallowedTools: ['select_tools'] });
    expect(ctx.get(IAgentToolSelectService).load(['select_tools'])).toMatchObject({
      alreadyCallable: [],
      policyDenied: ['select_tools'],
    });
  });

  it('answers not-available-in-this-session for a host-denied name', async () => {
    ctx.get(IAgentProfileService).update({ disallowedTools: ['Automation'] });

    ctx.mockNextResponse(selectToolsCall('call_select_1', ['Automation']));
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'select automation' }] });
    await ctx.untilTurnEnd();

    const text = historyText(ctx.get(IAgentContextMemoryService).get());
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
    ctx.get(IAgentProfileService).update({ disallowedTools: ['mcp__srv__*'] });
    ctx.mockNextResponse(selectToolsCall('call_select_1', [MCP_ALPHA]));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load the announced tool' }] });
    await ctx.untilTurnEnd();

    const text = historyText(ctx.get(IAgentContextMemoryService).get());
    expect(text).toContain(`<tools_added>\n${MCP_ALPHA}\n</tools_added>`);
    expect(text).toContain(`Loaded: ${MCP_ALPHA}`);
    expect(text).not.toContain('disabled by the current tool policy');
  });

  it('reports a loaded MCP tool as currently unavailable after its server disconnects', async () => {
    ctx.mockNextResponse(selectToolsCall('call_select_1', [MCP_ALPHA]));
    ctx.mockNextResponse({ type: 'text', text: 'loaded' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load alpha' }] });
    await ctx.untilTurnEnd();
    expect(historyText(ctx.get(IAgentContextMemoryService).get())).toContain(
      `Loaded: ${MCP_ALPHA}`,
    );

    registration?.dispose();
    registration = undefined;

    ctx.mockNextResponse(selectToolsCall('call_select_2', [MCP_ALPHA]));
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'select alpha again' }] });
    await ctx.untilTurnEnd();

    const text = historyText(ctx.get(IAgentContextMemoryService).get());
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

    const text = historyText(ctx.get(IAgentContextMemoryService).get());
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
    expect(historyText(ctx.get(IAgentContextMemoryService).get())).toContain(
      'Unknown tool: mcp__srv__ghost.',
    );

    ctx.mockNextResponse(selectToolsCall('call_select_2', ['mcp__srv__ghost']));
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load ghost again' }] });
    await ctx.untilTurnEnd();
    expect(historyText(ctx.get(IAgentContextMemoryService).get())).toContain(
      '"mcp__srv__ghost" has already failed selection 2 times. ' +
        'Stop retrying this name until its availability changes.',
    );
  });
});

describe('same-turn MCP tool replacement', () => {
  it.each([true, false])('authenticates and calls the replacement tool with deferred=%s', async (deferred) => {
    vi.stubEnv(TOOL_SELECT_FLAG_ENV, '1');
    const server = await startInProcessHttpMcpServer({ authToken: 'test-token' });
    const oauthService = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    const authenticating = createControlledPromise<void>();
    const authorized = createControlledPromise<void>();
    vi.spyOn(oauthService, 'beginAuthorization').mockResolvedValue({
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
      const context = ctx.get(IAgentContextMemoryService).get();
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
      expect(announcements).toHaveLength(2);
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
