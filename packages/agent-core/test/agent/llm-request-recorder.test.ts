import { describe, expect, it, vi } from 'vitest';

import type { AgentRecord } from '../../src/agent';
import {
  InMemoryAgentRecordPersistence,
  type AgentRecordOf,
} from '../../src/agent/records';
import type { McpConnectionManager, McpServerEntry, McpStatusListener } from '../../src/mcp';
import type { MCPClient, MCPToolDefinition } from '../../src/mcp/types';
import { testAgent, type TestAgentContext } from './harness/agent';

function recordsOf<T extends AgentRecord['type']>(
  persistence: InMemoryAgentRecordPersistence,
  type: T,
): AgentRecordOf<T>[] {
  return persistence.records.filter(
    (record): record is AgentRecordOf<T> => record.type === type,
  );
}

async function runTurn(ctx: TestAgentContext, prompt: string): Promise<void> {
  await ctx.rpc.prompt({ input: [{ type: 'text', text: prompt }] });
  await ctx.untilTurnEnd();
}

describe('llm request trace records', () => {
  it('writes one tools snapshot per unique table and one llm.request per request', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence });
    ctx.configure({ tools: ['Read'] });

    ctx.mockNextResponse({ type: 'text', text: 'one' });
    await runTurn(ctx, 'first');
    ctx.mockNextResponse({ type: 'text', text: 'two' });
    await runTurn(ctx, 'second');

    const snapshots = recordsOf(persistence, 'llm.tools_snapshot');
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0]!;
    expect(snapshot.tools.map((tool) => tool.name)).toEqual(['Read']);
    expect(snapshot.tools[0]!.description.length).toBeGreaterThan(0);
    expect(snapshot.tools[0]!.parameters).toMatchObject({ type: 'object' });

    const requests = recordsOf(persistence, 'llm.request');
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.turnStep)).toEqual(['0.1', '1.1']);
    for (const request of requests) {
      expect(request.kind).toBe('loop');
      expect(request.toolsHash).toBe(snapshot.hash);
      expect(request.systemPromptHash).toMatch(/^[0-9a-f]{64}$/);
      // The request used the config system prompt, so no inline copy.
      expect(request.systemPrompt).toBeUndefined();
      expect(request.messageCount).toBeGreaterThan(0);
      expect(request.model).toBe('mock-model');
      expect(request.toolSelect).toBe(false);
      // Thinking is off, so no keep passthrough is sent or recorded.
      expect(request.thinkingKeep).toBeUndefined();
    }
    // maxTokens is the provider-clamped wire value: the second request has
    // consumed context, so its remaining-context cap is strictly smaller.
    expect(requests[0]!.maxTokens).toBe(1_000_000);
    expect(requests[1]!.maxTokens!).toBeLessThan(requests[0]!.maxTokens!);
  });

  it('writes a new snapshot when the active tool table changes', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence });
    ctx.configure({ tools: ['Read'] });

    ctx.mockNextResponse({ type: 'text', text: 'one' });
    await runTurn(ctx, 'first');
    await ctx.rpc.setActiveTools({ names: ['Read', 'Glob'] });
    ctx.mockNextResponse({ type: 'text', text: 'two' });
    await runTurn(ctx, 'second');

    const snapshots = recordsOf(persistence, 'llm.tools_snapshot');
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]!.hash).not.toBe(snapshots[1]!.hash);
    expect(snapshots[1]!.tools.map((tool) => tool.name)).toEqual(['Glob', 'Read']);

    const requests = recordsOf(persistence, 'llm.request');
    expect(requests.map((request) => request.toolsHash)).toEqual([
      snapshots[0]!.hash,
      snapshots[1]!.hash,
    ]);
  });

  it('does not re-log a durable snapshot after resume', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence });
    ctx.configure({ tools: ['Read'] });
    ctx.mockNextResponse({ type: 'text', text: 'one' });
    await runTurn(ctx, 'first');

    const resumedPersistence = new InMemoryAgentRecordPersistence(
      structuredClone(persistence.records),
    );
    const resumed = testAgent({ persistence: resumedPersistence });
    await resumed.agent.resume();
    resumed.mockNextResponse({ type: 'text', text: 'after resume' });
    await runTurn(resumed, 'again');

    const snapshots = recordsOf(resumedPersistence, 'llm.tools_snapshot');
    expect(snapshots).toHaveLength(1);
    const requests = recordsOf(resumedPersistence, 'llm.request');
    expect(requests).toHaveLength(2);
    expect(requests[1]!.toolsHash).toBe(requests[0]!.toolsHash);
  });

  it('inlines the system prompt when a request bypasses the config prompt', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence });
    ctx.configure();

    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    await ctx.agent.generate(
      ctx.agent.config.provider,
      'summarizer prompt',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] }],
      undefined,
      { signal: new AbortController().signal },
    );

    const request = recordsOf(persistence, 'llm.request').at(-1)!;
    expect(request.systemPrompt).toBe('summarizer prompt');
    expect(request.messageCount).toBe(1);
  });

  it('records the effective kimi thinking effort and keep passthrough', async () => {
    vi.stubEnv('KIMI_MODEL_THINKING_EFFORT', 'max');
    try {
      const persistence = new InMemoryAgentRecordPersistence();
      const ctx = testAgent({ persistence });
      ctx.configure({
        modelCapabilities: {
          image_in: false,
          video_in: false,
          audio_in: false,
          thinking: true,
          tool_use: true,
          max_context_tokens: 1_000_000,
        },
      });
      ctx.agent.config.update({ thinkingEffort: 'high' });

      ctx.mockNextResponse({ type: 'text', text: 'ok' });
      await runTurn(ctx, 'think about it');

      const request = recordsOf(persistence, 'llm.request').at(-1)!;
      // The Kimi provider derives thinkingEffort from the request body's
      // thinking payload, so the env override is the recorded wire value.
      expect(request.thinkingEffort).toBe('max');
      // Default preserved-thinking passthrough while thinking is on.
      expect(request.thinkingKeep).toBe('all');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not record a call that fails the pre-flight abort check', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence });
    ctx.configure();

    // Already-aborted signal: kosong generate() throws before dispatching,
    // so the call never reaches the wire and must leave no request trace.
    const controller = new AbortController();
    controller.abort();
    const recordCountBefore = persistence.records.length;

    await expect(
      ctx.agent.generate(
        ctx.agent.config.provider,
        'prompt',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] }],
        undefined,
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(persistence.records).toHaveLength(recordCountBefore);
    expect(recordsOf(persistence, 'llm.request')).toHaveLength(0);
    expect(recordsOf(persistence, 'llm.tools_snapshot')).toHaveLength(0);
  });
});

describe('mcp.tools_discovered records', () => {
  const RAW_TOOLS: MCPToolDefinition[] = [
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

  function fakeMcp(input: {
    readonly serverName?: string;
    readonly rawTools: readonly MCPToolDefinition[];
    readonly enabledNames: () => ReadonlySet<string>;
    readonly onListener?: (listener: McpStatusListener) => void;
  }): { mcp: McpConnectionManager; entry: McpServerEntry } {
    const client: MCPClient = {
      async listTools() {
        return [...input.rawTools];
      },
      async callTool() {
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      },
    };
    const entry: McpServerEntry = {
      name: input.serverName ?? 'grafana',
      transport: 'stdio',
      status: 'connected',
      toolCount: input.rawTools.length,
    };
    const mcp = {
      list: () => [entry],
      onStatusChange: (listener: McpStatusListener) => {
        input.onListener?.(listener);
        return () => {};
      },
      resolved: () => ({
        client,
        tools: input.rawTools.map((definition) => ({
          name: definition.name,
          description: definition.description,
          parameters: definition.inputSchema as Record<string, unknown>,
        })),
        rawTools: input.rawTools,
        enabledNames: input.enabledNames(),
      }),
      oauthService: undefined,
      getRemoteServerUrl: () => undefined,
    } as unknown as McpConnectionManager;
    return { mcp, entry };
  }

  function attachFakeMcp(ctx: TestAgentContext, mcp: McpConnectionManager): void {
    (ctx.agent as { mcp?: McpConnectionManager }).mcp = mcp;
    ctx.agent.tools.attachMcpTools();
  }

  it('records the raw tools/list once and dedups unchanged re-registrations', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence });
    ctx.configure({ tools: ['mcp__*'] });

    let statusListener: McpStatusListener | undefined;
    let enabled: ReadonlySet<string> = new Set(['query_range']);
    const { mcp, entry } = fakeMcp({
      rawTools: RAW_TOOLS,
      enabledNames: () => enabled,
      onListener: (listener) => {
        statusListener = listener;
      },
    });
    attachFakeMcp(ctx, mcp);
    // Reconnect with identical content: no second record.
    statusListener?.(entry);

    const discoveries = recordsOf(persistence, 'mcp.tools_discovered');
    expect(discoveries).toHaveLength(1);
    expect(discoveries[0]).toMatchObject({
      serverName: 'grafana',
      tools: RAW_TOOLS,
      enabledNames: ['query_range'],
    });
    expect(discoveries[0]!.collisions).toBeUndefined();

    // An allow-list change is a different gating decision — record it.
    enabled = new Set();
    statusListener?.(entry);
    expect(recordsOf(persistence, 'mcp.tools_discovered')).toHaveLength(2);
  });

  it('does not re-log a durable discovery after resume', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence });
    ctx.configure({ tools: ['mcp__*'] });
    const first = fakeMcp({
      rawTools: RAW_TOOLS,
      enabledNames: () => new Set(['query_range']),
    });
    attachFakeMcp(ctx, first.mcp);
    expect(recordsOf(persistence, 'mcp.tools_discovered')).toHaveLength(1);

    const resumedPersistence = new InMemoryAgentRecordPersistence(
      structuredClone(persistence.records),
    );
    const resumed = testAgent({ persistence: resumedPersistence });
    await resumed.agent.resume();
    const second = fakeMcp({
      rawTools: RAW_TOOLS,
      enabledNames: () => new Set(['query_range']),
    });
    attachFakeMcp(resumed, second.mcp);

    expect(recordsOf(resumedPersistence, 'mcp.tools_discovered')).toHaveLength(1);
  });

  it('parks a pre-resume discovery and dedups it against the replayed record', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence });
    ctx.configure({ tools: ['mcp__*'] });
    const first = fakeMcp({
      rawTools: RAW_TOOLS,
      enabledNames: () => new Set(['query_range']),
    });
    attachFakeMcp(ctx, first.mcp);
    expect(recordsOf(persistence, 'mcp.tools_discovered')).toHaveLength(1);

    // Real Session ordering: MCP servers are already connected when the
    // resumed agent is constructed, so ToolManager attaches (and observes the
    // discovery) BEFORE agent.resume() replays the wire.
    const resumedPersistence = new InMemoryAgentRecordPersistence(
      structuredClone(persistence.records),
    );
    const recordCountBeforeResume = resumedPersistence.records.length;
    const resumed = testAgent({ persistence: resumedPersistence });
    const second = fakeMcp({
      rawTools: RAW_TOOLS,
      enabledNames: () => new Set(['query_range']),
    });
    attachFakeMcp(resumed, second.mcp);
    // Parked: nothing may be appended before replay — in particular no
    // duplicate discovery and no stray metadata record.
    expect(resumedPersistence.records).toHaveLength(recordCountBeforeResume);

    await resumed.agent.resume();

    expect(recordsOf(resumedPersistence, 'mcp.tools_discovered')).toHaveLength(1);
    expect(
      resumedPersistence.records.filter((record) => record.type === 'metadata'),
    ).toHaveLength(1);
  });

  it('parks a discovery observed before the log opens and writes it after the first record', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence });
    // Attach BEFORE configure: nothing durable exists yet, so the discovery
    // must park instead of opening the log with an observability record.
    const { mcp } = fakeMcp({
      rawTools: RAW_TOOLS,
      enabledNames: () => new Set(['query_range']),
    });
    attachFakeMcp(ctx, mcp);
    expect(persistence.records).toHaveLength(0);

    ctx.configure({ tools: ['mcp__*'] });

    expect(recordsOf(persistence, 'mcp.tools_discovered')).toHaveLength(1);
    expect(persistence.records[0]!.type).toBe('metadata');
    expect(
      persistence.records.filter((record) => record.type === 'metadata'),
    ).toHaveLength(1);
  });

  it('re-records when only the collision outcome changes', async () => {
    const persistence = new InMemoryAgentRecordPersistence();
    const ctx = testAgent({ persistence });
    ctx.configure({ tools: ['mcp__*'] });

    // "graf.ana" sanitizes to "graf_ana", so both servers qualify their tool
    // as mcp__graf_ana__query_range; whoever registers first wins the name.
    const occupant: MCPClient = {
      async listTools() {
        return [];
      },
      async callTool() {
        return { content: [], isError: false };
      },
    };
    ctx.agent.tools.registerMcpServer('graf.ana', occupant, [
      { name: 'query_range', description: 'occupies the qualified name', parameters: {} },
    ]);

    let statusListener: McpStatusListener | undefined;
    const { mcp, entry } = fakeMcp({
      serverName: 'graf_ana',
      rawTools: RAW_TOOLS,
      enabledNames: () => new Set(['query_range']),
      onListener: (listener) => {
        statusListener = listener;
      },
    });
    attachFakeMcp(ctx, mcp);

    const first = recordsOf(persistence, 'mcp.tools_discovered');
    expect(first).toHaveLength(1);
    expect(first[0]!.collisions).toHaveLength(1);

    // Same rawTools and allow-list, but the colliding server is gone: the
    // outcome flips, so a new record must be written.
    ctx.agent.tools.unregisterMcpServer('graf.ana');
    statusListener?.(entry);

    const all = recordsOf(persistence, 'mcp.tools_discovered');
    expect(all).toHaveLength(2);
    expect(all[1]!.collisions).toBeUndefined();
  });
});
