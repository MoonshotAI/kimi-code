import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildCompactionSummaryText,
  createCompactionSummaryMessage,
} from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { MASTER_ENV } from '#/app/flag/flagService';
import {
  ACCEPTED_OUTPUT,
  normalizeTrimOp,
  SPINE_TRIM_SNIPPED_PLACEHOLDER,
  SPINE_TRIM_THRESHOLD_BYTES,
  TRIM_ACCEPTED_OUTPUT,
  WIRE_PROTOCOL_VERSION,
  appendSpineView,
  deriveSpineState,
  IAgentLLMRequesterService,
  IAgentProfileService,
  IAgentSpineService,
  IAgentTokenCountingService,
  loadSpineViewOverride,
  spineTreeViewFromState,
  type SpineTreeNodeView,
  type SpineTreeView,
  type WireRecord,
} from '#/index';

import {
  agentService,
  execEnvServices,
  hostEnvironmentServices,
  InMemoryWireRecordPersistence,
  testAgent,
  wireRecordPersistenceServices,
  type TestAgentContext,
} from '../harness';

const SPINE_ENV = 'KIMI_CODE_SPINE';

const CATALOGUED_PROVIDER = {
  type: 'kimi',
  apiKey: 'test-key',
  model: 'kimi-code',
  baseUrl: 'http://127.0.0.1',
} as const;
const CATALOGUED_MODEL_CAPABILITIES = {
  image_in: true,
  video_in: true,
  audio_in: false,
  thinking: true,
  tool_use: true,
  max_context_tokens: 256_000,
} as const;

describe('Spine projection fold', () => {
  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('folds a closed node span into a memory slot without mutating storage', () => {
    const ctx = testAgent();
    const idx = buildClosedNodeHistory(ctx);

    const stored = ctx.context.get();
    const folded = fold(ctx);

    expect(stored).toHaveLength(idx.after + 1);
    expect(folded).toHaveLength(6);
    expect(textOf(folded[0])).toBe(
      '<spine_node id="1.1" summary="startup" status="live" />',
    );
    expect(textOf(folded[1])).toContain('[U1]');
    expect(textOf(folded[1])).toContain('start');
    expect(textOf(folded[2])).toBe('<spine_memory node_id="1.1.1">\ndid A\n</spine_memory>');
    expect(textOf(folded[3])).toContain('calling spine_close');
    expect(textOf(folded[5])).toContain('[U2]');
    expect(textOf(folded[5])).toContain('after');
    expect(folded.some((m) => textOf(m).includes('<spine_tran_status'))).toBe(false);
  });

  it('persists one spine_tran_status per transition step, carrying the parent summary', async () => {
    const ctx = testAgent();
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('c_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse({ type: 'text', text: 'working' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    let statuses = tranStatuses(ctx);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toContain('cursor="1.1.1"');
    expect(statuses[0]).toContain('summary="task A"');
    expect(statuses[0]).toContain('parent="1.1"');
    expect(statuses[0]).toContain('parent_summary="startup"');
    expect(statuses[0]).toMatch(/ raw_context="~\d/);
    expect(statuses[0]).toMatch(/ projected_context="~?\d/);

    ctx.mockNextResponse({ type: 'text', text: 'still working' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });
    await ctx.untilTurnEnd();
    expect(tranStatuses(ctx)).toHaveLength(1);

    ctx.mockNextResponse(toolCallPart('c_close', 'spine_close', { memory: 'mem A' }));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'wrap' }] });
    await ctx.untilTurnEnd();
    statuses = tranStatuses(ctx);
    expect(statuses).toHaveLength(2);
    expect(statuses[1]).toContain('cursor="1.1"');
    expect(statuses[1]).toContain('parent="1"');
    expect(statuses[1]).toContain('parent_summary="root epoch 1"');
  });

  it('renders persisted statuses as ordinary live-range messages and folds them away with their span', async () => {
    const ctx = testAgent();
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('c_open_p', 'spine_open', { summary: 'parent' }));
    ctx.mockNextResponse(toolCallPart('c_open_c', 'spine_open', { summary: 'child' }));
    ctx.mockNextResponse(toolCallPart('c_close_c', 'spine_close', { memory: 'mem child' }));
    ctx.mockNextResponse(toolCallPart('c_close_p', 'spine_close', { memory: 'mem parent' }));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    expect(tranStatuses(ctx)).toHaveLength(4);
    const visible = fold(ctx).filter((m) => textOf(m).includes('<spine_tran_status'));
    expect(visible).toHaveLength(1);
    expect(textOf(visible[0])).toContain('cursor="1.1"');
  });

  it('persists statuses across resume without re-emitting', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const ctx = testAgent(
      execEnvServices({ hostFs: recordingHostFs(new Map()) }),
      wireRecordPersistenceServices(persistence),
    );
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('c_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse(toolCallPart('c_close', 'spine_close', { memory: 'mem A' }));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();
    expect(tranStatuses(ctx)).toHaveLength(2);
    await ctx.wire.flush();

    const resumed = testAgent(
      execEnvServices({ hostFs: recordingHostFs(new Map()) }),
      wireRecordPersistenceServices(
        new InMemoryWireRecordPersistence(withMetadata(cloneRecords(persistence.records))),
      ),
    );
    await resumed.restorePersisted();
    await configureLoop(resumed);

    resumed.mockNextResponse({ type: 'text', text: 'back' });
    await resumed.rpc.prompt({ input: [{ type: 'text', text: 'resume' }] });
    await resumed.untilTurnEnd();
    expect(tranStatuses(resumed)).toHaveLength(2);

    resumed.mockNextResponse(toolCallPart('c_open2', 'spine_open', { summary: 'task B' }));
    resumed.mockNextResponse({ type: 'text', text: 'done' });
    await resumed.rpc.prompt({ input: [{ type: 'text', text: 'next' }] });
    await resumed.untilTurnEnd();
    const statuses = tranStatuses(resumed);
    expect(statuses).toHaveLength(3);
    expect(statuses[2]).toContain('cursor="1.1.2"');
  });

  it('flattens nested closed nodes into per-node memory slots', () => {
    const ctx = testAgent();
    buildNestedClosedHistory(ctx);

    const folded = fold(ctx);
    const memoryMessages = folded.filter((m) => textOf(m).includes('<spine_memory'));
    expect(memoryMessages).toHaveLength(2);
    expect(textOf(memoryMessages[0])).toBe(
      '<spine_memory node_id="1.1.1.1">\nchild mem\n</spine_memory>',
    );
    expect(textOf(memoryMessages[1])).toBe(
      '<spine_memory node_id="1.1.1">\nparent mem\n</spine_memory>',
    );
  });

  it('is the identity transform when spine is disabled', () => {
    vi.stubEnv(SPINE_ENV, '0');
    const ctx = testAgent();
    buildClosedNodeHistory(ctx);

    const folded = fold(ctx);
    expect(folded.some((m) => textOf(m).includes('<spine_memory'))).toBe(false);
    expect(folded.some((m) => textOf(m).includes('<spine_tran_status'))).toBe(false);
  });

  it('folds the projection through the context projector hook', () => {
    const ctx = testAgent();
    buildClosedNodeHistory(ctx);

    const projected = ctx.project();
    expect(projected.some((m) => textOf(m).includes('<spine_memory'))).toBe(true);
    expect(projected.some((m) => textOf(m).includes('did A'))).toBe(true);
    expect(projected.some((m) => textOf(m).includes('working'))).toBe(false);
  });

  it('leaves the projection untouched when spine is disabled', () => {
    vi.stubEnv(SPINE_ENV, '0');
    const ctx = testAgent();
    buildClosedNodeHistory(ctx);

    const projected = ctx.project();
    expect(projected.some((m) => textOf(m).includes('<spine_memory'))).toBe(false);
    expect(projected.some((m) => textOf(m).includes('working'))).toBe(true);
  });

  it('drops messages before the current epoch after a root compact', () => {
    const ctx = testAgent();
    buildClosedNodeHistory(ctx);
    append(ctx, createCompactionSummaryMessage(buildCompactionSummaryText('epoch summary')));
    append(ctx, userMessage('new epoch work'));

    const folded = fold(ctx);
    expect(textOf(folded[0])).toBe(buildCompactionSummaryText('epoch summary'));
    expect(folded.some((m) => textOf(m).includes('did A'))).toBe(false);
    expect(folded.some((m) => textOf(m).includes('new epoch work'))).toBe(true);
  });

  it('appends the spine view to the system prompt when enabled', async () => {
    const ctx = testAgent();
    await configureLoop(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hi' }] });
    await ctx.untilTurnEnd();

    const systemPrompt = ctx.llmCalls[0]?.systemPrompt ?? '';
    expect(systemPrompt).toContain('<spine_view>');
    expect(systemPrompt).toContain('Spine-managed');
  });

  it('leaves the system prompt untouched when disabled', async () => {
    vi.stubEnv(SPINE_ENV, '0');
    const ctx = testAgent();
    await configureLoop(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hi' }] });
    await ctx.untilTurnEnd();

    const systemPrompt = ctx.llmCalls[0]?.systemPrompt ?? '';
    expect(systemPrompt).not.toContain('<spine_view>');
  });

  it('omits the spine view for operation requests even when enabled', async () => {
    const ctx = testAgent();
    await configureLoop(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'summary' });

    const requester = ctx.get(IAgentLLMRequesterService);
    await requester.request({
      messages: [userMessage('summarize this')],
      source: { type: 'operation', requestKind: 'full_compaction' },
    });

    const systemPrompt = ctx.llmCalls.at(-1)?.systemPrompt ?? '';
    expect(systemPrompt).not.toContain('<spine_view>');
  });

  it('omits the spine view when the request tools do not offer spine_open', async () => {
    const ctx = testAgent();
    await configureLoop(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const requester = ctx.get(IAgentLLMRequesterService);
    await requester.request({
      tools: [{ name: 'Read', description: 'read files', parameters: {} }],
      source: { type: 'turn', turnId: 1 },
    });

    const systemPrompt = ctx.llmCalls.at(-1)?.systemPrompt ?? '';
    expect(systemPrompt).not.toContain('<spine_view>');
  });

  it('appends the spine view when the request tools offer spine_open', async () => {
    const ctx = testAgent();
    await configureLoop(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    const requester = ctx.get(IAgentLLMRequesterService);
    await requester.request({
      tools: [{ name: 'spine_open', description: 'open a node', parameters: {} }],
      source: { type: 'turn', turnId: 1 },
    });

    const systemPrompt = ctx.llmCalls.at(-1)?.systemPrompt ?? '';
    expect(systemPrompt).toContain('<spine_view>');
  });

  it('uses a spine_instruction.md override in place of the built-in view', async () => {
    const homeDir = '/home/test';
    const override = '<spine_view>\nCUSTOM SPINE PROTOCOL\n</spine_view>';
    const hostFs = {
      readText: async (path: string) => {
        if (path === `${homeDir}/spine_instruction.md`) return override;
        throw new Error('ENOENT');
      },
      writeText: async () => {},
      mkdir: async () => {},
    };

    testAgent(hostEnvironmentServices(homeDir), execEnvServices({ hostFs }));
    const view = await loadSpineViewOverride(hostFs, homeDir);

    const spliced = appendSpineView('BASE SYSTEM', view);
    expect(spliced).toContain('CUSTOM SPINE PROTOCOL');
    expect(spliced).not.toContain('Spine-managed');
    expect(spliced.startsWith('BASE SYSTEM')).toBe(true);
  });

  it('carries the override already in the first turn request', async () => {
    const homeDir = '/home/test';
    const override = '<spine_view>\nCUSTOM SPINE PROTOCOL\n</spine_view>';
    const hostFs = {
      readText: async (path: string) => {
        if (path === `${homeDir}/spine_instruction.md`) return override;
        throw new Error('ENOENT');
      },
      writeText: async () => {},
      mkdir: async () => {},
    };

    const ctx = testAgent(hostEnvironmentServices(homeDir), execEnvServices({ hostFs }));
    await configureLoop(ctx);
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hi' }] });
    await ctx.untilTurnEnd();

    const systemPrompt = ctx.llmCalls[0]?.systemPrompt ?? '';
    expect(systemPrompt).toContain('CUSTOM SPINE PROTOCOL');
    expect(systemPrompt).not.toContain('Spine-managed');
  });

  it('reports cursor_context as the projected growth since the cursor opened', async () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantText('earlier work '.repeat(40)));
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('c_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse({ type: 'text', text: 'opened' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'go' }] });
    await ctx.untilTurnEnd();

    const statuses = tranStatuses(ctx);
    expect(statuses).toHaveLength(1);
    const cursorContext = Number(/cursor_context="~(\d+)"/.exec(statuses[0] ?? '')?.[1]);
    expect(cursorContext).toBeLessThan(60);
  });

  it('derives context_left from the overflow-observed effective max', async () => {
    const ctx = testAgent();
    await configureLoop(ctx);
    ctx.get(IAgentProfileService).observeMaxContextTokens(100_000);
    ctx.mockNextResponse(toolCallPart('c_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse({ type: 'text', text: 'opened' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'go' }] });
    await ctx.untilTurnEnd();

    const statuses = tranStatuses(ctx);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toContain('context_left="~100K"');
  });

  it('renders a closed node cost from its baseline-to-close gauge delta', async () => {
    let sizeNow = 10_000;
    const fakeSize = {
      _serviceBrand: undefined,
      get: () => ({ size: sizeNow, measured: sizeNow, estimated: 0 }),
      rawSize: () => sizeNow,
      measured: () => {},
      latestMeasurement: () => undefined,
    } as unknown as IAgentTokenCountingService;
    const ctx = testAgent(agentService(IAgentTokenCountingService, fakeSize));
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('c_open', 'spine_open', { summary: 'task A' }));
    ctx.mockNextResponse({ type: 'text', text: 'opened' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'start' }] });
    await ctx.untilTurnEnd();

    sizeNow = 24_000;
    ctx.mockNextResponse(toolCallPart('c_close', 'spine_close', { memory: 'mem A' }));
    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'continue' }] });
    await ctx.untilTurnEnd();

    expect(ctx.get(IAgentSpineService).renderTree()).toContain('1.1.1 [closed, ~14K, archive:');
  });

  it('replaces each sibling of a next-chain with its own memory', () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantToolCall('o1', 'spine_open', JSON.stringify({ summary: 'task A' })));
    append(ctx, spineAcceptedReceipt('o1'));
    append(ctx, assistantText('A body'));
    append(
      ctx,
      assistantToolCall('n1', 'spine_next', JSON.stringify({ summary: 'task B', memory: 'mem A' })),
    );
    append(ctx, spineAcceptedReceipt('n1'));
    append(ctx, assistantText('B body'));
    append(
      ctx,
      assistantToolCall('n2', 'spine_next', JSON.stringify({ summary: 'task C', memory: 'mem B' })),
    );
    append(ctx, spineAcceptedReceipt('n2'));
    append(ctx, assistantText('C body'));
    append(ctx, assistantToolCall('c1', 'spine_close', JSON.stringify({ memory: 'mem C' })));
    append(ctx, spineAcceptedReceipt('c1'));
    append(ctx, userMessage('finished'));

    const folded = fold(ctx);
    const memories = folded.filter((m) => textOf(m).startsWith('<spine_memory node_id="'));
    expect(memories).toHaveLength(3);
    expect(textOf(memories[0])).toContain('node_id="1.1.1"');
    expect(textOf(memories[0])).toContain('mem A');
    expect(textOf(memories[1])).toContain('node_id="1.1.2"');
    expect(textOf(memories[1])).toContain('mem B');
    expect(textOf(memories[2])).toContain('node_id="1.1.3"');
    expect(textOf(memories[2])).toContain('mem C');
    for (const body of ['A body', 'B body', 'C body']) {
      expect(folded.some((m) => textOf(m).includes(body))).toBe(false);
    }
    expect(textOf(folded[1])).toContain('[U1] start');
    expect(textOf(folded[7])).toContain('[U2] finished');
  });

  it('flattens a closed subtree into per-node memory slots, children first', () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantToolCall('po', 'spine_open', JSON.stringify({ summary: 'parent' })));
    append(ctx, spineAcceptedReceipt('po'));
    append(ctx, assistantToolCall('co', 'spine_open', JSON.stringify({ summary: 'task A' })));
    append(ctx, spineAcceptedReceipt('co'));
    append(ctx, assistantText('A body'));
    append(
      ctx,
      assistantToolCall('n1', 'spine_next', JSON.stringify({ summary: 'task B', memory: 'mem A' })),
    );
    append(ctx, spineAcceptedReceipt('n1'));
    append(ctx, assistantText('B body'));
    append(
      ctx,
      assistantToolCall('n2', 'spine_next', JSON.stringify({ summary: 'task C', memory: 'mem B' })),
    );
    append(ctx, spineAcceptedReceipt('n2'));
    append(ctx, assistantText('C body'));
    append(ctx, assistantToolCall('cc', 'spine_close', JSON.stringify({ memory: 'mem C' })));
    append(ctx, spineAcceptedReceipt('cc'));
    append(ctx, assistantText('parent tail'));
    append(ctx, assistantToolCall('pc', 'spine_close', JSON.stringify({ memory: 'mem parent' })));
    append(ctx, spineAcceptedReceipt('pc'));
    append(ctx, userMessage('final'));

    const folded = fold(ctx);
    const memories = folded.filter((m) => textOf(m).startsWith('<spine_memory node_id="'));
    expect(memories).toHaveLength(4);
    expect(textOf(memories[0])).toBe('<spine_memory node_id="1.1.1.1">\nmem A\n</spine_memory>');
    expect(textOf(memories[1])).toBe('<spine_memory node_id="1.1.1.2">\nmem B\n</spine_memory>');
    expect(textOf(memories[2])).toBe('<spine_memory node_id="1.1.1.3">\nmem C\n</spine_memory>');
    expect(textOf(memories[3])).toBe('<spine_memory node_id="1.1.1">\nmem parent\n</spine_memory>');
    for (const body of ['A body', 'B body', 'C body', 'parent tail']) {
      expect(folded.some((m) => textOf(m).includes(body))).toBe(false);
    }
    expect(textOf(folded[1])).toContain('[U1] start');
    expect(textOf(folded[8])).toContain('[U2] final');
  });

  it('skips nodes closed before the epoch boundary and still folds post-epoch nodes', () => {
    const ctx = testAgent();
    buildClosedNodeHistory(ctx);
    append(ctx, createCompactionSummaryMessage(buildCompactionSummaryText('epoch summary')));
    append(ctx, userMessage('new epoch work'));
    append(ctx, assistantToolCall('b_open', 'spine_open', JSON.stringify({ summary: 'task B' })));
    append(ctx, spineAcceptedReceipt('b_open'));
    append(ctx, assistantText('B working'));
    append(ctx, assistantToolCall('b_close', 'spine_close', JSON.stringify({ memory: 'did B' })));
    append(ctx, spineAcceptedReceipt('b_close'));
    append(ctx, userMessage('tail'));

    const folded = fold(ctx);
    expect(textOf(folded[0])).toBe(buildCompactionSummaryText('epoch summary'));
    expect(folded.some((m) => textOf(m).includes('did A'))).toBe(false);
    const memories = folded.filter((m) => textOf(m).includes('<spine_memory'));
    expect(memories).toHaveLength(1);
    expect(textOf(memories[0])).toContain('did B');
    expect(folded.some((m) => textOf(m).includes('B working'))).toBe(false);
    expect(folded.some((m) => textOf(m).includes('new epoch work'))).toBe(true);
    expect(folded.some((m) => textOf(m).includes('tail'))).toBe(true);
  });

  it('marks an open node boundary with a spine_node landmark before its carrier', () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantToolCall('c_open', 'spine_open', JSON.stringify({ summary: 'task A' })));
    append(ctx, spineAcceptedReceipt('c_open'));
    append(ctx, assistantText('working'));
    append(ctx, userMessage('after'));

    const folded = fold(ctx);
    const texts = folded.map(textOf);
    expect(texts.slice(0, 3)).toEqual([
      '<spine_node id="1.1" summary="startup" status="opened" />',
      '[U1] start',
      '<spine_node id="1.1.1" summary="task A" status="live" />',
    ]);
    expect(texts[3]).toContain('calling spine_open');
    expect(texts[4]).toBe(ACCEPTED_OUTPUT);
    expect(texts[5]).toBe('working');
    expect(texts[6]).toBe('[U2] after');
    expect(texts.some((text) => text.includes('<spine_tran_status'))).toBe(false);
  });

  it('preserves media parts of a user request inside a closed span', () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantToolCall('c_open', 'spine_open', JSON.stringify({ summary: 'task A' })));
    append(ctx, spineAcceptedReceipt('c_open'));
    append(ctx, {
      role: 'user',
      content: [
        { type: 'image_url', imageUrl: { url: 'https://example.com/pic.png' } },
        { type: 'text', text: 'look at this' },
      ],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    append(ctx, assistantText('working'));
    append(ctx, assistantToolCall('c_close', 'spine_close', JSON.stringify({ memory: 'did A' })));
    append(ctx, spineAcceptedReceipt('c_close'));
    append(ctx, userMessage('after'));

    const folded = fold(ctx);
    const surviving = folded.find((m) => m.content.some((part) => part.type === 'image_url'));
    expect(surviving?.role).toBe('user');
    expect(surviving?.content).toEqual([
      { type: 'image_url', imageUrl: { url: 'https://example.com/pic.png' } },
      { type: 'text', text: '[U2] look at this' },
    ]);
  });

  it('escapes the node summary inside the spine_node landmark', () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantToolCall('c_open', 'spine_open', JSON.stringify({ summary: 'a & "b" <c>' })));
    append(ctx, spineAcceptedReceipt('c_open'));

    const folded = fold(ctx);
    expect(
      folded.some((m) =>
        textOf(m).includes(
          '<spine_node id="1.1.1" summary="a &amp; &quot;b&quot; &lt;c&gt;" status="live" />',
        ),
      ),
    ).toBe(true);
  });
});

describe('Spine tree view projection', () => {
  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('projects an empty transcript as the synthetic root epoch and startup node alone', () => {
    expect(spineTreeViewFromState(deriveSpineState([]))).toStrictEqual({
      nodes: [nodeView('1', 'root epoch 1', false, [nodeView('1.1', 'startup', false)])],
    });
  });

  it('projects open and closed nodes in open order and skips rejected transitions', () => {
    const ctx = testAgent();
    buildNextChainHistory(ctx);

    const view = spineTreeViewFromState(ctx.get(IAgentSpineService).currentState());

    expect(view).toStrictEqual({
      nodes: [
        nodeView('1', 'root epoch 1', false, [
          nodeView('1.1', 'startup', false, [
            nodeView('1.1.1', 'task A', true),
            nodeView('1.1.2', 'task B', true),
            nodeView('1.1.3', 'task C', false),
          ]),
        ]),
      ],
    });
  });

  it('marks a superseded root epoch closed while the current epoch stays open', () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, createCompactionSummaryMessage(buildCompactionSummaryText('epoch summary')));
    append(ctx, userMessage('new epoch work'));

    const view = spineTreeViewFromState(ctx.get(IAgentSpineService).currentState());

    expect(view.nodes.map((node) => `${node.id}:${String(node.closed)}`)).toEqual([
      '1:true',
      '2:false',
    ]);
  });

  it('prices nodes and resolves archive paths only from the optional gauges input', () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantToolCall('o1', 'spine_open', JSON.stringify({ summary: 'task A' })));
    append(ctx, spineAcceptedReceipt('o1'));
    append(ctx, assistantToolCall('c1', 'spine_close', JSON.stringify({ memory: 'did A' })));
    append(ctx, spineAcceptedReceipt('c1'));
    append(ctx, assistantToolCall('o2', 'spine_open', JSON.stringify({ summary: 'task B' })));
    append(ctx, spineAcceptedReceipt('o2'));
    const state = ctx.get(IAgentSpineService).currentState();

    const bare = spineTreeViewFromState(state);
    for (const id of ['1', '1.1', '1.1.1', '1.1.2']) {
      const node = findViewNode(bare, id);
      expect(node?.tokenCost).toBeUndefined();
      expect(node?.archivePath).toBeUndefined();
    }

    const view = spineTreeViewFromState(state, {
      currentUsed: 1_000,
      baselines: new Map([
        ['1.1', 100],
        ['1.1.1', 200],
        ['1.1.2', 1_600],
      ]),
      finals: new Map([['1.1.1', 800]]),
      resolveArchivePath: (id, epoch, closed) =>
        epoch || !closed ? undefined : `archive-${id}.md`,
    });

    expect(findViewNode(view, '1.1.1')).toMatchObject({
      closed: true,
      tokenCost: 600,
      archivePath: 'archive-1.1.1.md',
    });
    expect(findViewNode(view, '1.1.2')).toMatchObject({ closed: false, tokenCost: 0 });
    expect(findViewNode(view, '1.1.2')?.archivePath).toBeUndefined();
    expect(findViewNode(view, '1.1')?.tokenCost).toBe(900);
    expect(findViewNode(view, '1')?.tokenCost).toBeUndefined();
  });

  it('renders the service tree through the same projection', () => {
    const ctx = testAgent();
    buildNextChainHistory(ctx);
    const spine = ctx.get(IAgentSpineService);

    const view = spineTreeViewFromState(spine.currentState());
    const rendered = spine.renderTree().split('\n');
    const renderedIds = rendered.map((line) => /^(\S+) \[/.exec(line.trimStart())?.[1]);

    expect(renderedIds).toEqual(flattenViewNodes(view).map((node) => node.id));
    for (const node of flattenViewNodes(view)) {
      const line = rendered.find((candidate) =>
        candidate.trimStart().startsWith(`${node.id} [`),
      );
      expect(line).toContain(node.closed ? '[closed' : '[open');
    }
  });
});

describe('Spine logical session conformance', () => {
  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('projects a basic open-work-close lifecycle end to end', () => {
    const ctx = testAgent();
    replaySession(ctx, [
      { kind: 'user', text: '调研 X' },
      { kind: 'spine_open', id: '1.1.1', summary: '调研 X', parentId: '1.1' },
      { kind: 'assistant', text: 'working on X' },
      { kind: 'tool', id: 'read_1', name: 'Read' },
      { kind: 'spine_close', id: '1.1.1', memory: 'did X' },
      { kind: 'user', text: '下一步' },
    ]);

    expect(canonicalProjection(fold(ctx))).toEqual([
      'user (spine_node): <spine_node id="1.1" summary="startup" status="live" />',
      'user: [U1] 调研 X',
      'user (spine_memory): <spine_memory node_id="1.1.1">\ndid X\n</spine_memory>',
      'assistant: calling spine_close',
      `tool: ${ACCEPTED_OUTPUT}`,
      'user: [U2] 下一步',
    ]);
  });

  it('projects a nested next-chain as flattened per-node memory slots', () => {
    const ctx = testAgent();
    replaySession(ctx, [
      { kind: 'user', text: 'start' },
      { kind: 'spine_open', id: '1.1.1', summary: 'parent', parentId: '1.1' },
      { kind: 'assistant', text: 'parent body' },
      { kind: 'spine_open', id: '1.1.1.1', summary: 'child A', parentId: '1.1.1' },
      { kind: 'assistant', text: 'A body' },
      {
        kind: 'spine_next',
        closedId: '1.1.1.1',
        memory: 'mem A',
        openedId: '1.1.1.2',
        summary: 'child B',
      },
      { kind: 'assistant', text: 'B body' },
      { kind: 'spine_close', id: '1.1.1.2', memory: 'mem B' },
      { kind: 'assistant', text: 'parent tail' },
      { kind: 'spine_close', id: '1.1.1', memory: 'mem parent' },
      { kind: 'user', text: 'final' },
    ]);

    expect(canonicalProjection(fold(ctx))).toEqual([
      'user (spine_node): <spine_node id="1.1" summary="startup" status="live" />',
      'user: [U1] start',
      'user (spine_memory): <spine_memory node_id="1.1.1.1">\nmem A\n</spine_memory>',
      'user (spine_memory): <spine_memory node_id="1.1.1.2">\nmem B\n</spine_memory>',
      'user (spine_memory): <spine_memory node_id="1.1.1">\nmem parent\n</spine_memory>',
      'assistant: calling spine_close',
      `tool: ${ACCEPTED_OUTPUT}`,
      'user: [U2] final',
    ]);
  });

  it('projects an epoch boundary with stable request anchors', () => {
    const ctx = testAgent();
    replaySession(ctx, [
      { kind: 'user', text: 'old request' },
      { kind: 'spine_open', id: '1.1.1', summary: 'epoch-1 task', parentId: '1.1' },
      { kind: 'assistant', text: 'epoch-1 body' },
      { kind: 'spine_close', id: '1.1.1', memory: 'epoch-1 mem' },
      { kind: 'root_compact', epoch: 2, summary: 'epoch summary' },
      { kind: 'user', text: 'new epoch request' },
      { kind: 'spine_open', id: '2.1.1', summary: 'epoch-2 task', parentId: '2.1' },
      { kind: 'assistant', text: 'epoch-2 body' },
      { kind: 'spine_close', id: '2.1.1', memory: 'epoch-2 mem' },
      { kind: 'user', text: 'tail' },
    ]);

    expect(canonicalProjection(fold(ctx))).toEqual([
      `user: ${buildCompactionSummaryText('epoch summary')}`,
      'user (spine_node): <spine_node id="2.1" summary="startup" status="live" />',
      'user: [U2] new epoch request',
      'user (spine_memory): <spine_memory node_id="2.1.1">\nepoch-2 mem\n</spine_memory>',
      'assistant: calling spine_close',
      `tool: ${ACCEPTED_OUTPUT}`,
      'user: [U3] tail',
    ]);
  });
});

describe('Spine derivation from the message stream', () => {
  it('derives the initial state from an empty history', () => {
    const state = deriveSpineState([]);
    expect(state.rootEpoch).toBe(1);
    expect(state.openStack).toEqual(['1', '1.1']);
    expect(state.epochStartAt).toBe(0);
    expect(state.epochMemoryAt).toBeUndefined();
  });

  it('ignores a transition whose receipt is a near-miss of the accepted carrier', () => {
    const state = deriveSpineState([
      userMessage('start'),
      assistantToolCall('c1', 'spine_open', JSON.stringify({ summary: 'task' })),
      toolReceipt('c1', `${ACCEPTED_OUTPUT}.`),
    ]);
    expect(state.openStack).toEqual(['1', '1.1']);
    expect(state.nodes['1.1.1']).toBeUndefined();
  });

  it('honors the legacy bare-accepted receipt from older sessions', () => {
    const state = deriveSpineState([
      userMessage('start'),
      assistantToolCall('c1', 'spine_open', JSON.stringify({ summary: 'task' })),
      toolReceipt('c1', 'accepted'),
    ]);
    expect(state.openStack).toEqual(['1', '1.1', '1.1.1']);
    expect(state.nodes['1.1.1']?.summary).toBe('task');
  });

  it('ignores a transition whose receipt is an error', () => {
    const state = deriveSpineState([
      userMessage('start'),
      assistantToolCall('c1', 'spine_open', JSON.stringify({ summary: 'task' })),
      { ...toolReceipt('c1', ACCEPTED_OUTPUT), isError: true },
    ]);
    expect(state.nodes['1.1.1']).toBeUndefined();
  });

  it('applies only the spine call from a carrier batched with other tool calls', () => {
    const state = deriveSpineState([
      userMessage('start'),
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'batching a spine call with a tool call' }],
        toolCalls: [
          {
            type: 'function',
            id: 'c_spine',
            name: 'spine_open',
            arguments: JSON.stringify({ summary: 'task' }),
          },
          { type: 'function', id: 'c_read', name: 'Read', arguments: '{}' },
        ],
      },
      toolReceipt('c_read', 'file contents'),
      toolReceipt('c_spine', ACCEPTED_OUTPUT),
    ]);
    expect(state.openStack).toEqual(['1', '1.1', '1.1.1']);
    expect(state.nodes['1.1.1']?.summary).toBe('task');
  });

  it('ignores a transition with malformed call arguments', () => {
    const state = deriveSpineState([
      userMessage('start'),
      assistantToolCall('c1', 'spine_open', '{not json'),
      toolReceipt('c1', ACCEPTED_OUTPUT),
    ]);
    expect(state.nodes['1.1.1']).toBeUndefined();
  });

  it('ignores a transition with an empty summary', () => {
    const state = deriveSpineState([
      userMessage('start'),
      assistantToolCall('c1', 'spine_open', JSON.stringify({ summary: '   ' })),
      toolReceipt('c1', ACCEPTED_OUTPUT),
    ]);
    expect(state.nodes['1.1.1']).toBeUndefined();
  });

  it('derives undo truncation from the surviving messages alone', () => {
    const messages = [
      userMessage('start'),
      assistantToolCall('c1', 'spine_open', JSON.stringify({ summary: 'task' })),
      toolReceipt('c1', ACCEPTED_OUTPUT),
      assistantText('working'),
      assistantToolCall('c2', 'spine_close', JSON.stringify({ memory: 'done' })),
      toolReceipt('c2', ACCEPTED_OUTPUT),
    ];
    const full = deriveSpineState(messages);
    expect(full.nodes['1.1.1']?.closedAt).toBe(3);
    expect(full.openStack).toEqual(['1', '1.1']);

    const beforeClose = deriveSpineState(messages.slice(0, 4));
    expect(beforeClose.nodes['1.1.1']?.closedAt).toBeUndefined();
    expect(beforeClose.openStack).toEqual(['1', '1.1', '1.1.1']);

    const beforeOpen = deriveSpineState(messages.slice(0, 1));
    expect(beforeOpen.nodes['1.1.1']).toBeUndefined();
    expect(beforeOpen.openStack).toEqual(['1', '1.1']);
  });

  it('derives multiple root epochs from summary messages', () => {
    const state = deriveSpineState([
      userMessage('old'),
      createCompactionSummaryMessage(buildCompactionSummaryText('epoch 1 done')),
      userMessage('mid'),
      createCompactionSummaryMessage(buildCompactionSummaryText('epoch 2 done')),
      userMessage('now'),
    ]);
    expect(state.rootEpoch).toBe(3);
    expect(state.openStack).toEqual(['3', '3.1']);
    expect(state.epochStartAt).toBe(4);
    expect(state.epochMemoryAt).toBe(3);
    expect(state.nodes['1']).toBeDefined();
    expect(state.nodes['2']).toBeDefined();
  });

  it('detects an epoch boundary from the summary prefix when the origin is absent', () => {
    const state = deriveSpineState([
      userMessage('old'),
      compactionSummaryTextMessage(buildCompactionSummaryText('done')),
      userMessage('now'),
    ]);
    expect(state.rootEpoch).toBe(2);
    expect(state.epochMemoryAt).toBe(1);
  });

  it('trusts a non-summary origin over the summary prefix text', () => {
    const state = deriveSpineState([
      userMessage('old'),
      {
        ...compactionSummaryTextMessage(buildCompactionSummaryText('done')),
        origin: { kind: 'user' },
      },
      userMessage('now'),
    ]);
    expect(state.rootEpoch).toBe(1);
  });
});

describe('Spine spawn projection', () => {
  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('synthesizes N closed siblings from a valid spine_spawn receipt', () => {
    const state = deriveSpineState([
      userMessage('start'),
      spawnCall('s1', [
        { summary: 'task A', prompt: 'do A' },
        { summary: 'task B', prompt: 'do B' },
      ]),
      spawnReceipt('s1', [
        spawnResult(0, 'completed', 'memory A'),
        spawnResult(1, 'completed', 'memory B'),
      ]),
    ]);

    expect(state.openStack).toEqual(['1', '1.1']);
    expect(state.nodes['1.1']?.children).toEqual(['1.1.1', '1.1.2']);
    const a = state.nodes['1.1.1'];
    const b = state.nodes['1.1.2'];
    expect(a).toMatchObject({
      summary: 'task A',
      openedAt: 2,
      closedAt: 2,
      memory: 'memory A',
    });
    expect(b).toMatchObject({
      summary: 'task B',
      openedAt: 2,
      closedAt: 2,
      memory: 'memory B',
    });
    expect(a?.spawn).toEqual({ summary: 'task A', outcome: 'completed' });
    expect(b?.spawn).toEqual({ summary: 'task B', outcome: 'completed' });
  });

  it('orders spawned nodes by input ordinal, not receipt order', () => {
    const state = deriveSpineState([
      userMessage('start'),
      spawnCall('s1', [
        { summary: 'A', prompt: 'a' },
        { summary: 'B', prompt: 'b' },
        { summary: 'C', prompt: 'c' },
      ]),
      spawnReceipt('s1', [
        spawnResult(2, 'completed', 'mem C'),
        spawnResult(0, 'completed', 'mem A'),
        spawnResult(1, 'completed', 'mem B'),
      ]),
    ]);

    expect(state.nodes['1.1']?.children).toEqual(['1.1.1', '1.1.2', '1.1.3']);
    expect(state.nodes['1.1.1']?.summary).toBe('A');
    expect(state.nodes['1.1.2']?.summary).toBe('B');
    expect(state.nodes['1.1.3']?.summary).toBe('C');
    expect(state.nodes['1.1.1']?.memory).toBe('mem A');
    expect(state.nodes['1.1.2']?.memory).toBe('mem B');
    expect(state.nodes['1.1.3']?.memory).toBe('mem C');
  });

  it('records errored/aborted outcomes and diagnostics on spawned nodes', () => {
    const state = deriveSpineState([
      userMessage('start'),
      spawnCall('s1', [
        { summary: 'ok', prompt: 'x' },
        { summary: 'bad', prompt: 'y' },
      ]),
      spawnReceipt('s1', [
        spawnResult(0, 'completed', 'done'),
        spawnResult(1, 'errored', 'failed', 'disk full'),
      ]),
    ]);

    expect(state.nodes['1.1']?.children).toEqual(['1.1.1', '1.1.2']);
    expect(state.nodes['1.1.1']?.spawn).toEqual({ summary: 'ok', outcome: 'completed' });
    expect(state.nodes['1.1.2']?.spawn).toEqual({
      summary: 'bad',
      outcome: 'errored',
      diagnostic: 'disk full',
    });
  });

  it('rejects malformed spawn receipts all-or-nothing', () => {
    const tasks = [
      { summary: 'A', prompt: 'a' },
      { summary: 'B', prompt: 'b' },
    ];

    const badSchema = deriveSpineState([
      userMessage('start'),
      spawnCall('s1', tasks),
      rawSpawnReceipt('s1', {
        schema: 'spine.spawn.result.v0',
        results: [spawnResult(0, 'completed', 'a'), spawnResult(1, 'completed', 'b')],
      }),
    ]);
    expect(badSchema.nodes['1.1']?.children).toEqual([]);

    const gapOrdinal = deriveSpineState([
      userMessage('start'),
      spawnCall('s1', tasks),
      spawnReceipt('s1', [spawnResult(0, 'completed', 'a')]),
    ]);
    expect(gapOrdinal.nodes['1.1']?.children).toEqual([]);

    const emptyMemory = deriveSpineState([
      userMessage('start'),
      spawnCall('s1', tasks),
      spawnReceipt('s1', [
        spawnResult(0, 'completed', 'a'),
        spawnResult(1, 'completed', ''),
      ]),
    ]);
    expect(emptyMemory.nodes['1.1']?.children).toEqual([]);

    const mismatchCount = deriveSpineState([
      userMessage('start'),
      spawnCall('s1', tasks),
      spawnReceipt('s1', [
        spawnResult(0, 'completed', 'a'),
        spawnResult(1, 'completed', 'b'),
        spawnResult(2, 'completed', 'c'),
      ]),
    ]);
    expect(mismatchCount.nodes['1.1']?.children).toEqual([]);

    const missingDiagnostic = deriveSpineState([
      userMessage('start'),
      spawnCall('s1', tasks),
      spawnReceipt('s1', [
        spawnResult(0, 'completed', 'a'),
        spawnResult(1, 'errored', 'b'),
      ]),
    ]);
    expect(missingDiagnostic.nodes['1.1']?.children).toEqual([]);
  });

  it('keeps child indices contiguous when spawn is mixed with open/close/next', () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantToolCall('o1', 'spine_open', JSON.stringify({ summary: 'task A' })));
    append(ctx, spineAcceptedReceipt('o1'));
    append(ctx, assistantToolCall('c1', 'spine_close', JSON.stringify({ memory: 'did A' })));
    append(ctx, spineAcceptedReceipt('c1'));
    append(
      ctx,
      spawnCall('s1', [
        { summary: 'spawn 1', prompt: 'p1' },
        { summary: 'spawn 2', prompt: 'p2' },
      ]),
    );
    append(
      ctx,
      spawnReceipt('s1', [
        spawnResult(0, 'completed', 'mem 1'),
        spawnResult(1, 'completed', 'mem 2'),
      ]),
    );
    append(ctx, assistantToolCall('o2', 'spine_open', JSON.stringify({ summary: 'task B' })));
    append(ctx, spineAcceptedReceipt('o2'));

    const state = deriveSpineState(ctx.context.get());
    expect(state.nodes['1.1']?.children).toEqual(['1.1.1', '1.1.2', '1.1.3', '1.1.4']);
    expect(state.nodes['1.1.1']?.summary).toBe('task A');
    expect(state.nodes['1.1.2']?.summary).toBe('spawn 1');
    expect(state.nodes['1.1.3']?.summary).toBe('spawn 2');
    expect(state.nodes['1.1.4']?.summary).toBe('task B');
  });

  it('renders spawn evidence followed by memory and keeps the carrier visible', () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(
      ctx,
      spawnCall('s1', [
        { summary: 'task A', prompt: 'p1' },
        { summary: 'task B', prompt: 'p2' },
      ]),
    );
    append(
      ctx,
      spawnReceipt('s1', [
        spawnResult(0, 'completed', 'mem A'),
        spawnResult(1, 'errored', 'mem B', 'disk full'),
      ]),
    );
    append(ctx, userMessage('after'));

    const folded = fold(ctx);
    const texts = folded.map(textOf);
    expect(texts).toContain('<spine_node id="1.1" summary="startup" status="live" />');
    expect(texts).toContain('[U1] start');
    expect(texts).toContain('calling spine_spawn');
    expect(texts).not.toContain('spine.spawn.result.v1');
    expect(texts).toContain('[U2] after');

    const evidenceA = texts.find((t) => t.includes('<spine_spawn_evidence node_id="1.1.1"'));
    const evidenceB = texts.find((t) => t.includes('<spine_spawn_evidence node_id="1.1.2"'));
    expect(evidenceA).toBe(
      '<spine_spawn_evidence node_id="1.1.1" summary="task A" outcome="completed" />',
    );
    expect(evidenceB).toBe(
      '<spine_spawn_evidence node_id="1.1.2" summary="task B" outcome="errored" diagnostic="disk full" />',
    );

    const memoryA = texts.find((t) => t.includes('<spine_memory node_id="1.1.1"'));
    const memoryB = texts.find((t) => t.includes('<spine_memory node_id="1.1.2"'));
    expect(memoryA).toBe('<spine_memory node_id="1.1.1">\nmem A\n</spine_memory>');
    expect(memoryB).toBe('<spine_memory node_id="1.1.2">\nmem B\n</spine_memory>');
  });

  it('spawns nodes under the current cursor, including nested open nodes', () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantToolCall('o1', 'spine_open', JSON.stringify({ summary: 'parent' })));
    append(ctx, spineAcceptedReceipt('o1'));
    append(
      ctx,
      spawnCall('s1', [
        { summary: 'child A', prompt: 'a' },
        { summary: 'child B', prompt: 'b' },
      ]),
    );
    append(
      ctx,
      spawnReceipt('s1', [
        spawnResult(0, 'completed', 'mem A'),
        spawnResult(1, 'completed', 'mem B'),
      ]),
    );

    const state = deriveSpineState(ctx.context.get());
    expect(state.openStack).toEqual(['1', '1.1', '1.1.1']);
    expect(state.nodes['1.1.1']?.children).toEqual(['1.1.1.1', '1.1.1.2']);
    expect(state.nodes['1.1.1.1']?.summary).toBe('child A');
    expect(state.nodes['1.1.1.2']?.summary).toBe('child B');
  });

  it('spawns nodes under the root epoch when the startup node is closed', () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(
      ctx,
      assistantToolCall('c1', 'spine_close', JSON.stringify({ memory: 'startup done' })),
    );
    append(ctx, spineAcceptedReceipt('c1'));
    append(
      ctx,
      spawnCall('s1', [
        { summary: 'branch A', prompt: 'a' },
        { summary: 'branch B', prompt: 'b' },
      ]),
    );
    append(
      ctx,
      spawnReceipt('s1', [
        spawnResult(0, 'completed', 'mem A'),
        spawnResult(1, 'completed', 'mem B'),
      ]),
    );

    const state = deriveSpineState(ctx.context.get());
    expect(state.openStack).toEqual(['1']);
    expect(state.nodes['1']?.children).toEqual(['1.1', '1.2', '1.3']);
    expect(state.nodes['1.2']?.summary).toBe('branch A');
    expect(state.nodes['1.3']?.summary).toBe('branch B');
    expect(state.nodes['1.2']?.closedAt).toBe(4);
    expect(state.nodes['1.3']?.closedAt).toBe(4);
  });
});

describe('Spine legacy-op restore compat', () => {
  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('derives the same tree after a persistence round-trip', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const ctx = testAgent(
      execEnvServices({ hostFs: recordingHostFs(new Map()) }),
      wireRecordPersistenceServices(persistence),
    );
    replaySession(ctx, [
      { kind: 'user', text: 'epoch-1 request' },
      { kind: 'spine_open', id: '1.1.1', summary: 'task A', parentId: '1.1' },
      { kind: 'assistant', text: 'A body' },
      { kind: 'spine_close', id: '1.1.1', memory: 'mem A' },
      { kind: 'root_compact', epoch: 2, summary: 'epoch summary' },
      { kind: 'user', text: 'epoch-2 request' },
      { kind: 'spine_open', id: '2.1.1', summary: 'task B', parentId: '2.1' },
      { kind: 'assistant', text: 'B body' },
      {
        kind: 'spine_next',
        closedId: '2.1.1',
        memory: 'mem B',
        openedId: '2.1.2',
        summary: 'task C',
      },
      { kind: 'assistant', text: 'C body' },
      { kind: 'spine_close', id: '2.1.2', memory: 'mem C' },
      { kind: 'user', text: 'tail' },
    ]);
    await ctx.wire.flush();

    const resumed = testAgent(
      execEnvServices({ hostFs: recordingHostFs(new Map()) }),
      wireRecordPersistenceServices(
        new InMemoryWireRecordPersistence(withMetadata(cloneRecords(persistence.records))),
      ),
    );
    await resumed.restorePersisted();

    expect(resumed.get(IAgentSpineService).currentState()).toEqual(
      ctx.get(IAgentSpineService).currentState(),
    );
  });
});

function recordingHostFs(writes: Map<string, string>) {
  return {
    writeText: async (path: string, data: string) => {
      writes.set(path, data);
    },
    mkdir: async () => {},
  };
}

function cloneRecords<T>(records: readonly T[]): T[] {
  return records.map((record) => structuredClone(record));
}

function withMetadata(records: readonly WireRecord[]): WireRecord[] {
  if (records[0]?.type === 'metadata') return [...records];
  return [
    { type: 'metadata', protocol_version: WIRE_PROTOCOL_VERSION, created_at: 1 },
    ...records,
  ];
}

function toolReceipt(toolCallId: string, text: string): ContextMessage {
  return {
    role: 'tool',
    content: [{ type: 'text', text }],
    toolCalls: [],
    toolCallId,
  };
}

function compactionSummaryTextMessage(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
}

function fold(ctx: TestAgentContext): readonly ContextMessage[] {
  return ctx.get(IAgentSpineService).fold(ctx.context.get()) as readonly ContextMessage[];
}

interface ClosedNodeIndices {
  readonly openCall: number;
  readonly closeResult: number;
  readonly after: number;
}

function buildClosedNodeHistory(ctx: TestAgentContext): ClosedNodeIndices {
  append(ctx, userMessage('start'));
  const openCall = append(
    ctx,
    assistantToolCall('c_open', 'spine_open', JSON.stringify({ summary: 'task A' })),
  );
  append(ctx, spineAcceptedReceipt('c_open'));
  append(ctx, assistantText('working'));
  append(ctx, assistantToolCall('c_close', 'spine_close', JSON.stringify({ memory: 'did A' })));
  const closeResult = append(ctx, spineAcceptedReceipt('c_close'));
  const after = append(ctx, userMessage('after'));
  return { openCall, closeResult, after };
}

interface NestedClosedIndices {
  readonly parentOpen: number;
  readonly childOpen: number;
  readonly childClose: number;
  readonly parentClose: number;
}

function buildNestedClosedHistory(ctx: TestAgentContext): NestedClosedIndices {
  append(ctx, userMessage('start'));
  const parentOpen = append(
    ctx,
    assistantToolCall('c_parent_open', 'spine_open', JSON.stringify({ summary: 'parent' })),
  );
  append(ctx, spineAcceptedReceipt('c_parent_open'));
  const childOpen = append(
    ctx,
    assistantToolCall('c_child_open', 'spine_open', JSON.stringify({ summary: 'child' })),
  );
  append(ctx, spineAcceptedReceipt('c_child_open'));
  append(ctx, assistantToolCall('c_child_close', 'spine_close', JSON.stringify({ memory: 'child mem' })));
  const childClose = append(ctx, spineAcceptedReceipt('c_child_close'));
  append(
    ctx,
    assistantToolCall('c_parent_close', 'spine_close', JSON.stringify({ memory: 'parent mem' })),
  );
  const parentClose = append(ctx, spineAcceptedReceipt('c_parent_close'));
  return { parentOpen, childOpen, childClose, parentClose };
}

async function configureLoop(ctx: TestAgentContext): Promise<void> {
  ctx.configure({
    provider: CATALOGUED_PROVIDER,
    modelCapabilities: CATALOGUED_MODEL_CAPABILITIES,
  });
  await ctx.rpc.setPermission({ mode: 'yolo' });
}

function append(ctx: TestAgentContext, message: ContextMessage): number {
  const index = ctx.context.get().length;
  ctx.context.append(message);
  return index;
}

function userMessage(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'user' },
  };
}

function assistantText(text: string): ContextMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
}

function assistantToolCall(id: string, name: string, args: string = '{}'): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: `calling ${name}` }],
    toolCalls: [{ type: 'function', id, name, arguments: args }],
  };
}

function toolResult(toolCallId: string): ContextMessage {
  return {
    role: 'tool',
    content: [{ type: 'text', text: `result of ${toolCallId}` }],
    toolCalls: [],
    toolCallId,
  };
}

function spineAcceptedReceipt(toolCallId: string): ContextMessage {
  return {
    role: 'tool',
    content: [{ type: 'text', text: ACCEPTED_OUTPUT }],
    toolCalls: [],
    toolCallId,
  };
}

function spineRejectedReceipt(toolCallId: string): ContextMessage {
  return {
    role: 'tool',
    content: [{ type: 'text', text: 'rejected: nope' }],
    toolCalls: [],
    toolCallId,
    isError: true,
  };
}

function spawnCall(
  id: string,
  tasks: readonly { summary: string; prompt: string }[],
): ContextMessage {
  return assistantToolCall(id, 'spine_spawn', JSON.stringify({ tasks }));
}

type SpawnOutcome = 'completed' | 'errored' | 'aborted';

interface SpawnResultInput {
  readonly ordinal: number;
  readonly outcome: SpawnOutcome;
  readonly memory_body: string;
  readonly diagnostic?: string;
}

function spawnReceipt(toolCallId: string, results: readonly SpawnResultInput[]): ContextMessage {
  return rawSpawnReceipt(toolCallId, { schema: 'spine.spawn.result.v1', results });
}

function rawSpawnReceipt(
  toolCallId: string,
  payload: Record<string, unknown>,
): ContextMessage {
  return {
    role: 'tool',
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    toolCalls: [],
    toolCallId,
  };
}

function spawnResult(
  ordinal: number,
  outcome: SpawnOutcome,
  memory_body: string,
  diagnostic?: string,
): SpawnResultInput {
  return diagnostic === undefined
    ? { ordinal, outcome, memory_body }
    : { ordinal, outcome, memory_body, diagnostic };
}

function buildNextChainHistory(ctx: TestAgentContext): void {
  append(ctx, userMessage('start'));
  append(ctx, assistantToolCall('o1', 'spine_open', JSON.stringify({ summary: 'task A' })));
  append(ctx, spineAcceptedReceipt('o1'));
  append(ctx, assistantToolCall('c1', 'spine_close', JSON.stringify({ memory: 'did A' })));
  append(ctx, spineAcceptedReceipt('c1'));
  append(ctx, assistantToolCall('o2', 'spine_open', JSON.stringify({ summary: 'task B' })));
  append(ctx, spineAcceptedReceipt('o2'));
  append(
    ctx,
    assistantToolCall('n1', 'spine_next', JSON.stringify({ summary: 'task C', memory: 'did B' })),
  );
  append(ctx, spineAcceptedReceipt('n1'));
  append(ctx, assistantToolCall('o3', 'spine_open', JSON.stringify({ summary: 'task D' })));
  append(ctx, spineRejectedReceipt('o3'));
  append(ctx, assistantToolCall('c2', 'spine_close', JSON.stringify({ memory: 'did C' })));
  append(ctx, spineRejectedReceipt('c2'));
}

function nodeView(
  id: string,
  summary: string,
  closed: boolean,
  children: readonly SpineTreeNodeView[] = [],
): SpineTreeNodeView {
  return { id, summary, closed, archivePath: undefined, tokenCost: undefined, children };
}

function flattenViewNodes(view: SpineTreeView): SpineTreeNodeView[] {
  const out: SpineTreeNodeView[] = [];
  const walk = (nodes: readonly SpineTreeNodeView[]): void => {
    for (const node of nodes) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(view.nodes);
  return out;
}

function findViewNode(view: SpineTreeView, id: string): SpineTreeNodeView | undefined {
  return flattenViewNodes(view).find((node) => node.id === id);
}

function toolCallPart(
  id: string,
  name: string,
  args: Record<string, unknown>,
): {
  readonly type: 'function';
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
} {
  return { type: 'function', id, name, arguments: JSON.stringify(args) };
}

function textOf(message: { content?: readonly { type: string; text?: string }[] } | undefined): string {
  return (
    message?.content?.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('') ?? ''
  );
}

function tranStatuses(ctx: TestAgentContext): string[] {
  return ctx.context
    .get()
    .map((message) => textOf(message))
    .filter((text) => text.includes('<spine_tran_status'));
}

type LogicalEvent =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'assistant'; readonly text: string }
  | { readonly kind: 'tool'; readonly id: string; readonly name: string }
  | {
      readonly kind: 'spine_open';
      readonly id: string;
      readonly summary: string;
      readonly parentId: string;
    }
  | { readonly kind: 'spine_close'; readonly id: string; readonly memory: string }
  | {
      readonly kind: 'spine_next';
      readonly closedId: string;
      readonly memory: string;
      readonly openedId: string;
      readonly summary: string;
    }
  | { readonly kind: 'root_compact'; readonly epoch: number; readonly summary: string };

function replaySession(ctx: TestAgentContext, events: readonly LogicalEvent[]): void {
  for (const event of events) {
    switch (event.kind) {
      case 'user':
        append(ctx, userMessage(event.text));
        break;
      case 'assistant':
        append(ctx, assistantText(event.text));
        break;
      case 'tool':
        append(ctx, assistantToolCall(event.id, event.name));
        append(ctx, toolResult(event.id));
        break;
      case 'spine_open': {
        const callId = `open_${event.id}`;
        append(
          ctx,
          assistantToolCall(callId, 'spine_open', JSON.stringify({ summary: event.summary })),
        );
        append(ctx, spineAcceptedReceipt(callId));
        break;
      }
      case 'spine_close': {
        const callId = `close_${event.id}`;
        append(
          ctx,
          assistantToolCall(callId, 'spine_close', JSON.stringify({ memory: event.memory })),
        );
        append(ctx, spineAcceptedReceipt(callId));
        break;
      }
      case 'spine_next': {
        const callId = `next_${event.closedId}`;
        append(
          ctx,
          assistantToolCall(
            callId,
            'spine_next',
            JSON.stringify({ summary: event.summary, memory: event.memory }),
          ),
        );
        append(ctx, spineAcceptedReceipt(callId));
        break;
      }
      case 'root_compact': {
        append(
          ctx,
          createCompactionSummaryMessage(buildCompactionSummaryText(event.summary)),
        );
        break;
      }
    }
  }
}


function canonicalProjection(folded: readonly ContextMessage[]): string[] {
  return folded.map((message) => {
    const variant = message.origin?.kind === 'injection' ? ` (${message.origin.variant})` : '';
    return `${message.role}${variant}: ${normalizeTokenGauges(textOf(message))}`;
  });
}

function normalizeTokenGauges(text: string): string {
  return text.replaceAll(
    /(cursor_context|context_left|raw_context|projected_context)="~?[\d.]+K?"/g,
    '$1="~N"',
  );
}

describe('Spine trim projection', () => {
  const TRIM_ENV = 'KIMI_CODE_SPINE_TRIM';

  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '1');
    vi.stubEnv(TRIM_ENV, '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('tags an oversized tool result with a byte-stable TRIM_ID prefix', () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantToolCall('c_big', 'Bash'));
    append(ctx, bigToolResult('c_big', oversized('BIG-BODY')));
    append(ctx, assistantToolCall('c_small', 'Read'));
    append(ctx, toolResult('c_small'));
    append(ctx, assistantText('done'));

    const folded = fold(ctx);
    expect(textOf(folded.find((m) => m.toolCallId === 'c_big'))).toBe(
      `[TRIM_ID: trim_1]\n${oversized('BIG-BODY')}`,
    );
    expect(textOf(folded.find((m) => m.toolCallId === 'c_small'))).not.toContain('TRIM_ID');
    expect(textOf(ctx.context.get().find((m) => m.toolCallId === 'c_big'))).toBe(
      oversized('BIG-BODY'),
    );
  });

  it('numbers tags in stream order across batches', () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantToolCall('c_a', 'Bash'));
    append(ctx, bigToolResult('c_a', oversized('A')));
    append(ctx, assistantToolCall('c_b', 'Bash'));
    append(ctx, bigToolResult('c_b', oversized('B')));

    const folded = fold(ctx);
    expect(textOf(folded.find((m) => m.toolCallId === 'c_a'))).toContain('[TRIM_ID: trim_1]');
    expect(textOf(folded.find((m) => m.toolCallId === 'c_b'))).toContain('[TRIM_ID: trim_2]');
  });

  it('renders a snipped result as the cleared placeholder and drops the label', () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantToolCall('c_big', 'Bash'));
    append(ctx, bigToolResult('c_big', oversized('BIG-BODY')));
    append(ctx, trimCall('t1', { TRIM_ID: 'trim_1', op: 'snip' }));
    append(ctx, trimAcceptedReceipt('t1'));
    append(ctx, assistantText('done'));

    const folded = fold(ctx);
    expect(textOf(folded.find((m) => m.toolCallId === 'c_big'))).toBe(
      SPINE_TRIM_SNIPPED_PLACEHOLDER,
    );
    expect(textOf(folded.find((m) => m.toolCallId === 't1'))).toBe(TRIM_ACCEPTED_OUTPUT);
  });

  it('renders head and tail slices by characters', () => {
    const ctx = testAgent();
    const body = `BEGIN-${'x'.repeat(SPINE_TRIM_THRESHOLD_BYTES)}-END`;
    append(ctx, userMessage('start'));
    append(
      ctx,
      assistantBatchToolCalls([
        { id: 'c_head', name: 'Bash' },
        { id: 'c_tail', name: 'Bash' },
      ]),
    );
    append(ctx, bigToolResult('c_head', body));
    append(ctx, bigToolResult('c_tail', body));
    append(
      ctx,
      assistantBatchToolCalls([
        {
          id: 't_head',
          name: 'spine_trim',
          args: JSON.stringify({ TRIM_ID: 'trim_1', op: 'slice', head: 6 }),
        },
        {
          id: 't_tail',
          name: 'spine_trim',
          args: JSON.stringify({ TRIM_ID: 'trim_2', op: 'slice', tail: 4 }),
        },
      ]),
    );
    append(ctx, trimAcceptedReceipt('t_head'));
    append(ctx, trimAcceptedReceipt('t_tail'));

    const folded = fold(ctx);
    expect(textOf(folded.find((m) => m.toolCallId === 'c_head'))).toBe('BEGIN-');
    expect(textOf(folded.find((m) => m.toolCallId === 'c_tail'))).toBe('-END');
  });

  it('renders an anchor slice as complete lines around the anchor line', () => {
    const ctx = testAgent();
    const noise = 'n'.repeat(SPINE_TRIM_THRESHOLD_BYTES);
    const body = `${noise}\nFAILED test X\nstack line\ntrailing noise`;
    append(ctx, userMessage('start'));
    append(ctx, assistantToolCall('c_big', 'Bash'));
    append(ctx, bigToolResult('c_big', body));
    append(
      ctx,
      trimCall('t1', { TRIM_ID: 'trim_1', op: 'slice', anchor: 'FAILED test X', following: 1 }),
    );
    append(ctx, trimAcceptedReceipt('t1'));

    const folded = fold(ctx);
    expect(textOf(folded.find((m) => m.toolCallId === 'c_big'))).toBe(
      'FAILED test X\nstack line',
    );
  });

  it('never tags spine control receipts or media results', () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantToolCall('c_tree', 'spine_tree'));
    append(ctx, bigToolResult('c_tree', oversized('TREE')));
    append(ctx, assistantToolCall('c_img', 'Read'));
    append(ctx, mediaToolResult('c_img', oversized('IMG')));

    const folded = fold(ctx);
    expect(textOf(folded.find((m) => m.toolCallId === 'c_tree'))).not.toContain('TRIM_ID');
    expect(textOf(folded.find((m) => m.toolCallId === 'c_img'))).not.toContain('TRIM_ID');
  });

  it('leaves the result tagged and whole when the trim receipt is an error', () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantToolCall('c_big', 'Bash'));
    append(ctx, bigToolResult('c_big', oversized('BIG-BODY')));
    append(ctx, trimCall('t1', { TRIM_ID: 'trim_1', op: 'snip' }));
    append(ctx, trimRejectedReceipt('t1'));

    const folded = fold(ctx);
    expect(textOf(folded.find((m) => m.toolCallId === 'c_big'))).toBe(
      `[TRIM_ID: trim_1]\n${oversized('BIG-BODY')}`,
    );
  });

  it('accepts a trim inside the window and rejects a repeat (one-shot)', () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantToolCall('c_big', 'Bash'));
    append(ctx, bigToolResult('c_big', oversized('BIG-BODY')));

    const spine = ctx.get(IAgentSpineService);
    expect(spine.acceptTrim('trim_1', { kind: 'snip' })).toEqual({ accepted: true });

    append(ctx, trimCall('t1', { TRIM_ID: 'trim_1', op: 'snip' }));
    append(ctx, trimAcceptedReceipt('t1'));

    const repeat = spine.acceptTrim('trim_1', { kind: 'snip' });
    expect(repeat.accepted).toBe(false);
    if (repeat.accepted) return;
    expect(repeat.reason).toContain('already trimmed');
    expect(repeat.reason).toContain('Do not retry');
  });

  it('expires ids once a newer batch completes, but not on interleaved assistant text', () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantToolCall('c_a', 'Bash'));
    append(ctx, bigToolResult('c_a', oversized('A')));
    append(ctx, assistantText('thinking out loud'));

    const spine = ctx.get(IAgentSpineService);
    expect(spine.acceptTrim('trim_1', { kind: 'snip' })).toEqual({ accepted: true });

    append(ctx, assistantToolCall('c_b', 'Bash'));
    append(ctx, bigToolResult('c_b', oversized('B')));

    const expired = spine.acceptTrim('trim_1', { kind: 'snip' });
    expect(expired.accepted).toBe(false);
    if (expired.accepted) return;
    expect(expired.reason).toContain('immediately preceding');
    expect(expired.reason).toContain('Do not retry');
  });

  it('rejects unknown ids and missing anchors with do-not-retry reasons', () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantToolCall('c_big', 'Bash'));
    append(ctx, bigToolResult('c_big', oversized('body with a NEEDLE inside')));

    const spine = ctx.get(IAgentSpineService);
    const unknown = spine.acceptTrim('trim_99', { kind: 'snip' });
    expect(unknown.accepted).toBe(false);
    if (unknown.accepted) return;
    expect(unknown.reason).toContain('Unknown TRIM_ID');
    expect(unknown.reason).toContain('Do not retry');

    const missing = spine.acceptTrim('trim_1', {
      kind: 'slice',
      shape: { type: 'anchor', anchor: 'NO_SUCH_TEXT', preceding: 0, following: 0 },
    });
    expect(missing.accepted).toBe(false);
    if (missing.accepted) return;
    expect(missing.reason).toContain('Anchor text not found');
    expect(missing.reason).toContain('Do not retry');

    expect(
      spine.acceptTrim('trim_1', {
        kind: 'slice',
        shape: { type: 'anchor', anchor: 'NEEDLE', preceding: 0, following: 0 },
      }),
    ).toEqual({ accepted: true });
  });

  it('normalizes flat trim arguments into ops', () => {
    expect(normalizeTrimOp('snip', {})).toEqual({ kind: 'snip' });
    expect(normalizeTrimOp('slice', { head: 5 })).toEqual({
      kind: 'slice',
      shape: { type: 'head', chars: 5 },
    });
    expect(normalizeTrimOp('slice', { tail: 5 })).toEqual({
      kind: 'slice',
      shape: { type: 'tail', chars: 5 },
    });
    expect(normalizeTrimOp('slice', { anchor: 'a', preceding: 1 })).toEqual({
      kind: 'slice',
      shape: { type: 'anchor', anchor: 'a', preceding: 1, following: 0 },
    });
    expect(normalizeTrimOp('slice', {})).toBeUndefined();
    expect(normalizeTrimOp('slice', { head: 5, tail: 5 })).toBeUndefined();
  });
});

describe('Spine trim standalone (spine flag off)', () => {
  const TRIM_ENV = 'KIMI_CODE_SPINE_TRIM';

  beforeEach(() => {
    vi.stubEnv(MASTER_ENV, '0');
    vi.stubEnv(SPINE_ENV, '0');
    vi.stubEnv(TRIM_ENV, '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders the trim projection over the plain history (no tree fold, no status)', () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantToolCall('c_big', 'Bash'));
    append(ctx, bigToolResult('c_big', oversized('BIG-BODY')));
    append(ctx, assistantText('done'));

    const folded = fold(ctx);
    expect(folded).toHaveLength(4);
    expect(textOf(folded.find((m) => m.toolCallId === 'c_big'))).toBe(
      `[TRIM_ID: trim_1]\n${oversized('BIG-BODY')}`,
    );
    expect(folded.some((m) => textOf(m).includes('<spine_node'))).toBe(false);
    expect(folded.some((m) => textOf(m).includes('<spine_memory'))).toBe(false);
    expect(folded.some((m) => textOf(m).includes('<spine_tran_status'))).toBe(false);
  });

  it('validates and renders trims with spine off', () => {
    const ctx = testAgent();
    append(ctx, userMessage('start'));
    append(ctx, assistantToolCall('c_big', 'Bash'));
    append(ctx, bigToolResult('c_big', oversized('BIG-BODY')));

    const spine = ctx.get(IAgentSpineService);
    expect(spine.acceptTrim('trim_1', { kind: 'snip' })).toEqual({ accepted: true });

    append(ctx, trimCall('t1', { TRIM_ID: 'trim_1', op: 'snip' }));
    append(ctx, trimAcceptedReceipt('t1'));

    expect(textOf(fold(ctx).find((m) => m.toolCallId === 'c_big'))).toBe(
      SPINE_TRIM_SNIPPED_PLACEHOLDER,
    );
  });

  it('executes spine_trim end to end with spine off', async () => {
    const ctx = testAgent();
    append(ctx, userMessage('seed'));
    append(ctx, assistantToolCall('c_big', 'Bash'));
    append(ctx, bigToolResult('c_big', oversized('BIG-BODY')));
    await configureLoop(ctx);
    ctx.mockNextResponse(toolCallPart('t1', 'spine_trim', { TRIM_ID: 'trim_1', op: 'snip' }));
    ctx.mockNextResponse({ type: 'text', text: 'trimmed' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'go' }] });
    await ctx.untilTurnEnd();

    const receipt = ctx.context.get().find((m) => m.toolCallId === 't1');
    expect(receipt?.isError).not.toBe(true);
    expect(textOf(receipt)).toBe(TRIM_ACCEPTED_OUTPUT);
    expect(textOf(fold(ctx).find((m) => m.toolCallId === 'c_big'))).toBe(
      SPINE_TRIM_SNIPPED_PLACEHOLDER,
    );
  });
});

function bigToolResult(toolCallId: string, text: string): ContextMessage {
  return {
    role: 'tool',
    content: [{ type: 'text', text }],
    toolCalls: [],
    toolCallId,
  };
}

function mediaToolResult(toolCallId: string, text: string): ContextMessage {
  return {
    role: 'tool',
    content: [
      { type: 'image_url', imageUrl: { url: 'https://example.com/pixel.png' } },
      { type: 'text', text },
    ],
    toolCalls: [],
    toolCallId,
  };
}

function assistantBatchToolCalls(
  calls: readonly { id: string; name: string; args?: string }[],
): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'batch' }],
    toolCalls: calls.map((call) => ({
      type: 'function' as const,
      id: call.id,
      name: call.name,
      arguments: call.args ?? '{}',
    })),
  };
}

function trimCall(id: string, args: Record<string, unknown>): ContextMessage {
  return assistantToolCall(id, 'spine_trim', JSON.stringify(args));
}

function trimAcceptedReceipt(toolCallId: string): ContextMessage {
  return {
    role: 'tool',
    content: [{ type: 'text', text: TRIM_ACCEPTED_OUTPUT }],
    toolCalls: [],
    toolCallId,
  };
}

function trimRejectedReceipt(toolCallId: string): ContextMessage {
  return {
    role: 'tool',
    content: [{ type: 'text', text: 'rejected: do not retry' }],
    toolCalls: [],
    toolCallId,
    isError: true,
  };
}

function oversized(body: string): string {
  return body + 'x'.repeat(SPINE_TRIM_THRESHOLD_BYTES);
}
