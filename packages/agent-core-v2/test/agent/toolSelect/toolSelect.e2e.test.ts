/**
 * Scenario (v1 `tool-select.e2e.test.ts` headline parity): progressive tool
 * disclosure converges the provider-visible table, keeps it byte-stable
 * across loads, makes a loaded tool dispatchable the next step, and
 * self-heals the loaded-ledger across undo.
 *
 * Responsibilities: assert v1 contract at the provider wire, not via service
 * internals: the manifest announcement reaches the model, `select_tools`
 * loads a schema into the next request, the top-level table never changes
 * across loads, the record carries the disclosure gate (v1 recorder parity,
 * F2), and a tail-slicing undo re-enables re-injection (F1). Wiring:
 * testAgent harness with scripted provider, real toolSelect / executor /
 * projector / announcer services; harness builds the Agent scope without
 * `AgentLifecycleService.create`, so the eager-instantiation production
 * would do (agentLifecycleService create) is forced here the same way.
 * The flag env is stubbed before `createTestAgent` snapshots it into
 * bootstrap, and module imports register the flag / tool contributions the
 * way `src/index.ts` does in production.
 * Run: ../../node_modules/.bin/vitest run test/toolSelect/toolSelect.e2e.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ExecutableTool, ToolExecution } from '#/tool/toolContract';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { TOOL_SELECT_FLAG_ENV } from '#/agent/toolSelect/flag';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { IAgentToolSelectAnnouncementsService } from '#/agent/toolSelect/toolSelectAnnouncements';
import '#/agent/toolSelect/tools/select-tools';

import { createTestAgent, type TestAgentContext } from '../../harness';

const MCP_ALPHA = 'mcp__srv__alpha';

const DISCLOSURE_CAPABILITIES = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: 128_000,
  select_tools: true,
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

  beforeEach(async () => {
    vi.stubEnv(TOOL_SELECT_FLAG_ENV, '1');
    ctx = createTestAgent();
    ctx.get(IAgentToolSelectService);
    ctx.get(IAgentToolSelectAnnouncementsService);
    ctx.get(IAgentToolExecutorService);
    ctx.configure({ modelCapabilities: DISCLOSURE_CAPABILITIES });
    await ctx.rpc.setPermission({ mode: 'yolo' });
    alpha = new StubMcpTool(MCP_ALPHA);
    registration = ctx.get(IAgentToolRegistryService).register(alpha, { source: 'mcp' });
  });

  afterEach(async () => {
    registration?.dispose();
    vi.unstubAllEnvs();
    await ctx.dispose();
  });

  it('announces the manifest, loads by name, keeps the top-level table byte-stable, and dispatches on the next step', async () => {
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

    expect(ctx.llmCalls).toHaveLength(3);

    const firstWire = ctx.llmCalls[0]!;
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
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect((request.args as { toolSelect?: boolean }).toolSelect).toBe(true);
    }

    const secondWire = ctx.llmCalls[1]!;
    const schemaMessages = secondWire.history.filter(
      (message) => message.tools?.some((tool) => tool.name === MCP_ALPHA),
    );
    expect(schemaMessages).toHaveLength(1);

    const alphaFromSchema = schemaMessages[0]!.tools!.find((tool) => tool.name === MCP_ALPHA)!;
    expect(alphaFromSchema.parameters).toEqual(alpha.parameters);

    expect(secondWire.tools).toEqual(firstWire.tools);
    expect(wireEvents(ctx, 'llm.tools_snapshot')).toHaveLength(1);

    expect(alpha.calls).toBe(1);
  });

  it('re-injects a selected schema after undo slices the tail of the loaded exchange', async () => {
    ctx.get(IAgentContextMemoryService).append({
      role: 'user',
      content: [{ type: 'text', text: 'earlier question' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });

    ctx.mockNextResponse(selectToolsCall('call_select_1', [MCP_ALPHA]));
    ctx.mockNextResponse({ type: 'text', text: 'alpha is loaded' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load alpha' }] });
    await ctx.untilTurnEnd();

    ctx.get(IAgentContextMemoryService).undo(1);
    const afterUndo = ctx.get(IAgentContextMemoryService).get();
    expect(afterUndo.some((message) => message.tools?.some((tool) => tool.name === MCP_ALPHA))).toBe(
      false,
    );

    ctx.mockNextResponse(selectToolsCall('call_select_2', [MCP_ALPHA]));
    ctx.mockNextResponse({ type: 'text', text: 'reloaded' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'load alpha again' }] });
    await ctx.untilTurnEnd();

    const afterReload = ctx.get(IAgentContextMemoryService).get();
    expect(
      afterReload.some((message) => message.tools?.some((tool) => tool.name === MCP_ALPHA)),
    ).toBe(true);
    expect(historyText(afterReload)).toContain('Loaded: mcp__srv__alpha');
    expect(historyText(afterReload)).not.toContain('Already available: mcp__srv__alpha');
  });
});
