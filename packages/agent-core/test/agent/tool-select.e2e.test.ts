/**
 * select_tools progressive disclosure — end-to-end agent tests.
 *
 * Uses the scripted-generate harness: real ToolManager/turn loop/context, fake
 * LLM. The three-condition gate (model capability.dynamically_loaded_tools ×
 * capability.tool_use × `tool-select` flag) is driven through the alias
 * capability declarations and an injected FlagResolver.
 *
 * The first block pins the gate-closed regression baseline (S0): with any
 * gate closed, the outbound request keeps the inline shape byte-for-byte.
 */

import { describe, expect, it } from 'vitest';

import type { ToolCall } from '@moonshot-ai/kosong';

import {
  foldAnnouncedToolNames,
  isLoadableToolsAnnouncement,
} from '../../src/agent/context/dynamic-tools';
import { ToolManager } from '../../src/agent/tool';
import type { Agent, AgentRecord } from '../../src/agent';
import { InMemoryAgentRecordPersistence } from '../../src/agent/records';
import { FLAG_DEFINITIONS, FlagResolver } from '../../src/flags';
import type { MCPClient } from '../../src/mcp/types';
import { estimateTokensForMessage } from '../../src/utils/tokens';
import { testAgent, type TestAgentContext } from './harness/agent';

const DISCLOSURE_PROVIDER = { type: 'kimi', apiKey: 'test-key', model: 'select-capable-model' } as const;
const DISCLOSURE_CAPABILITIES = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: 256_000,
  dynamically_loaded_tools: true,
} as const;

const INLINE_PROVIDER = { type: 'kimi', apiKey: 'test-key', model: 'inline-model' } as const;
const INLINE_CAPABILITIES = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;

const GRAFANA_TOOL = 'mcp__grafana__query_range';

function toolSelectFlagOn(): FlagResolver {
  return new FlagResolver({}, FLAG_DEFINITIONS, { 'tool-select': true });
}

/** Empty env so an ambient KIMI_CODE_EXPERIMENTAL_FLAG cannot force flags on. */
function toolSelectFlagOff(): FlagResolver {
  return new FlagResolver({}, FLAG_DEFINITIONS, {});
}

function grafanaClient(callLog: Array<[string, unknown]> = []): MCPClient {
  return {
    async listTools() {
      return [
        {
          name: 'query_range',
          description: 'Query a metrics range',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ];
    },
    async callTool(name, args) {
      callLog.push([name, args]);
      return { content: [{ type: 'text', text: 'error_rate=0.02' }], isError: false };
    },
  };
}

async function registerGrafana(
  ctx: TestAgentContext,
  callLog: Array<[string, unknown]> = [],
): Promise<void> {
  const client = grafanaClient(callLog);
  const defs = await client.listTools();
  ctx.agent.tools.registerMcpServer(
    'grafana',
    client,
    defs.map((d) => ({
      name: d.name,
      description: d.description,
      parameters: d.inputSchema as Record<string, unknown>,
    })),
  );
}

async function disclosureAgent(
  callLog: Array<[string, unknown]> = [],
): Promise<TestAgentContext> {
  const ctx = testAgent({ experimentalFlags: toolSelectFlagOn() });
  ctx.configure({
    tools: ['Read', 'mcp__*'],
    provider: DISCLOSURE_PROVIDER,
    modelCapabilities: DISCLOSURE_CAPABILITIES,
  });
  await registerGrafana(ctx, callLog);
  return ctx;
}

function selectCall(id: string, names: readonly string[]): ToolCall {
  return {
    type: 'function',
    id,
    name: 'select_tools',
    arguments: JSON.stringify({ names }),
  };
}

function mcpCall(id: string, query: string): ToolCall {
  return {
    type: 'function',
    id,
    name: GRAFANA_TOOL,
    arguments: JSON.stringify({ query }),
  };
}

async function runTurn(ctx: TestAgentContext, prompt: string): Promise<void> {
  await ctx.rpc.prompt({ input: [{ type: 'text', text: prompt }] });
  await ctx.untilTurnEnd();
}

function historyText(ctx: TestAgentContext): string {
  return ctx.agent.context.history
    .flatMap((m) => m.content)
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

function toolResultTexts(ctx: TestAgentContext): string[] {
  return ctx.agent.context.history
    .filter((m) => m.role === 'tool')
    .map((m) => m.content.map((p) => (p.type === 'text' ? p.text : '')).join(''));
}

function schemaMessages(ctx: TestAgentContext) {
  return ctx.agent.context.history.filter((m) => m.tools !== undefined && m.tools.length > 0);
}

describe('gate closed — inline regression baseline (S0)', () => {
  it('without the flag, MCP tools stay inline and nothing about disclosure appears', async () => {
    const ctx = testAgent({ experimentalFlags: toolSelectFlagOff() });
    ctx.configure({
      tools: ['Read', 'mcp__*'],
      provider: DISCLOSURE_PROVIDER,
      modelCapabilities: DISCLOSURE_CAPABILITIES,
    });
    await registerGrafana(ctx);

    const loopNames = ctx.agent.tools.loopTools.map((t) => t.name);
    expect(loopNames).toContain(GRAFANA_TOOL);
    expect(loopNames).not.toContain('select_tools');
    expect(ctx.agent.tools.loopTools.every((t) => t.deferred !== true)).toBe(true);

    ctx.mockNextResponse({ type: 'text', text: 'hello' });
    await runTurn(ctx, 'hi');

    const call = ctx.llmCalls[0]!;
    expect(call.tools.map((t) => t.name)).toContain(GRAFANA_TOOL);
    expect(call.tools.map((t) => t.name)).not.toContain('select_tools');
    expect(historyText(ctx)).not.toContain('<tools_added>');
  });

  it('without the model capability, the flag alone changes nothing', async () => {
    const ctx = testAgent({ experimentalFlags: toolSelectFlagOn() });
    ctx.configure({
      tools: ['Read', 'mcp__*'],
      provider: INLINE_PROVIDER,
      modelCapabilities: INLINE_CAPABILITIES,
    });
    await registerGrafana(ctx);

    const loopNames = ctx.agent.tools.loopTools.map((t) => t.name);
    expect(loopNames).toContain(GRAFANA_TOOL);
    expect(loopNames).not.toContain('select_tools');

    ctx.mockNextResponse({ type: 'text', text: 'hello' });
    await runTurn(ctx, 'hi');
    expect(ctx.llmCalls[0]!.tools.map((t) => t.name)).toContain(GRAFANA_TOOL);
    expect(historyText(ctx)).not.toContain('<tools_added>');
  });
});

describe('disclosure mode — top-level convergence and announcements', () => {
  it('keeps MCP tools out of the top level, registers select_tools, and announces the manifest', async () => {
    const ctx = await disclosureAgent();

    // Executable table before any select: core + select_tools, no MCP names.
    const loopNames = ctx.agent.tools.loopTools.map((t) => t.name);
    expect(loopNames).toContain('select_tools');
    expect(loopNames).toContain('Read');
    expect(loopNames.some((n) => n.startsWith('mcp__'))).toBe(false);

    ctx.mockNextResponse({ type: 'text', text: 'hello' });
    await runTurn(ctx, 'hi');

    // Wire top-level: no MCP schema, select_tools present.
    const call = ctx.llmCalls[0]!;
    const wireNames = call.tools.map((t) => t.name);
    expect(wireNames).toContain('select_tools');
    expect(wireNames.some((n) => n.startsWith('mcp__'))).toBe(false);

    // First boundary announces the full loadable list; the request saw it.
    const announcements = ctx.agent.context.history.filter(isLoadableToolsAnnouncement);
    expect(announcements).toHaveLength(1);
    expect(historyText(ctx)).toContain(`<tools_added>\n${GRAFANA_TOOL}\n</tools_added>`);
    expect(JSON.stringify(call.history)).toContain(GRAFANA_TOOL);
  });

  it('does not re-announce when the loadable set is unchanged', async () => {
    const ctx = await disclosureAgent();
    ctx.mockNextResponse({ type: 'text', text: 'one' });
    await runTurn(ctx, 'first');
    ctx.mockNextResponse({ type: 'text', text: 'two' });
    await runTurn(ctx, 'second');

    expect(ctx.agent.context.history.filter(isLoadableToolsAnnouncement)).toHaveLength(1);
  });

  it('announces tools_removed at the next boundary after a server disconnects', async () => {
    const ctx = await disclosureAgent();
    ctx.mockNextResponse({ type: 'text', text: 'one' });
    await runTurn(ctx, 'first');

    ctx.agent.tools.unregisterMcpServer('grafana');
    ctx.mockNextResponse({ type: 'text', text: 'two' });
    await runTurn(ctx, 'second');

    expect(historyText(ctx)).toContain(`<tools_removed>\n${GRAFANA_TOOL}\n</tools_removed>`);
    expect(foldAnnouncedToolNames(ctx.agent.context.history).size).toBe(0);
  });
});

describe('disclosure mode — select_tools three branches and dispatch', () => {
  it('loads a schema, makes it dispatchable on the next step of the same turn', async () => {
    const callLog: Array<[string, unknown]> = [];
    const ctx = await disclosureAgent(callLog);
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse({ type: 'text', text: 'loading' }, selectCall('call-1', [GRAFANA_TOOL]));
    ctx.mockNextResponse({ type: 'text', text: 'querying' }, mcpCall('call-2', 'errors'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await runTurn(ctx, 'check the error rate');

    // Three-branch result: loaded.
    expect(toolResultTexts(ctx)).toContainEqual(`Loaded: ${GRAFANA_TOOL}`);

    // The schema message landed after the closed select exchange, carrying the
    // registry schema.
    const schemas = schemaMessages(ctx);
    expect(schemas).toHaveLength(1);
    expect(schemas[0]!.tools!.map((t) => t.name)).toEqual([GRAFANA_TOOL]);
    expect(schemas[0]!.content).toEqual([]);

    // Step 2 dispatched the freshly loaded tool through the real MCP client.
    expect(callLog).toEqual([['query_range', { query: 'errors' }]]);
    expect(toolResultTexts(ctx)).toContainEqual('error_rate=0.02');

    // The step-2 request carried the schema message but kept the top level clean.
    const step2 = ctx.llmCalls[1]!;
    expect(step2.tools.map((t) => t.name).some((n) => n.startsWith('mcp__'))).toBe(false);
    expect(step2.history.some((m) => m.tools !== undefined && m.tools.length > 0)).toBe(true);
  });

  it('keeps the top-level tools snapshot stable across select_tools loads', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ experimentalFlags: toolSelectFlagOn(), persistence });
    ctx.configure({
      tools: ['Read', 'mcp__*'],
      provider: DISCLOSURE_PROVIDER,
      modelCapabilities: DISCLOSURE_CAPABILITIES,
    });
    await registerGrafana(ctx);

    ctx.mockNextResponse({ type: 'text', text: 'loading' }, selectCall('call-1', [GRAFANA_TOOL]));
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await runTurn(ctx, 'load it');
    ctx.mockNextResponse({ type: 'text', text: 'two' });
    await runTurn(ctx, 'again');

    // Loaded schemas travel via message-level tools declarations (recorded as
    // context messages); the byte-stable top level stays one snapshot.
    const snapshots = persistence.records.filter(
      (record): record is Extract<AgentRecord, { type: 'llm.tools_snapshot' }> =>
        record.type === 'llm.tools_snapshot',
    );
    expect(snapshots).toHaveLength(1);
    const snapshotNames = snapshots[0]!.tools.map((tool) => tool.name);
    expect(snapshotNames).toContain('select_tools');
    expect(snapshotNames).toContain('Read');
    expect(snapshotNames.some((name) => name.startsWith('mcp__'))).toBe(false);

    const requests = persistence.records.filter(
      (record): record is Extract<AgentRecord, { type: 'llm.request' }> =>
        record.type === 'llm.request',
    );
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.toolsHash).toBe(snapshots[0]!.hash);
      expect(request.toolSelect).toBe(true);
    }
  });

  it('reports Already available without re-injecting, and Unknown per name', async () => {
    const ctx = await disclosureAgent();

    ctx.mockNextResponse({ type: 'text', text: 'loading' }, selectCall('call-1', [GRAFANA_TOOL]));
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await runTurn(ctx, 'load it');

    // Mixed input: one already loaded, one unknown — settled per name.
    ctx.mockNextResponse(
      { type: 'text', text: 'again' },
      selectCall('call-2', [GRAFANA_TOOL, 'mcp__nope__missing']),
    );
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await runTurn(ctx, 'load again');

    const results = toolResultTexts(ctx);
    expect(results).toContainEqual(
      `Already available: ${GRAFANA_TOOL}\n` +
        'Unknown tool: mcp__nope__missing. Pick from the latest announced tools list.',
    );
    // No duplicate schema injection.
    expect(schemaMessages(ctx)).toHaveLength(1);
  });

  it('errors when every requested name is unknown', async () => {
    const ctx = await disclosureAgent();
    ctx.mockNextResponse(
      { type: 'text', text: 'try' },
      selectCall('call-1', ['mcp__ghost__tool']),
    );
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await runTurn(ctx, 'load ghost');

    const errorResult = ctx.agent.context.history.find(
      (m) => m.role === 'tool' && m.isError === true,
    );
    expect(errorResult).toBeDefined();
    expect(schemaMessages(ctx)).toHaveLength(0);
  });
});

describe('disclosure mode — preflight wording', () => {
  it('distinguishes not-loaded from loaded-but-disconnected', async () => {
    const ctx = await disclosureAgent();
    await ctx.rpc.setPermission({ mode: 'yolo' });

    // Call without selecting first → guidance to select.
    ctx.mockNextResponse({ type: 'text', text: 'call' }, mcpCall('call-1', 'errors'));
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await runTurn(ctx, 'query directly');
    expect(toolResultTexts(ctx).join('\n')).toContain(
      `Tool "${GRAFANA_TOOL}" is available but not loaded.`,
    );

    // Load it, then disconnect the server → disconnected wording, not "not found".
    ctx.mockNextResponse({ type: 'text', text: 'load' }, selectCall('call-2', [GRAFANA_TOOL]));
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await runTurn(ctx, 'load it');
    ctx.agent.tools.unregisterMcpServer('grafana');

    ctx.mockNextResponse({ type: 'text', text: 'call again' }, mcpCall('call-3', 'errors'));
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await runTurn(ctx, 'query again');
    expect(toolResultTexts(ctx).join('\n')).toContain(
      `Tool "${GRAFANA_TOOL}" was loaded but its MCP server is currently disconnected.`,
    );
  });
});

describe('disclosure mode — undo semantics', () => {
  it('keeps schema messages across undo, drops announcements, and self-heals', async () => {
    const ctx = await disclosureAgent();

    ctx.mockNextResponse({ type: 'text', text: 'load' }, selectCall('call-1', [GRAFANA_TOOL]));
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await runTurn(ctx, 'load it');
    expect(schemaMessages(ctx)).toHaveLength(1);
    expect(ctx.agent.context.history.filter(isLoadableToolsAnnouncement)).toHaveLength(1);

    await ctx.rpc.undoHistory({ count: 1 });

    // Schema injection survives (injection origin); the announcement and the
    // select exchange are gone.
    expect(schemaMessages(ctx)).toHaveLength(1);
    expect(ctx.agent.context.history.filter(isLoadableToolsAnnouncement)).toHaveLength(0);
    expect(ctx.agent.tools.loadedDynamicToolNames().has(GRAFANA_TOOL)).toBe(true);

    // Next turn re-announces (diff against the rolled-back fold) and a
    // re-select reports Already available instead of re-injecting.
    ctx.mockNextResponse({ type: 'text', text: 'again' }, selectCall('call-2', [GRAFANA_TOOL]));
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await runTurn(ctx, 'load again');
    expect(ctx.agent.context.history.filter(isLoadableToolsAnnouncement)).toHaveLength(1);
    expect(toolResultTexts(ctx)).toContainEqual(`Already available: ${GRAFANA_TOOL}`);
    expect(schemaMessages(ctx)).toHaveLength(1);
  });
});

describe('disclosure mode — model switch projection', () => {
  it('strips dynamic-tool context for a non-supporting model and restores it on switch-back', async () => {
    const ctx = await disclosureAgent();

    ctx.mockNextResponse({ type: 'text', text: 'load' }, selectCall('call-1', [GRAFANA_TOOL]));
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await runTurn(ctx, 'load it');

    // Canonical history holds the protocol context.
    expect(schemaMessages(ctx)).toHaveLength(1);

    // Switch to a model without select_tools: the outgoing view drops the
    // schema message and the announcements; the tool table inlines MCP again.
    ctx.configureRuntimeModel(INLINE_PROVIDER, INLINE_CAPABILITIES);
    expect(ctx.agent.toolSelectEnabled).toBe(false);
    const projected = ctx.agent.context.messages;
    expect(projected.some((m) => m.tools !== undefined)).toBe(false);
    expect(
      projected.some((m) =>
        m.content.some((p) => p.type === 'text' && p.text.includes('<tools_added>')),
      ),
    ).toBe(false);
    const inlineNames = ctx.agent.tools.loopTools.map((t) => t.name);
    expect(inlineNames).toContain(GRAFANA_TOOL);
    expect(inlineNames).not.toContain('select_tools');
    expect(ctx.agent.tools.loopTools.every((t) => t.deferred !== true)).toBe(true);

    // Switch back: history was never rewritten, the ledger re-scan picks the
    // loaded tool back up as a deferred extra and projection restores.
    ctx.configureRuntimeModel(DISCLOSURE_PROVIDER, DISCLOSURE_CAPABILITIES);
    expect(ctx.agent.toolSelectEnabled).toBe(true);
    expect(ctx.agent.context.messages.some((m) => m.tools !== undefined)).toBe(true);
    const backNames = ctx.agent.tools.loopTools.map((t) => t.name);
    expect(backNames).toContain('select_tools');
    expect(backNames).toContain(GRAFANA_TOOL);
    const extra = ctx.agent.tools.loopTools.find((t) => t.name === GRAFANA_TOOL);
    expect(extra?.deferred).toBe(true);
  });
});

describe('disclosure mode — executable table freshness', () => {
  it('keeps goal tools visible without waiting for goal state changes', async () => {
    const ctx = await disclosureAgent();
    ctx.configure({
      tools: ['Read', 'UpdateGoal', 'SetGoalBudget', 'mcp__*'],
      provider: DISCLOSURE_PROVIDER,
      modelCapabilities: DISCLOSURE_CAPABILITIES,
    });
    expect(ctx.agent.tools.loopTools.map((t) => t.name)).toContain('UpdateGoal');
    expect(ctx.agent.tools.loopTools.map((t) => t.name)).toContain('SetGoalBudget');

    await ctx.agent.goal.createGoal({ objective: 'ship the feature' });
    expect(ctx.agent.tools.loopTools.map((t) => t.name)).toContain('UpdateGoal');
    expect(ctx.agent.tools.loopTools.map((t) => t.name)).toContain('SetGoalBudget');
  });

  it('rebuilds the ledger from a replayed history with no in-memory state (resume path)', () => {
    // Resume replays records into the context history; the ledger must come
    // back from the history scan alone — there is no persisted ledger state.
    const schemaMessage = {
      role: 'system',
      content: [],
      toolCalls: [],
      tools: [{ name: GRAFANA_TOOL, description: 'replayed', parameters: {} }],
      origin: { kind: 'injection', variant: 'dynamic_tool_schema' },
    } as const;
    const agent = {
      toolSelectEnabled: true,
      context: { history: [schemaMessage] },
      config: { hasProvider: false },
      goal: { getGoal: () => ({ goal: null }) },
    } as unknown as Agent;
    const manager = new ToolManager(agent);
    expect(manager.loadedDynamicToolNames().has(GRAFANA_TOOL)).toBe(true);
  });
});

describe('disclosure mode — compaction', () => {
  it('filters protocol context from the summarizer input and discards loaded schemas after compaction', async () => {
    const ctx = await disclosureAgent();

    ctx.mockNextResponse({ type: 'text', text: 'load' }, selectCall('call-1', [GRAFANA_TOOL]));
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await runTurn(ctx, 'load it');
    expect(schemaMessages(ctx)).toHaveLength(1);

    const compacted = new Promise<{ tokensAfter: number }>((resolve) => {
      ctx.emitter.once('context.apply_compaction', (entry: { args: { tokensAfter: number } }) => {
        resolve({ tokensAfter: entry.args.tokensAfter });
      });
    });
    const completed = ctx.once('compaction.completed');
    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    await ctx.rpc.beginCompaction({});
    const { tokensAfter } = await compacted;
    await completed;

    // Summarizer input: no schema messages, no announcements.
    const summarizerCall = ctx.llmCalls.at(-1)!;
    expect(summarizerCall.history.some((m) => m.tools !== undefined)).toBe(false);
    expect(JSON.stringify(summarizerCall.history)).not.toContain('<tools_added>');

    // Post-compaction context: the loaded set is DISCARDED — no schema
    // message is rebuilt, the ledger is empty, deferred extras drop out of
    // the executable table. The boundary announcement re-lists every
    // loadable name so the model re-selects what it still needs.
    expect(schemaMessages(ctx)).toHaveLength(0);
    expect(ctx.agent.tools.loadedDynamicToolNames().has(GRAFANA_TOOL)).toBe(false);
    expect(ctx.agent.tools.loopTools.map((t) => t.name)).not.toContain(GRAFANA_TOOL);
    expect(ctx.agent.context.history.filter(isLoadableToolsAnnouncement)).toHaveLength(1);
    expect(historyText(ctx)).toContain(`<tools_added>\n${GRAFANA_TOOL}\n</tools_added>`);

    // The "nothing new since compaction" guard is baselined on the true
    // post-compaction floor: summary + the reinjected announcement (no
    // rebuild message anymore). A baseline missing any re-appended piece
    // would let auto-compaction re-trigger against a floor that cannot
    // shrink (each round strips and re-appends the same reminders).
    const internals = ctx.agent.fullCompaction as unknown as {
      lastCompactedTokenCount: number | null;
    };
    const reAnnouncement = ctx.agent.context.history.filter(isLoadableToolsAnnouncement).at(-1)!;
    expect(internals.lastCompactedTokenCount).toBe(
      tokensAfter + estimateTokensForMessage(reAnnouncement),
    );

    // Re-selecting after compaction takes the injection branch again (not
    // "Already available") — the discard is total, not just cosmetic.
    ctx.mockNextResponse({ type: 'text', text: 'reload' }, selectCall('call-2', [GRAFANA_TOOL]));
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await runTurn(ctx, 'load it again');
    expect(toolResultTexts(ctx)).toContainEqual(`Loaded: ${GRAFANA_TOOL}`);
    expect(schemaMessages(ctx)).toHaveLength(1);
    expect(ctx.agent.tools.loadedDynamicToolNames().has(GRAFANA_TOOL)).toBe(true);

    // The baseline lives strictly within one turn: runOneTurn re-arms it at
    // every turn boundary, which is what makes cross-turn staleness (undo,
    // model switches, /clear while idle) structurally impossible. If this
    // reset ever moves, the guard's staleness analysis must be redone.
    expect(internals.lastCompactedTokenCount).toBeNull();
  });

  it('survives a runtime tool-select flag flip without a builtin refresh', async () => {
    // Config reload calls FlagResolver.setConfigOverrides on the live
    // resolver; initializeBuiltinTools does NOT re-run. select_tools must
    // still be fully usable the moment the gate opens (it is registered
    // unconditionally; only its exposure is gated), and flipping back off
    // must restore the inline shape.
    const callLog: Array<[string, unknown]> = [];
    const resolver = toolSelectFlagOff();
    const ctx = testAgent({ experimentalFlags: resolver });
    ctx.configure({
      tools: ['Read', 'mcp__*'],
      provider: DISCLOSURE_PROVIDER,
      modelCapabilities: DISCLOSURE_CAPABILITIES,
    });
    await registerGrafana(ctx, callLog);
    await ctx.rpc.setPermission({ mode: 'yolo' });

    // Flag off: inline.
    ctx.mockNextResponse({ type: 'text', text: 'inline' });
    await runTurn(ctx, 'first');
    const inlineCall = ctx.llmCalls.at(-1)!;
    expect(inlineCall.tools.map((t) => t.name)).toContain(GRAFANA_TOOL);
    expect(inlineCall.tools.map((t) => t.name)).not.toContain('select_tools');

    // Flip on at runtime: the full select → dispatch chain must work.
    resolver.setConfigOverrides({ 'tool-select': true });
    ctx.mockNextResponse({ type: 'text', text: 'loading' }, selectCall('call-1', [GRAFANA_TOOL]));
    ctx.mockNextResponse({ type: 'text', text: 'querying' }, mcpCall('call-2', 'errors'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await runTurn(ctx, 'now use the tool');
    const disclosureCall = ctx.llmCalls.at(-3)!;
    expect(disclosureCall.tools.map((t) => t.name)).toContain('select_tools');
    expect(disclosureCall.tools.map((t) => t.name).some((n) => n.startsWith('mcp__'))).toBe(false);
    expect(callLog).toEqual([['query_range', { query: 'errors' }]]);

    // Flip back off: inline again, select_tools gone from the wire.
    resolver.setConfigOverrides({});
    ctx.mockNextResponse({ type: 'text', text: 'inline again' });
    await runTurn(ctx, 'back');
    const backCall = ctx.llmCalls.at(-1)!;
    expect(backCall.tools.map((t) => t.name)).toContain(GRAFANA_TOOL);
    expect(backCall.tools.map((t) => t.name)).not.toContain('select_tools');
  });

  it('discards heavy loaded schemas at compaction instead of re-entering the trigger band', async () => {
    // A trigger far below one fat schema: if compaction carried loaded
    // schemas back into the context, the post-compaction floor (users +
    // summary + schema) would sit permanently above the trigger and every
    // later step would re-compact in a loop (with the default Infinity
    // per-turn cap, forever). Discard-on-compaction keeps the floor at
    // users + summary, structurally outside the band.
    const trigger = 2_000;
    const ctx = testAgent({
      experimentalFlags: toolSelectFlagOn(),
      compactionStrategy: {
        shouldCompact: (used: number) => used >= trigger,
        shouldBlock: (used: number) => used >= trigger,
        checkAfterStep: false,
        maxCompactionPerTurn: 3,
        maxOverflowCompactionAttempts: 3,
      },
    });
    ctx.configure({
      tools: ['Read', 'mcp__*'],
      provider: DISCLOSURE_PROVIDER,
      modelCapabilities: DISCLOSURE_CAPABILITIES,
    });
    const fatClient: MCPClient = {
      async listTools() {
        return [
          {
            name: 'query_range',
            // ~3k estimated tokens — alone far past the 2k trigger budget.
            description: 'x'.repeat(12_000),
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      },
      async callTool() {
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      },
    };
    ctx.agent.tools.registerMcpServer(
      'grafana',
      fatClient,
      (await fatClient.listTools()).map((d) => ({
        name: d.name,
        description: d.description,
        parameters: d.inputSchema as Record<string, unknown>,
      })),
    );
    await ctx.rpc.setPermission({ mode: 'yolo' });

    // Step 1 loads the fat schema; step 2's boundary trips the trigger and
    // blocks on auto-compaction (consuming the summary mock), which discards
    // the loaded schema. Step 2 then calls the MCP tool directly — the
    // executable table is resolved AFTER the compaction (same state as the
    // messages), so the now-unloaded tool must be rejected by preflight, not
    // dispatched.
    const fatCallLog: unknown[] = [];
    (fatClient as { callTool: unknown }).callTool = async (...args: unknown[]) => {
      fatCallLog.push(args);
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    };
    ctx.mockNextResponse({ type: 'text', text: 'loading' }, selectCall('call-1', [GRAFANA_TOOL]));
    ctx.mockNextResponse({ type: 'text', text: 'Compacted summary.' });
    ctx.mockNextResponse({ type: 'text', text: 'querying' }, mcpCall('call-2', 'errors'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await runTurn(ctx, 'load the fat tool');

    // The loaded set was discarded: no schema message survives, the ledger is
    // empty again, and the tool is simply re-selectable on demand.
    expect(schemaMessages(ctx)).toHaveLength(0);
    expect(ctx.agent.tools.loadedDynamicToolNames().has(GRAFANA_TOOL)).toBe(false);

    // The direct call after the discard was rejected with select guidance and
    // never reached the MCP client.
    expect(fatCallLog).toHaveLength(0);
    expect(toolResultTexts(ctx).join('\n')).toContain(
      `Tool "${GRAFANA_TOOL}" is available but not loaded.`,
    );

    // Regression: the next turn must not re-compact. (No summary mock is
    // queued — an unexpected compaction would fail the scripted generate.)
    const started: unknown[] = [];
    ctx.emitter.on('compaction.started', (event) => started.push(event));
    ctx.mockNextResponse({ type: 'text', text: 'quiet turn' });
    await runTurn(ctx, 'still fine?');
    expect(started).toHaveLength(0);
  });
});
