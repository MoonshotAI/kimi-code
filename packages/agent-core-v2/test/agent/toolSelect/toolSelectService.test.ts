import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolCall } from '#/kosong/contract/message';
import { IEventBus } from '#/app/event/eventBus';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { ContextMessage } from '#/features/contextMemory/types';
import { AgentContextMemory } from '#/features/contextMemory/contextMemoryAgentRuntime';
import { AgentTools, type AgentToolsRuntime } from '#/features/toolExecutor/toolExecutorAgentRuntime';
import { ContextSpliced } from '#/features/contextMemory/contextEvents';
import { CompactionCompleted } from '#/features/fullCompaction/fullCompactionEvents';
import type { ExecutableTool, ToolExecution } from '#/tool/toolContract';
import { createTestAgent, type TestAgentContext } from '../../harness';

const MCP_ALPHA = 'mcp__srv__alpha';
const MCP_BETA = 'mcp__srv__beta';
const MCP_GONE = 'mcp__srv__gone';
const USER_DEFERRED = 'dashboard_create';
const USER_INLINE = 'echo_inline';
const capabilities: ModelCapability = {
  image_in: false, video_in: false, audio_in: false, thinking: false,
  tool_use: true, dynamically_loaded_tools: true, max_context_tokens: 128_000,
};

class StubTool implements ExecutableTool<Record<string, unknown>> {
  readonly description: string;
  readonly parameters = { type: 'object', additionalProperties: true };
  calls = 0;
  constructor(readonly name: string, private readonly output = 'ok') { this.description = `${name} desc`; }
  resolveExecution(): ToolExecution {
    return { approvalRule: this.name, execute: async () => { this.calls += 1; return { output: this.output }; } };
  }
}

function messageWithTools(...names: string[]): ContextMessage {
  return { role: 'system', content: [], toolCalls: [], tools: names.map((name) => ({ name, description: `${name} desc`, parameters: {} })), origin: { kind: 'injection', variant: 'dynamic_tool_schema' } };
}
function call(id: string, name: string): ToolCall { return { type: 'function', id, name, arguments: '{}' }; }

const contexts: TestAgentContext[] = [];

beforeEach(() => vi.stubEnv('KIMI_CODE_EXPERIMENTAL_TOOL_SELECT', '1'));

function setup(): { ctx: TestAgentContext; tools: AgentToolsRuntime } {

  const ctx = createTestAgent();
  contexts.push(ctx);
  ctx.configure({ modelCapabilities: capabilities });
  const tools = ctx.resolve(AgentTools);
  return { ctx, tools };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(contexts.splice(0).map((ctx) => ctx.dispose()));
});

describe('AgentTools selection runtime', () => {
  it('resolves through lifecycle and opens only with capabilities and flag', () => {
    const { tools } = setup();
    expect(tools.selectionEnabled()).toBe(true);
  });
  it('closes without dynamic loading capability', () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_TOOL_SELECT', '1');
    const ctx = createTestAgent(); contexts.push(ctx); ctx.configure({ modelCapabilities: { ...capabilities, dynamically_loaded_tools: false } });
    expect(ctx.resolve(AgentTools).selectionEnabled()).toBe(false);
  });
  it('closes without tool use capability', () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_TOOL_SELECT', '1');
    const ctx = createTestAgent(); contexts.push(ctx); ctx.configure({ modelCapabilities: { ...capabilities, tool_use: false } });
    expect(ctx.resolve(AgentTools).selectionEnabled()).toBe(false);
  });
  it('hides select_tools while the gate is closed', () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_TOOL_SELECT', '');
    const { ctx, tools } = setup();
    ctx.provideTool(new StubTool('Echo'));
    expect(tools.toolsForModel().map((tool) => tool.name)).not.toContain('select_tools');
  });
  it('lists builtin and user providers through availableTools', () => {
    const { ctx, tools } = setup();
    ctx.provideTool(new StubTool('Echo'));
    ctx.provideTool(new StubTool(USER_DEFERRED), { source: 'user', disclosure: 'deferred' });
    expect(tools.availableTools().map((tool) => tool.name)).toEqual(expect.arrayContaining(['Echo', USER_DEFERRED]));
  });
  it('defers opted-in user tools until selected', () => {
    const { ctx, tools } = setup();
    ctx.provideTool(new StubTool(USER_DEFERRED), { source: 'user', disclosure: 'deferred' });
    expect(tools.toolsForModel().map((tool) => tool.name)).not.toContain(USER_DEFERRED);
    expect(tools.select([USER_DEFERRED])).toEqual({ toLoad: [USER_DEFERRED], alreadyAvailable: [], unknown: [] });
    expect(tools.drainPendingToolSchemas()?.map((tool) => tool.name)).toEqual([USER_DEFERRED]);
  });
  it('keeps inline user tools in the model view', () => {
    const { ctx, tools } = setup();
    ctx.provideTool(new StubTool(USER_INLINE), { source: 'user' });
    expect(tools.toolsForModel().map((tool) => tool.name)).toContain(USER_INLINE);
  });
  it('hides unloaded MCP tools and reveals selected schemas', () => {
    const { ctx, tools } = setup();
    ctx.provideTool(new StubTool(MCP_ALPHA), { source: 'mcp' });
    expect(tools.toolsForModel().map((tool) => tool.name)).not.toContain(MCP_ALPHA);
    tools.select([MCP_ALPHA]);
    expect(tools.drainPendingToolSchemas()?.map((tool) => tool.name)).toEqual([MCP_ALPHA]);
  });
  it('settles load into toLoad, alreadyAvailable, and unknown', () => {
    const { ctx, tools } = setup();
    ctx.provideTool(new StubTool(MCP_ALPHA), { source: 'mcp' });
    expect(tools.select([MCP_ALPHA, MCP_GONE])).toEqual({ toLoad: [MCP_ALPHA], alreadyAvailable: [], unknown: [MCP_GONE] });
    expect(tools.select([MCP_ALPHA, MCP_GONE])).toEqual({ toLoad: [], alreadyAvailable: [MCP_ALPHA], unknown: [MCP_GONE] });
  });
  it('sorts drained schemas by name', () => {
    const { ctx, tools } = setup();
    ctx.provideTool(new StubTool(MCP_BETA), { source: 'mcp' }); ctx.provideTool(new StubTool(MCP_ALPHA), { source: 'mcp' });
    tools.select([MCP_BETA, MCP_ALPHA]);
    expect(tools.drainPendingToolSchemas()?.map((tool) => tool.name)).toEqual([MCP_ALPHA, MCP_BETA]);
  });
  it('shapes loaded history without mutating canonical context', async () => {
    const { tools, ctx } = setup();
    ctx.provideTool(new StubTool(MCP_ALPHA), { source: 'mcp' });
    await ctx.resolve(AgentContextMemory).append(messageWithTools(MCP_ALPHA, MCP_BETA));
    expect(tools.shapeHistory(ctx.resolve(AgentContextMemory).get())).toHaveLength(1);
  });
  it('filters inactive tools from model view', () => {
    const { tools, ctx } = setup();
    ctx.provideTool(new StubTool(MCP_ALPHA), { source: 'mcp' });
    void ctx.rpc.setActiveTools({ names: [] });
    expect(tools.toolsForModel().map((tool) => tool.name)).not.toContain(MCP_ALPHA);
  });
  it('clears pending schemas after compaction', () => {
    const { tools, ctx } = setup();
    ctx.provideTool(new StubTool(MCP_ALPHA), { source: 'mcp' }); tools.select([MCP_ALPHA]);
    ctx.get(IEventBus).publish(new CompactionCompleted({ agentId: 'main', result: { summary: '', compactedCount: 0, tokensBefore: 0, tokensAfter: 0 } }));
    expect(tools.select([MCP_ALPHA]).toLoad).toEqual([MCP_ALPHA]);
  });
  it('clears pending schemas after a full-prefix splice', () => {
    const { tools, ctx } = setup();
    ctx.provideTool(new StubTool(MCP_ALPHA), { source: 'mcp' }); tools.select([MCP_ALPHA]);
    ctx.resolve(AgentContextMemory);
    expect(tools.selectionEnabled()).toBe(true);
  });
  it('returns undefined when no pending schemas exist', () => {
    const { tools } = setup();
    expect(tools.drainPendingToolSchemas()).toBeUndefined();
  });
  it('resolves provided tools through the runtime', () => {
    const { ctx, tools } = setup(); const tool = new StubTool('Echo'); ctx.provideTool(tool);
    expect(tools.resolve('Echo')).toBe(tool);
  });
  it('executes a loaded MCP tool exactly once', async () => {
    const { ctx, tools } = setup(); const tool = new StubTool(MCP_ALPHA); ctx.provideTool(tool, { source: 'mcp' });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    tools.select([MCP_ALPHA]); tools.drainPendingToolSchemas();
    await ctx.resolve(AgentContextMemory).append(messageWithTools(MCP_ALPHA));
    const results = []; for await (const result of tools.execute([call('1', MCP_ALPHA)], { turnId: 1, signal: new AbortController().signal })) results.push(result);
    expect(results[0]!.result.output).toBe('ok'); expect(tool.calls).toBe(1);
  });
  it('reports missing tools through execution', async () => {
    const { tools } = setup(); const results = [];
    for await (const result of tools.execute([call('1', MCP_GONE)], { turnId: 1, signal: new AbortController().signal })) results.push(result);
    expect(results[0]!.result.isError).toBe(true);
  });
  it('keeps selection state isolated per agent runtime', () => {
    const first = setup(); const second = setup(); first.ctx.provideTool(new StubTool(MCP_ALPHA), { source: 'mcp' });
    first.tools.select([MCP_ALPHA]);
    expect(second.tools.select([MCP_ALPHA])).toEqual({ toLoad: [], alreadyAvailable: [], unknown: [MCP_ALPHA] });
  });
  it('reports loadable announcements from current history', () => {
    const { ctx, tools } = setup(); ctx.provideTool(new StubTool(MCP_ALPHA), { source: 'mcp' });
    expect(tools.loadableToolsAnnouncement()).toContain(MCP_ALPHA);
  });
  it('supports provider disposal without retaining the tool', async () => {
    const { ctx, tools } = setup(); const registration = ctx.provideTool(new StubTool(MCP_ALPHA), { source: 'mcp' });
    expect(tools.resolve(MCP_ALPHA)).toBeDefined();
    const changed = new Promise<void>((resolve) => tools.onDidChange(resolve));
    registration.dispose();
    await changed;
    expect(tools.resolve(MCP_ALPHA)).toBeUndefined();
  });
});
