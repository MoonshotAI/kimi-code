import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { Jimp } from 'jimp';

import type { ToolCall } from '#human/llm/message';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, TestInstantiationService } from '#/_base/di/test';
import {
  ToolAccesses,
  type ExecutableTool,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
  type ToolResult,
  type ToolUpdate,
} from '#/tool/toolContract';
import { ToolOutputAccumulator } from '#/tool/output-accumulator';
import { createMcpTool } from '#/agent/mcp/tools/mcp';
import type { MCPClient } from '#/mcpCore/types';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeToolExecuteEvent,
  ToolExecutionOutcome,
} from '#/agent/toolExecutor/toolHooks';
import {
  ToolCallStarted,
  ToolProgress,
  ToolResultEvent,
} from '#/agent/toolExecutor/toolExecutorEvents';
import { AgentToolExecutorService } from '#/agent/toolExecutor/toolExecutorService';
import { parseToolCallArguments } from '#/tool/tool-args-parse';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { ToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncationService';
import { ReadTool } from '#/agent/tools/os/read/readTool';
import { ReadMediaFileTool } from '#/agent/tools/read-media-file/readMediaFileTool';
import { SessionMediaStoreService } from '#/agent/media/sessionMediaStoreService';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { makeSessionContext } from '#/session/sessionContext/sessionContext';
import { GlobTool } from '#/agent/tools/os/glob/globTool';
import { ReadInputSchema, type ReadInput } from '#/agent/tools/os/read/read';
import { renderToolResultForModel } from '#/agent/contextMemory/toolResultRender';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { stubWorkspaceContext } from '../../session/workspaceContext/stub-workspace-context';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { ILogService } from '#/_base/log/log';
import { makeAgentScopeContext, IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IEventBus } from '#/app/event/eventBus';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { registerLogServices, stubLog } from '../../_base/log/stubs';
import { stubBootstrap } from '../../app/bootstrap/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { registerStateServices } from '../../state/stubs';
import { registerTestAgentWireServices } from '../../wire/stubs';

type ToolExecutorEvent =
  | { readonly type: 'tool.result'; readonly toolCallId: string; readonly result: ToolResult };

type ProtocolEvent = ToolCallStarted | ToolProgress | ToolResultEvent;

let disposables: DisposableStore;
let ix: TestInstantiationService;
let executor: IAgentToolExecutorService;
let registry: IAgentToolRegistryService;
let events: ToolExecutorEvent[];
let protocolEvents: ProtocolEvent[];
let telemetryEvents: TelemetryRecord[];
let truncateForModel: IAgentToolResultTruncationService['truncateForModel'];

beforeEach(() => {
  disposables = new DisposableStore();
  events = [];
  protocolEvents = [];
  telemetryEvents = [];
  truncateForModel = async (input) => input.result;
  ix = createServices(disposables, {
    additionalServices: (reg) => {
      registerStateServices(reg);
      registerTestAgentWireServices(reg, 'wire/tool-executor');
      reg.define(IAgentToolRegistryService, AgentToolRegistryService);
      reg.define(IAgentToolExecutorService, AgentToolExecutorService);
      reg.defineInstance(IAgentScopeContext, makeAgentScopeContext({ agentId: 'main', agentScope: '' }));
      reg.defineInstance(ITelemetryService, recordingTelemetry(telemetryEvents));
      reg.defineInstance(IAgentToolResultTruncationService, {
        _serviceBrand: undefined,
        truncateForModel: (input) => truncateForModel(input),
        isSpillFilePath: () => false,
        isWireJournalPath: () => false,
      });
      reg.defineInstance(IEventBus, {
        publish: (event: ProtocolEvent) => {
          if (event.type.startsWith('tool.')) {
            protocolEvents.push(event);
          }
        },
        subscribe: (..._args: unknown[]) => ({ dispose: () => {} }),
      } as unknown as IEventBus);
      registerLogServices(reg);
    },
    strict: true,
  });
  executor = ix.get(IAgentToolExecutorService);
  registry = ix.get(IAgentToolRegistryService);
});

afterEach(() => {
  disposables.dispose();
});

describe('AgentToolExecutorService', () => {
  it('resolves by interface and routes a successful tool call through execute', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);

    const results = await execute([toolCall('call_echo', 'echo', { text: 'hi' })]);

    expect(results).toEqual([
      expect.objectContaining({
        output: 'hi',
        stopTurn: false,
      }),
    ]);
    expect(tool.calls).toEqual([
      expect.objectContaining({
        toolCallId: 'call_echo',
        turnId: 0,
        args: { text: 'hi' },
      }),
    ]);
    expect(eventTypes()).toEqual(['tool.result']);
    expect(protocolEventTypes()).toEqual(['tool.call.started', 'tool.result']);
    expect(telemetryEvents).toContainEqual({
      event: 'tool_call',
      properties: expect.objectContaining({
        turn_id: 0,
        tool_call_id: 'call_echo',
        tool_name: 'echo',
        outcome: 'success',
        duration_ms: expect.any(Number),
      }),
    });
  });

  it('rejects by policy before dynamic availability when a tool-call guard denies it', async () => {
    const tool = new TestTool('blocked');
    registry.register(tool, { source: 'mcp' });
    executor.registerUnavailableToolDescriber(() => 'Tool "blocked" is not loaded');
    executor.registerToolCallGuard(({ name, source }) =>
      name === 'blocked' && source === 'mcp' ? 'Tool "blocked" is disabled' : undefined,
    );

    const results = await execute([toolCall('call_blocked', 'blocked', {})]);

    expect(results).toEqual([
      expect.objectContaining({
        isError: true,
        output: 'Tool "blocked" is disabled',
      }),
    ]);
    expect(tool.calls).toEqual([]);
  });

  it('tags tool_call telemetry with recorded dup types, defaulting to normal', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    let tag = true;
    executor.onBeforeExecuteTool((event) => {
      if (tag && event.toolCall.id === 'call_dup') executor.recordDupType('call_dup', 'cross_step');
    });

    await execute([
      toolCall('call_ok', 'echo', { text: 'a' }),
      toolCall('call_dup', 'echo', { text: 'b' }),
    ]);

    expect(telemetryEvents).toContainEqual({
      event: 'tool_call',
      properties: expect.objectContaining({ tool_call_id: 'call_ok', dup_type: 'normal' }),
    });
    expect(telemetryEvents).toContainEqual({
      event: 'tool_call',
      properties: expect.objectContaining({ tool_call_id: 'call_dup', dup_type: 'cross_step' }),
    });

    tag = false;
    await execute([toolCall('call_dup', 'echo', { text: 'c' })]);
    expect(telemetryEvents).toContainEqual({
      event: 'tool_call',
      properties: expect.objectContaining({ tool_call_id: 'call_dup', dup_type: 'normal' }),
    });
  });

  it('merges the request trace id into tool_call telemetry', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);

    await execute(
      [toolCall('call_traced', 'echo', { text: 'hi' })],
      undefined,
      { traceId: 'trace-tool-1' },
    );

    expect(telemetryEvents).toContainEqual({
      event: 'tool_call',
      properties: expect.objectContaining({
        tool_call_id: 'call_traced',
        trace_id: 'trace-tool-1',
      }),
    });
  });

  it('truncates final tool results before publishing protocol events', async () => {
    truncateForModel = async (input) => ({
      ...input.result,
      output: 'truncated output',
      truncated: true,
    });
    const tool = new TestTool('large', { result: { output: 'raw output' } });
    registry.register(tool);

    const results = await execute([toolCall('call_large', 'large', {})]);

    expect(results[0]).toMatchObject({
      output: 'truncated output',
      truncated: true,
    });
    expect(protocolEvents).toContainEqual(
      expect.objectContaining({
        type: 'tool.result',
        toolCallId: 'call_large',
        output: 'truncated output',
      }),
    );
  });

  it('preserves internal result notes without exposing them on protocol tool.result events', async () => {
    const tool = new TestTool('captioned', {
      result: {
        output: 'image sent',
        note: '<system>Image compressed.</system>',
      },
    });
    registry.register(tool);

    const results = await execute([toolCall('call_captioned', 'captioned', {})]);

    expect(results[0]).toMatchObject({
      output: 'image sent',
      note: '<system>Image compressed.</system>',
    });
    const protocolResult = protocolEvents.find(
      (event): event is ToolResultEvent => event.type === 'tool.result',
    );
    expect(protocolResult).toMatchObject({
      type: 'tool.result',
      toolCallId: 'call_captioned',
      output: 'image sent',
    });
    expect(protocolResult as unknown as Record<string, unknown>).not.toHaveProperty('note');
  });

  it('drops malformed notes and non-true truncated flags from internal results', async () => {
    const tool = new TestTool('malformed-meta', {
      result: {
        output: 'image sent',
        note: 123,
        truncated: false,
      } as unknown as ExecutableToolResult,
    });
    registry.register(tool);

    const results = await execute([toolCall('call_malformed_meta', 'malformed-meta', {})]);

    expect(results[0]).toMatchObject({ output: 'image sent' });
    expect(results[0] as unknown as Record<string, unknown>).not.toHaveProperty('note');
    expect(results[0] as unknown as Record<string, unknown>).not.toHaveProperty('truncated');
  });

  it('records an error tool.result when the tool name is unknown', async () => {
    const results = await execute([toolCall('call_missing', 'missing', { text: 'hi' })]);

    expect(results).toEqual([
      expect.objectContaining({
        output: 'Tool "missing" not found',
        isError: true,
      }),
    ]);
    expect(pairedToolCallIds()).toEqual({
      calls: ['call_missing'],
      results: ['call_missing'],
    });
    expect(telemetryEvents).toContainEqual({
      event: 'tool_call',
      properties: expect.objectContaining({
        turn_id: 0,
        tool_call_id: 'call_missing',
        tool_name: 'missing',
        outcome: 'error',
        duration_ms: expect.any(Number),
        error_type: 'error',
      }),
    });
  });

  it('records an error tool.result when args fail tool parameter validation', async () => {
    const tool = new TestTool('strict', {
      parameters: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
        additionalProperties: false,
      },
    });
    registry.register(tool);

    const results = await execute([toolCall('call_strict', 'strict', { value: 'bad' })]);

    expect(results).toEqual([
      expect.objectContaining({
        output: expect.stringContaining('Invalid args for tool "strict"'),
        isError: true,
      }),
    ]);
    expect(tool.calls).toEqual([]);
    expect(pairedToolCallIds()).toEqual({
      calls: ['call_strict'],
      results: ['call_strict'],
    });
  });

  it('recompiles the cached args validator when a tool advertises a different schema object', async () => {
    const inner = new TestTool('dynamic');
    let currentSchema: Record<string, unknown> = {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
      additionalProperties: false,
    };
    const tool: ExecutableTool<Record<string, unknown>> = {
      name: inner.name,
      description: inner.description,
      get parameters() {
        return currentSchema;
      },
      resolveExecution: (args) => inner.resolveExecution(args),
    };
    registry.register(tool);

    const rejected = await execute([
      toolCall('call_strict', 'dynamic', { value: 1, model: 'fast' }),
    ]);

    expect(rejected).toEqual([
      expect.objectContaining({
        output: expect.stringContaining('Invalid args for tool "dynamic"'),
        isError: true,
      }),
    ]);
    expect(inner.calls).toEqual([]);

    currentSchema = {
      type: 'object',
      properties: { value: { type: 'number' }, model: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    };
    const accepted = await execute([
      toolCall('call_open', 'dynamic', { value: 1, model: 'fast' }),
    ]);

    expect(accepted).toEqual([expect.objectContaining({ stopTurn: false })]);
    expect(inner.calls).toHaveLength(1);
    expect(inner.calls[0]?.args).toEqual({ value: 1, model: 'fast' });
  });

  it('routes malformed JSON args through schema validation', async () => {
    const tool = new TestTool('strict', {
      parameters: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
        additionalProperties: false,
      },
    });
    registry.register(tool);

    const results = await execute([
      {
        type: 'function',
        id: 'call_malformed',
        name: 'strict',
        arguments: '{not valid json',
      },
    ]);

    expect(results).toEqual([
      expect.objectContaining({
        output: expect.stringContaining('Invalid args for tool "strict"'),
        isError: true,
      }),
    ]);
    expect(tool.calls).toEqual([]);
    expect(pairedToolCallIds()).toEqual({
      calls: ['call_malformed'],
      results: ['call_malformed'],
    });
  });

  it('does not repair malformed tool args JSON with a trailing comma', async () => {
    const tool = new TestTool('strict', {
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    });
    registry.register(tool);

    const results = await execute([
      {
        type: 'function',
        id: 'call_trailing_comma',
        name: 'strict',
        arguments: '{"text":"hi",}',
      },
    ]);

    expect(tool.calls).toEqual([]);
    expect(results).toEqual([
      expect.objectContaining({
        output: expect.stringContaining('Invalid args for tool "strict"'),
        isError: true,
      }),
    ]);
    expect(pairedToolCallIds()).toEqual({
      calls: ['call_trailing_comma'],
      results: ['call_trailing_comma'],
    });
  });

  it('preserves an unknown tool\'s valid args in the tool.call.started event', async () => {
    const results = await execute([toolCall('call_unknown', 'missing', { x: 1 })]);

    expect(results).toEqual([
      expect.objectContaining({
        output: 'Tool "missing" not found',
        isError: true,
      }),
    ]);
    const toolCallEvent = protocolEvents.find(
      (event): event is ToolCallStarted => event.type === 'tool.call.started',
    );
    expect(toolCallEvent?.args).toEqual({ x: 1 });
  });

  it('onBeforeExecuteTool veto with an error result does not invoke execute', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    executor.onBeforeExecuteTool((event) => {
      event.veto({ output: 'forbidden', isError: true });
    });

    const results = await execute([toolCall('call_echo', 'echo', { text: 'hi' })]);

    expect(results).toEqual([
      expect.objectContaining({
        output: 'forbidden',
        isError: true,
      }),
    ]);
    expect(tool.calls).toEqual([]);
  });

  it('onBeforeExecuteTool veto with a plain result bypasses execute', async () => {
    const first = new TestTool('first');
    const second = new TestTool('second');
    registry.register(first);
    registry.register(second);
    executor.onBeforeExecuteTool((event) => {
      if (event.toolCall.id !== 'call_first') return;
      event.veto({ output: 'synthetic' });
    });

    const results = await execute([
      toolCall('call_first', 'first', {}),
      toolCall('call_second', 'second', {}),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ output: 'synthetic' }),
      expect.objectContaining({ output: 'second result' }),
    ]);
    expect(first.calls).toEqual([]);
    expect(second.calls).toHaveLength(1);
  });

  it('skips later tool calls after an execution requests stopBatchAfterThis', async () => {
    const first = new TestTool('first', { stopBatchAfterThis: true });
    const second = new TestTool('second');
    registry.register(first);
    registry.register(second);

    const results = await execute([
      toolCall('call_first', 'first', {}),
      toolCall('call_second', 'second', {}),
    ]);

    expect(results).toHaveLength(2);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ output: 'first result', stopBatchAfterThis: true }),
      expect.objectContaining({
        output: 'Tool skipped because a previous tool call stopped the turn.',
        isError: true,
      }),
    ]));
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toEqual([]);
  });

  it('yields independent tool results as each call finishes', async () => {
    const slowRelease = deferred();
    const fastRelease = deferred();
    const slowStarted = deferred();
    const fastStarted = deferred();
    const firstYielded = deferred();
    const slow = new TestTool('slow', {
      accesses: ToolAccesses.readFile('/repo/slow.txt'),
      execute: async () => {
        slowStarted.resolve();
        await slowRelease.promise;
        return { output: 'slow' };
      },
    });
    const fast = new TestTool('fast', {
      accesses: ToolAccesses.readFile('/repo/fast.txt'),
      execute: async () => {
        fastStarted.resolve();
        await fastRelease.promise;
        return { output: 'fast' };
      },
    });
    registry.register(slow);
    registry.register(fast);

    const yielded: string[] = [];
    const execution = (async () => {
      for await (const item of executor.execute(
        [
          toolCall('call_slow', 'slow', {}),
          toolCall('call_fast', 'fast', {}),
        ],
        { turnId: 0, signal: new AbortController().signal },
      )) {
        const output = item.result.output;
        yielded.push(typeof output === 'string' ? output : JSON.stringify(output));
        if (yielded.length === 1) firstYielded.resolve();
      }
    })();

    await Promise.all([slowStarted.promise, fastStarted.promise]);
    fastRelease.resolve();
    await firstYielded.promise;

    expect(yielded).toEqual(['fast']);

    slowRelease.resolve();
    await execution;

    expect(yielded).toEqual(['fast', 'slow']);
  });

  it('writes resolveExecution description and display onto tool.call.started events', async () => {
    const tool = new TestTool('display', {
      description: 'Prepared display description',
      display: {
        kind: 'generic',
        summary: 'Display summary',
        detail: { value: 1 },
      },
    });
    registry.register(tool);

    await execute([toolCall('call_display', 'display', {})]);

    expect(protocolEvents.find((event) => event.type === 'tool.call.started')).toMatchObject({
      type: 'tool.call.started',
      description: 'Prepared display description',
      display: {
        kind: 'generic',
        summary: 'Display summary',
        detail: { value: 1 },
      },
    });
  });

  it('captures tool execution failures as error results', async () => {
    const tool = new TestTool('fail', {
      execute: async () => {
        throw new Error('tool blew up');
      },
    });
    registry.register(tool);

    const results = await execute([toolCall('call_fail', 'fail', {})]);

    expect(results).toEqual([
      expect.objectContaining({
        output: 'Tool "fail" failed: tool blew up',
        isError: true,
      }),
    ]);
  });

  it('coerces an undefined tool return into an error result without breaking pairing', async () => {
    const tool = new TestTool('corrupt', {
      execute: async () => undefined as unknown as ExecutableToolResult,
    });
    registry.register(tool);

    const results = await execute([toolCall('call_corrupt', 'corrupt', {})]);

    expect(results).toEqual([
      expect.objectContaining({
        output: 'Tool "corrupt" returned no result.',
        isError: true,
      }),
    ]);
    expect(pairedToolCallIds()).toEqual({
      calls: ['call_corrupt'],
      results: ['call_corrupt'],
    });
  });

  it('forwards onUpdate calls as tool.progress events', async () => {
    const updates: ToolUpdate[] = [
      { kind: 'stdout', text: 'working' },
      { kind: 'progress', percent: 50 },
    ];
    const tool = new TestTool('progress', {
      execute: async (ctx) => {
        for (const update of updates) ctx.onUpdate?.(update);
        return { output: 'done' };
      },
    });
    registry.register(tool);

    await execute([toolCall('call_progress', 'progress', {})]);

    expect(protocolEvents.filter((event) => event.type === 'tool.progress')).toEqual([
      expect.objectContaining({
        type: 'tool.progress',
        turnId: 0,
        toolCallId: 'call_progress',
        update: updates[0],
      }),
      expect.objectContaining({
        type: 'tool.progress',
        turnId: 0,
        toolCallId: 'call_progress',
        update: updates[1],
      }),
    ]);
  });

  it('does not start a queued conflicting tool after abort', async () => {
    const controller = new AbortController();
    const first = new ControlledTool('first', ToolAccesses.writeFile('/repo/a.ts'));
    const second = new ControlledTool('second', ToolAccesses.writeFile('/repo/a.ts'));
    const outcomes = new Map<string, ToolExecutionOutcome>();
    registry.register(first);
    registry.register(second);
    executor.hooks.onDidExecuteTool.register('capture-outcomes', async (ctx, next) => {
      outcomes.set(ctx.toolCall.id, ctx.outcome);
      await next();
    });

    const execution = execute(
      [toolCall('call_first', 'first', {}), toolCall('call_second', 'second', {})],
      controller.signal,
    );
    await first.started;
    controller.abort();
    const results = await execution;

    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(0);
    expect(outcomes).toEqual(
      new Map([
        ['call_first', 'executed'],
        ['call_second', 'aborted'],
      ]),
    );
    expect(results).toEqual([
      expect.objectContaining({ output: 'Tool "first" was aborted', isError: true }),
      expect.objectContaining({ output: 'Tool "second" was aborted', isError: true }),
    ]);
  });

  it('every tool.call.started still has a matching tool.result when aborted mid-batch', async () => {
    const controller = new AbortController();
    const first = new ControlledTool('first', ToolAccesses.writeFile('/repo/a.ts'));
    const second = new ControlledTool('second', ToolAccesses.writeFile('/repo/a.ts'));
    const third = new TestTool('third', { accesses: ToolAccesses.readFile('/repo/b.ts') });
    registry.register(first);
    registry.register(second);
    registry.register(third);

    const execution = execute(
      [
        toolCall('call_first', 'first', {}),
        toolCall('call_second', 'second', {}),
        toolCall('call_third', 'third', {}),
      ],
      controller.signal,
    );
    await first.started;
    controller.abort();
    await execution;

    const paired = pairedToolCallIds();
    expect(paired.calls).toEqual(['call_first', 'call_second', 'call_third']);
    expect(paired.results).toHaveLength(3);
    expect(paired.results).toEqual(
      expect.arrayContaining(['call_first', 'call_second', 'call_third']),
    );
  });

  it('preserves media-only image output with a text companion', async () => {
    const tool = new TestTool('image', {
      result: {
        output: [{ type: 'image_url', imageUrl: { url: 'ms://image-1', id: 'image-1' } }],
      },
    });
    registry.register(tool);

    const results = await execute([toolCall('call_image', 'image', {})]);

    expect(results).toEqual([
      expect.objectContaining({
        output: [
          { type: 'text', text: 'Tool returned non-text content.' },
          { type: 'image_url', imageUrl: { url: 'ms://image-1', id: 'image-1' } },
        ],
      }),
    ]);
  });

  it('onDidExecuteTool failures replace the raw output with a hook error', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    executor.hooks.onDidExecuteTool.register('fail-finalize', async () => {
      throw new Error('finalize crashed');
    });

    const results = await execute([toolCall('call_echo', 'echo', { text: 'raw output' })]);

    expect(results).toEqual([
      expect.objectContaining({
        output: 'onDidExecuteTool hook failed for "echo": finalize crashed',
        isError: true,
      }),
    ]);
    const toolResultEvents = events.filter((event) => event.type === 'tool.result');
    expect(JSON.stringify(toolResultEvents)).not.toContain('raw output');
  });

  it('onDidExecuteTool can stop the turn without marking the tool failed', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    executor.hooks.onDidExecuteTool.register('stop', async (ctx) => {
      ctx.stopTurn = true;
    });

    const results = await execute([toolCall('call_echo', 'echo', { text: 'done' })]);

    expect(results).toEqual([
      expect.objectContaining({
        output: 'done',
        stopTurn: true,
      }),
    ]);
  });

  it('onDidExecuteTool can replace the final tool result', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    executor.hooks.onDidExecuteTool.register('replace-result', async (ctx) => {
      ctx.result = { output: 'hook output', isError: true };
    });

    const results = await execute([toolCall('call_echo', 'echo', { text: 'raw output' })]);

    expect(results).toEqual([
      expect.objectContaining({
        output: 'hook output',
        isError: true,
      }),
    ]);
    expect(events).toContainEqual({
      type: 'tool.result',
      toolCallId: 'call_echo',
      result: expect.objectContaining({
        output: 'hook output',
        isError: true,
      }),
    });
  });
  it('threads a declared delivery onto the yielded result for the agent layer to consume', async () => {
    const message = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'injected' }],
      toolCalls: [],
      origin: { kind: 'skill_activation', skillName: 'commit', trigger: 'model-tool' },
    };
    const tool = new TestTool('skillish', {
      result: { output: 'ack', delivery: { kind: 'steer', message } },
    });
    registry.register(tool);

    const results = await execute([toolCall('call_skillish', 'skillish', {})]);

    expect(results).toHaveLength(1);
    expect(results[0]!.output).toBe('ack');
    expect(results[0]!.delivery).toMatchObject({
      kind: 'steer',
      message: { content: [{ type: 'text', text: 'injected' }] },
    });
  });
});

describe('onBeforeExecuteTool veto semantics', () => {
  it('applies the first veto and does not run later listeners', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    const later = vi.fn();
    executor.onBeforeExecuteTool((event) => {
      event.veto({ output: 'first', isError: true });
    });
    executor.onBeforeExecuteTool((event) => {
      later();
      event.veto({ output: 'second', isError: true });
    });

    const results = await execute([toolCall('call_echo', 'echo', { text: 'hi' })]);

    expect(results).toEqual([expect.objectContaining({ output: 'first', isError: true })]);
    expect(later).not.toHaveBeenCalled();
    expect(tool.calls).toEqual([]);
  });

  it('lets an allow end adjudication before later listeners run', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    const later = vi.fn();
    executor.onBeforeExecuteTool((event) => {
      event.allow();
    });
    executor.onBeforeExecuteTool((event) => {
      later();
      event.veto({ output: 'denied', isError: true });
    });

    const results = await execute([toolCall('call_echo', 'echo', { text: 'hi' })]);

    expect(results).toEqual([expect.objectContaining({ output: 'hi' })]);
    expect(later).not.toHaveBeenCalled();
    expect(tool.calls).toHaveLength(1);
  });

  it('threads pass metadata into the execution context', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    const metadata = { marker: true };
    executor.onBeforeExecuteTool((event) => {
      event.pass(metadata);
    });

    await execute([toolCall('call_echo', 'echo', { text: 'hi' })]);

    expect(tool.calls[0]).toEqual(expect.objectContaining({ metadata }));
  });

  it('never invokes waitUntil factories when an immediate veto decides the call', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    const askFactory = vi.fn(async () => undefined);
    executor.onBeforeExecuteTool((event) => {
      event.waitUntil(askFactory);
    });
    executor.onBeforeExecuteTool((event) => {
      event.veto({ output: 'disabled', isError: true });
    });

    const results = await execute([toolCall('call_echo', 'echo', { text: 'hi' })]);

    expect(results).toEqual([expect.objectContaining({ output: 'disabled', isError: true })]);
    expect(askFactory).not.toHaveBeenCalled();
    expect(tool.calls).toEqual([]);
  });

  it('fulfills waitUntil factories in registration order when no listener decides immediately', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    const fulfilled: string[] = [];
    executor.onBeforeExecuteTool((event) => {
      event.waitUntil(async () => {
        fulfilled.push('first');
        return undefined;
      });
    });
    executor.onBeforeExecuteTool((event) => {
      event.waitUntil(async () => {
        fulfilled.push('second');
        return { veto: { output: 'second-denied', isError: true } };
      });
    });
    executor.onBeforeExecuteTool((event) => {
      event.waitUntil(async () => {
        fulfilled.push('third');
        return undefined;
      });
    });

    const results = await execute([toolCall('call_echo', 'echo', { text: 'hi' })]);

    expect(fulfilled).toEqual(['first', 'second']);
    expect(results).toEqual([
      expect.objectContaining({ output: 'second-denied', isError: true }),
    ]);
    expect(tool.calls).toEqual([]);
  });

  it('lets a call through when every waitUntil factory returns undefined', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    executor.onBeforeExecuteTool((event) => {
      event.waitUntil(async () => undefined);
    });

    const results = await execute([toolCall('call_echo', 'echo', { text: 'hi' })]);

    expect(results).toEqual([expect.objectContaining({ output: 'hi' })]);
    expect(tool.calls).toHaveLength(1);
  });

  it('throws when a statement is made after the statement window closed', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    let captured: BeforeToolExecuteEvent | undefined;
    executor.onBeforeExecuteTool((event) => {
      captured = event;
    });

    await execute([toolCall('call_echo', 'echo', { text: 'hi' })]);

    expect(captured).toBeDefined();
    const closed = captured!;
    expect(() => closed.waitUntil(async () => undefined)).toThrow(
      'waitUntil can NOT be called asynchronously',
    );
    expect(() => closed.veto({ output: 'x', isError: true })).toThrow(
      'veto can NOT be called asynchronously',
    );
  });
});

describe('onWillExecuteTool', () => {
  it('awaits registered waitUntil work before executing the tool', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    const gate = deferred<void>();
    executor.onWillExecuteTool((event) => {
      event.waitUntil(gate.promise);
    });

    const pending = execute([toolCall('call_echo', 'echo', { text: 'hi' })]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tool.calls).toEqual([]);

    gate.resolve();
    const results = await pending;
    expect(results).toEqual([expect.objectContaining({ output: 'hi' })]);
    expect(tool.calls).toHaveLength(1);
  });

  it('does not fire for a vetoed call', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    const willListener = vi.fn();
    executor.onWillExecuteTool(willListener);
    executor.onBeforeExecuteTool((event) => {
      event.veto({ output: 'nope', isError: true });
    });

    const results = await execute([toolCall('call_echo', 'echo', { text: 'hi' })]);

    expect(results).toEqual([expect.objectContaining({ output: 'nope', isError: true })]);
    expect(willListener).not.toHaveBeenCalled();
  });
});

describe('parseToolCallArguments', () => {
  it('treats null or empty arguments as an empty object', () => {
    expect(parseToolCallArguments(null)).toEqual({ data: {}, parseFailed: false });
    expect(parseToolCallArguments('')).toEqual({ data: {}, parseFailed: false });
  });

  it('parses valid JSON', () => {
    expect(parseToolCallArguments('{"text":"hi"}')).toEqual({
      data: { text: 'hi' },
      parseFailed: false,
    });
  });

  it('falls back to an empty object when JSON is malformed', () => {
    expect(parseToolCallArguments('{"text":"hi",}')).toEqual({
      data: {},
      parseFailed: true,
      error: expect.any(String),
    });
  });

  it('falls back to an empty object for unrecoverable JSON', () => {
    expect(parseToolCallArguments('{}{')).toEqual({
      data: {},
      parseFailed: true,
      error: expect.any(String),
    });
  });
});

describe('truncation pipeline', () => {
  let homeDir: string;
  let readConfig: IConfigService;
  let globProcess: HostProcessService;
  let attachmentStore: SessionMediaStoreService;
  let mediaRuntime: IAgentRuntimeService;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'tool-executor-truncation-'));
    const truncationContainer = disposables.add(new TestInstantiationService());
    truncationContainer.stub(IBootstrapService, stubBootstrap(homeDir));
    truncationContainer.stub(
      IAgentScopeContext,
      makeAgentScopeContext({
        agentId: 'main',
        agentScope: 'sessions/workspace/session/agents/main',
      }),
    );
    const storage = new FileStorageService(homeDir);
    truncationContainer.stub(IFileSystemStorageService, storage);
    attachmentStore = new SessionMediaStoreService(makeSessionContext({
      sessionId: 'session', workspaceId: 'workspace', cwd: homeDir,
      sessionDir: join(homeDir, 'sessions/workspace/session'),
      sessionScope: 'sessions/workspace/session',
    }), storage, new JsonAtomicDocumentStore(storage));
    truncationContainer.set(
      IAgentToolResultTruncationService,
      new SyncDescriptor(ToolResultTruncationService),
    );
    const truncation = truncationContainer.get(IAgentToolResultTruncationService);
    truncateForModel = (input) => truncation.truncateForModel(input);
    truncationContainer.stub(ILogService, stubLog());
    truncationContainer.set(IConfigRegistry, new SyncDescriptor(ConfigRegistry));
    truncationContainer.set(IAtomicTomlDocumentStore, new SyncDescriptor(TomlAtomicDocumentStore));
    truncationContainer.set(IConfigService, new SyncDescriptor(ConfigService));
    readConfig = truncationContainer.get(IConfigService);
    await readConfig.ready;
    globProcess = new HostProcessService();
    const runtime = Object.assign(new FakeRuntime(
      { workspaceId: 'workspace', runtimeId: 'local', generation: 'test' },
      { capabilities: ['fs', 'process'] },
    ), { fs: new HostFileSystem(), process: globProcess });
    const binding: IAgentRuntimeService = {
      _serviceBrand: undefined,
      onDidChange: () => ({ dispose: () => {} }),
      isAvailable: () => true,
      inspect: () => runtime,
      acquire: () => ({ runtime, track: (resource) => resource, dispose: () => {} }),
    };
    mediaRuntime = binding;
    registry.register(new ReadTool(
      binding,
      stubWorkspaceContext(homeDir),
      { catalog: { getSkillRoots: () => [] } } as unknown as ISessionSkillCatalog,
      truncation,
      readConfig,
      attachmentStore,
    ));
    registry.register(new GlobTool(binding, stubWorkspaceContext(homeDir), noopTelemetryService));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('spills oversized output to disk and renders a pointer for the model', async () => {
    const line = `${'x'.repeat(100)}\n`;
    const fullOutput = `HEAD_MARKER\n${line.repeat(300)}MIDDLE_MARKER\n${line.repeat(
      300,
    )}TAIL_MARKER\n`;
    const tool = new TestTool('noisy', {
      execute: async () => {
        const builder = new ToolOutputAccumulator();
        builder.write(fullOutput);
        return builder.ok();
      },
    });
    registry.register(tool);

    const [result] = await execute([toolCall('call_noisy', 'noisy', {})]);

    expect(result?.truncated).toBe(true);
    expect(result).not.toHaveProperty('spill');
    const rendered = result?.output;
    expect(typeof rendered).toBe('string');
    if (typeof rendered !== 'string') throw new Error('expected string output');
    expect(rendered).toContain('Tool output exceeded 50000 characters');
    expect(rendered).toContain('tool_name: noisy');
    expect(rendered).toContain('tool_call_id: call_noisy');
    expect(rendered).toContain('HEAD_MARKER');
    expect(rendered).toContain('TAIL_MARKER');
    expect(rendered).not.toContain('MIDDLE_MARKER');
    expect(rendered).toMatch(/\[elided: chars \[4096, \d+\)\]/);

    const outputPath = renderedOutputPath(rendered);
    expect(outputPath).toContain(
      join(homeDir, 'sessions/workspace/session/agents/main/tool-results/noisy-call_noisy-'),
    );
    expect(readFileSync(outputPath, 'utf8')).toBe(fullOutput);
  });

  it('recovers every Glob match through spill and Read when the match limit is disabled', async () => {
    const expected = Array.from({ length: 500 }, (_, index) =>
      `file-${String(index).padStart(3, '0')}-${'x'.repeat(100)}.ts`,
    );
    await Promise.all(expected.map((name) => writeFile(join(homeDir, name), '')));

    const [result] = await execute([toolCall('glob_all', 'Glob', { pattern: '*.ts', head_limit: 0 })]);

    expect(result?.isError).not.toBe(true);
    expect(result?.truncated).toBe(true);
    if (typeof result?.output !== 'string') throw new Error('expected Glob text');
    const path = renderedOutputPath(result.output);
    let args: ReadInput | undefined = { path, max_chars: 8000 };
    const recovered: string[] = [];
    let pages = 0;
    while (args !== undefined && pages < 20) {
      const [page] = await execute([toolCall(`read_glob_${String(pages++)}`, 'Read', args)]);
      expect(page?.isError).not.toBe(true);
      if (typeof page?.output !== 'string') throw new Error('expected Read text');
      recovered.push(...page.output.replaceAll(/^\d+\t/gm, '').split('\n').filter(Boolean));
      const next = /Next Read: (\{[^\n]*\})/.exec(page.note ?? '')?.[1];
      args = next === undefined ? undefined : ReadInputSchema.parse(JSON.parse(next));
    }
    expect(args).toBeUndefined();
    expect(pages).toBeGreaterThan(1);
    expect(recovered.toSorted()).toEqual(expected);
  });

  it('recovers an expanded Glob listing beyond spill retention using complete saved pages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'r'.repeat(180)));
    try {
      const names = Array.from({ length: 60_000 }, (_, i) => `file-${String(i).padStart(6, '0')}.ts`);
      const stdout = names.map((name) => `./${name}`).join('\n') + '\n';
      vi.spyOn(globProcess, 'spawn').mockImplementation(async () => ({
        _serviceBrand: undefined,
        pid: 123,
        exitCode: 0,
        stdin: new PassThrough(),
        stdout: Readable.from([stdout]),
        stderr: Readable.from([]),
        wait: async () => 0,
        kill: async () => {},
        dispose: () => {},
      }));
      const recovered: string[] = [];
      let offset = 0;
      let globPages = 0;
      do {
        const [page] = await execute([toolCall(`glob_large_${String(globPages++)}`, 'Glob', {
          pattern: '*.ts', path: root, head_limit: 0, offset,
        })]);
        expect(page?.isError).not.toBe(true);
        if (typeof page?.output !== 'string') throw new Error('expected Glob output');
        expect(page.output).toContain('the full output was saved to a file');
        const continuation = /Continue with the same search arguments and offset=(\d+)\./.exec(page.output)?.[1];
        if (continuation !== undefined) expect(Number(continuation)).toBeGreaterThan(offset);
        offset = continuation === undefined ? 0 : Number(continuation);
        let args: ReadInput | undefined = { path: renderedOutputPath(page.output), max_chars: 500_000 };
        let reads = 0;
        while (args !== undefined && reads < 40) {
          const [read] = await execute([toolCall(`read_large_${String(globPages)}_${String(reads++)}`, 'Read', args)]);
          expect(read?.isError).not.toBe(true);
          if (typeof read?.output !== 'string') throw new Error('expected Read output');
          recovered.push(...read.output.replaceAll(/^\d+\t/gm, '').split('\n').filter((line) => line.startsWith(root + '/')));
          const next = /Next Read: (\{[^\n]*\})/.exec(read.note ?? '')?.[1];
          args = next === undefined ? undefined : ReadInputSchema.parse(JSON.parse(next));
        }
        expect(args).toBeUndefined();
      } while (offset > 0 && globPages < 5);
      expect(offset).toBe(0);
      expect(globPages).toBe(2);
      expect(recovered).toEqual(names.map((name) => `${root}/${name}`));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the MCP attachment path visible after text spill without repeating the remote call', async () => {
    const bytes = Buffer.from('%PDF-1.4\nexample report\n%%EOF');
    const client = {
      async listTools() { return []; },
      callTool: vi.fn(async () => ({
        isError: false,
        content: [
          { type: 'text', text: 'x'.repeat(100_000) },
          { type: 'resource', resource: {
            uri: 'example://report', mimeType: 'application/pdf', blob: bytes.toString('base64'),
          } },
        ],
      })),
      async ping() {},
    } satisfies MCPClient;
    registry.register(createMcpTool('mcp__example__report', {
      name: 'report', description: 'Example report', parameters: {},
    }, client, { attachmentStore }), { source: 'mcp' });
    const [result] = await execute([toolCall('report', 'mcp__example__report', {})]);
    expect(result?.isError).not.toBe(true);
    if (result === undefined) throw new Error('expected MCP result');
    const visible = renderToolResultForModel(result).map((part) => part.type === 'text' ? part.text : '').join('\n');
    expect(visible).toContain('output_path:');
    expect(visible.length).toBeLessThan(50_000);
    const encodedPath = /Original attachment saved at: ("[^\n]+")/.exec(visible)?.[1];
    expect(encodedPath).toBeDefined();
    expect(readFileSync(JSON.parse(encodedPath!) as string).equals(bytes)).toBe(true);
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it.each([0, 100_000])('bounds batch attachment notices and recovers every reference with %s text characters', async (textSize) => {
    const originals = Array.from({ length: 150 }, (_, i) => Buffer.from(`%PDF-1.4\nreport ${String(i)}\n%%EOF`));
    const client: MCPClient = {
      async listTools() { return []; },
      async callTool() { return {
        isError: false,
        content: [
          { type: 'text', text: `${'x'.repeat(100)}\n`.repeat(Math.ceil(textSize / 101)) },
          ...originals.map((bytes, i) => ({ type: 'resource', resource: {
            uri: `example://report/${String(i)}`, mimeType: 'application/pdf', blob: bytes.toString('base64'),
          } })),
        ],
      }; },
      async ping() {},
    };
    registry.register(createMcpTool('mcp__example__batch', {
      name: 'batch', description: 'Example reports', parameters: {},
    }, client, { attachmentStore }), { source: 'mcp' });
    const [result] = await execute([toolCall('batch', 'mcp__example__batch', {})]);
    if (result === undefined) throw new Error('expected batch output');
    const visible = renderToolResultForModel(result).map((part) => part.type === 'text' ? part.text : '').join('\n');
    expect(visible.length).toBeLessThan(50_000);
    const encodedPath = /Attachment details reference: ("[^\n]+")/.exec(visible)?.[1];
    expect(encodedPath).toBeDefined();
    let args: ReadInput | undefined = { path: JSON.parse(encodedPath!) as string, max_chars: 8000 };
    let recovered = '';
    let pages = 0;
    while (args !== undefined && pages < 30) {
      const [read] = await execute([toolCall(`read_batch_${String(pages++)}`, 'Read', args)]);
      expect(read?.isError).not.toBe(true);
      if (typeof read?.output !== 'string') throw new Error('expected Read output');
      recovered += read.output.replaceAll(/^\d+\t/gm, '') + '\n';
      const next = /Next Read: (\{[^\n]*\})/.exec(read.note ?? '')?.[1];
      args = next === undefined ? undefined : ReadInputSchema.parse(JSON.parse(next));
    }
    expect(args).toBeUndefined();
    expect(pages).toBeGreaterThan(1);
    const paths = [...recovered.matchAll(/Original attachment saved at: ("[^\n]+")/g)].map((match) => JSON.parse(match[1]!) as string);
    expect(paths).toHaveLength(150);
    for (const [i, path] of paths.entries()) expect(readFileSync(path).equals(originals[i]!)).toBe(true);
  });

  it('resolves attachment references for media reads and exposes binary paths for converters', async () => {
    const runtimeFs = mediaRuntime.inspect().fs!;
    vi.spyOn(runtimeFs, 'stat').mockRejectedValue(new Error('client cannot access daemon storage'));
    vi.spyOn(runtimeFs, 'readBytes').mockRejectedValue(new Error('client cannot access daemon storage'));
    vi.spyOn(runtimeFs, 'readLines').mockImplementation(() => {
      throw new Error('client cannot access daemon storage');
    });
    registry.register(new ReadMediaFileTool(mediaRuntime, { workspaceDir: homeDir, additionalDirs: [] }, {
      image_in: true, video_in: false, audio_in: false, thinking: false, tool_use: true,
    }, undefined, undefined, undefined, undefined, attachmentStore));
    const png = Buffer.from(await new Jimp({ width: 32, height: 32, color: 0x3366ccff }).getBuffer('image/png'));
    const bytes = [png, Buffer.from('%PDF-1.4\nexample\n%%EOF')];
    const client: MCPClient = {
      async listTools() { return []; },
      async callTool() { return { isError: false, content: bytes.map((data, i) => ({ type: 'resource', resource: {
        uri: `example://file/${String(i)}`, mimeType: 'application/octet-stream', blob: data.toString('base64'),
      } })) }; },
      async ping() {},
    };
    registry.register(createMcpTool('mcp__example__binary', { name: 'binary', description: 'Example files', parameters: {} }, client, { attachmentStore }), { source: 'mcp' });
    const [result] = await execute([toolCall('binary', 'mcp__example__binary', {})]);
    if (result === undefined) throw new Error('expected MCP output');
    const text = renderToolResultForModel(result).map((part) => part.type === 'text' ? part.text : '').join('\n');
    const refs = [...text.matchAll(/Attachment reference: ("[^\n]+")/g)].map((match) => JSON.parse(match[1]!) as string);
    const paths = [...text.matchAll(/Original attachment saved at: ("[^\n]+")/g)].map((match) => JSON.parse(match[1]!) as string);
    expect(refs).toHaveLength(2);
    const [image] = await execute([toolCall('read_image', 'ReadMediaFile', { path: refs[0] })]);
    expect(image?.isError).not.toBe(true);
    expect(Array.isArray(image?.output) && image.output.some((part) => part.type === 'image_url')).toBe(true);
    if (image === undefined) throw new Error('expected image output');
    const imageText = renderToolResultForModel(image).map((part) => part.type === 'text' ? part.text : '').join('\n');
    const tagPath = /<image path="([^"]+)">/.exec(imageText)?.[1];
    expect(tagPath).toBe(refs[0]);
    const [crop] = await execute([toolCall('read_crop', 'ReadMediaFile', {
      path: tagPath, region: { x: 0, y: 0, width: 16, height: 16 },
    })]);
    expect(crop?.isError).not.toBe(true);
    const [pdf] = await execute([toolCall('read_pdf', 'Read', { path: refs[1] })]);
    expect(pdf?.isError).toBe(true);
    expect(pdf?.output).toContain(paths[1]);
    expect(readFileSync(paths[1]!).equals(bytes[1]!)).toBe(true);
  });

  it('reads session text from its owner while workspace text still uses the runtime buffer', async () => {
    const runtimeFs = mediaRuntime.inspect().fs!;
    const clientRead = vi.spyOn(runtimeFs, 'readLines').mockImplementation(async function* () {
      yield 'unsaved client buffer\n';
    });
    const workspaceFile = join(homeDir, 'workspace.txt');
    await writeFile(workspaceFile, 'disk content\n');
    const bytes = Buffer.from('session attachment\n');
    const client: MCPClient = {
      async listTools() { return []; },
      async callTool() { return { isError: false, content: [{ type: 'resource', resource: {
        uri: 'example://text', mimeType: 'text/plain', blob: bytes.toString('base64'),
      } }] }; },
      async ping() {},
    };
    registry.register(createMcpTool('mcp__example__text', { name: 'text', description: 'Example text', parameters: {} }, client, { attachmentStore }), { source: 'mcp' });
    const [result] = await execute([toolCall('text', 'mcp__example__text', {})]);
    if (result === undefined) throw new Error('expected MCP output');
    const text = renderToolResultForModel(result).map((part) => part.type === 'text' ? part.text : '').join('\n');
    const reference = JSON.parse(/Attachment reference: ("[^\n]+")/.exec(text)![1]!) as string;
    const [attachment] = await execute([toolCall('read_attachment', 'Read', { path: reference })]);
    expect(attachment?.output).toBe('1\tsession attachment');
    expect(clientRead).not.toHaveBeenCalled();
    const [workspace] = await execute([toolCall('read_workspace', 'Read', { path: workspaceFile })]);
    expect(workspace?.output).toBe('1\tunsaved client buffer');
    expect(clientRead).toHaveBeenCalledTimes(1);
  });

  it('recovers MCP structured records through spill and Read without repeating the MCP call', async () => {
    const structuredContent = {
      rows: Array.from({ length: 1200 }, (_, index) => ({
        id: index + 1,
        detail: 'x'.repeat(100),
      })),
      literal: 'a</mcp-result-extras>b',
    };
    const client = {
      async listTools() { return []; },
      callTool: vi.fn(async () => ({
        content: [{ type: 'text', text: 'Found 1200 rows.' }],
        isError: false,
        structuredContent,
      })),
      async ping() {},
    } satisfies MCPClient;
    registry.register(createMcpTool(
      'mcp__example__rows',
      { name: 'rows', description: 'Example records', parameters: {} },
      client,
    ), { source: 'mcp' });

    const [result] = await execute([toolCall('call_rows', 'mcp__example__rows', {})]);

    expect(result?.isError).not.toBe(true);
    expect(result?.truncated).toBe(true);
    if (result === undefined) throw new Error('expected MCP result');
    const visible = renderToolResultForModel(result)
      .map((part) => part.type === 'text' ? part.text : '').join('\n');
    expect(visible.length).toBeLessThan(50_000);
    const path = renderedOutputPath(visible);
    let args: ReadInput | undefined = { path, max_chars: 16_000 };
    let recovered = '';
    let pages = 0;
    while (args !== undefined && pages < 30) {
      const [page] = await execute([toolCall(`read_mcp_${String(pages++)}`, 'Read', args)]);
      expect(page?.isError).not.toBe(true);
      if (typeof page?.output !== 'string') throw new Error('expected Read text');
      const pageText = renderToolResultForModel(page)
        .map((part) => part.type === 'text' ? part.text : '').join('\n');
      expect(pageText.length).toBeLessThanOrEqual(16_000);
      if (recovered.length > 0 && (args.column_offset ?? 0) === 0) recovered += '\n';
      recovered += page.output.replaceAll(/^\d+\t/gm, '');
      const next = /Next Read: (\{[^\n]*\})/.exec(page.note ?? '')?.[1];
      args = next === undefined ? undefined : ReadInputSchema.parse(JSON.parse(next));
    }

    expect(args).toBeUndefined();
    expect(pages).toBeGreaterThan(2);
    expect(recovered).toContain('Found 1200 rows.');
    const json = /<mcp-result-extras>\n([\s\S]*?)\n<\/mcp-result-extras>/.exec(recovered)?.[1];
    if (json === undefined) throw new Error('expected recovered MCP result extras');
    expect(JSON.parse(json)).toEqual({ structuredContent });
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it('keeps the builder completion message after spilling an error result', async () => {
    const fullOutput = `${'x'.repeat(50_001)}tail`;
    const tool = new TestTool('failing-noisy', {
      execute: async () => {
        const builder = new ToolOutputAccumulator();
        builder.write(fullOutput);
        return builder.error('Command failed with exit code: 1.');
      },
    });
    registry.register(tool);

    const [result] = await execute([toolCall('call_failing_noisy', 'failing-noisy', {})]);

    expect(result?.isError).toBe(true);
    const rendered = result?.output;
    expect(typeof rendered).toBe('string');
    if (typeof rendered !== 'string') throw new Error('expected string output');
    expect(rendered).toContain('Command failed with exit code: 1.');
    expect(readFileSync(renderedOutputPath(rendered), 'utf8')).toBe(
      `${fullOutput}\nCommand failed with exit code: 1.`,
    );
  });

  it('keeps the builder completion message after spilling a successful result', async () => {
    const fullOutput = 'x'.repeat(50_001);
    const tool = new TestTool('successful-noisy', {
      execute: async () => {
        const builder = new ToolOutputAccumulator();
        builder.write(fullOutput);
        return builder.ok('Command executed successfully.');
      },
    });
    registry.register(tool);

    const [result] = await execute([toolCall('call_successful_noisy', 'successful-noisy', {})]);

    expect(result?.isError).not.toBe(true);
    const rendered = result?.output;
    expect(typeof rendered).toBe('string');
    if (typeof rendered !== 'string') throw new Error('expected string output');
    expect(rendered).toContain('Command executed successfully.');
    expect(readFileSync(renderedOutputPath(rendered), 'utf8')).toBe(fullOutput);
  });

  it('appends a spill pointer for per-line truncation without replacing the output', async () => {
    const longLine = 'x'.repeat(60_000);
    const fullOutput = `short line\n${longLine}\n`;
    const tool = new TestTool('long-line', {
      execute: async () => {
        const builder = new ToolOutputAccumulator();
        builder.write(fullOutput);
        return builder.ok();
      },
    });
    registry.register(tool);

    const [result] = await execute([toolCall('call_long_line', 'long-line', {})]);

    expect(result?.truncated).toBe(true);
    expect(result).not.toHaveProperty('spill');
    const rendered = result?.output;
    expect(typeof rendered).toBe('string');
    if (typeof rendered !== 'string') throw new Error('expected string output');
    expect(rendered).toContain('short line');
    expect(rendered).toContain('[...truncated]');
    expect(rendered).toContain(
      'Per-line truncation occurred; the complete output was saved to a file.',
    );
    expect(readFileSync(renderedOutputPath(rendered), 'utf8')).toBe(fullOutput);
  });

  it('passes spill-exempt results through the truncation pipeline unchanged', async () => {
    const output = `SPILL_CHUNK\n${`${'y'.repeat(100)}\n`.repeat(600)}`;
    registry.register(new TestTool('reader', { result: { output, spillExempt: true } }));

    const [result] = await execute([toolCall('call_reader', 'reader', {})]);

    expect(result?.output).toBe(output);
    expect(result?.truncated).toBeUndefined();
  });

  it('delivers a bounded Read result above 50000 characters without replacing its text', async () => {
    const content = `${'x'.repeat(100)}\n`.repeat(650);
    const path = join(homeDir, 'paper.md');
    await writeFile(path, content);

    const [result] = await execute([toolCall('call_read_paper', 'Read', { path })]);

    expect(result?.isError).not.toBe(true);
    expect(typeof result?.output).toBe('string');
    if (typeof result?.output !== 'string') throw new TypeError('expected Read text');
    expect(result.output.length).toBeGreaterThan(50_000);
    expect(result.output.replaceAll(/^\d+\t/gm, '')).toBe(content.trimEnd());
    expect(result.truncated).toBeUndefined();
    expect(result.note).toContain('Requested range complete.');
    expect(result.output).not.toContain('output_path:');
  });

  it('recovers a large line through the model-facing Read pipeline without shell tools', async () => {
    const content = '0123456789'.repeat(110_000);
    const path = join(homeDir, 'record.jsonl');
    await writeFile(path, content);
    const fragments: string[] = [];
    let args: ReadInput | undefined = { path, n_lines: 1, max_chars: 100_000 };

    for (let page = 0; args !== undefined && page < 30; page += 1) {
      const [result] = await execute([toolCall(`read_fragment_${String(page)}`, 'Read', args)]);
      expect(result?.isError).not.toBe(true);
      if (typeof result?.output !== 'string') throw new TypeError('expected Read text');
      expect(result.output.startsWith('1\t')).toBe(true);
      const visible = renderToolResultForModel(result)
        .map((part) => part.type === 'text' ? part.text : '').join('');
      expect(visible.length).toBeLessThanOrEqual(100_000);
      if (page === 0) expect(result.output.length).toBeGreaterThan(50_000);
      fragments.push(result.output.slice(2));
      const next = result.note?.match(/Next Read: (\{[^\n]*\})/);
      args = next === undefined || next === null ? undefined : ReadInputSchema.parse(JSON.parse(next[1]!));
    }

    expect(args).toBeUndefined();
    expect(fragments.length).toBeGreaterThan(10);
    expect(fragments.join('')).toBe(content);
  });

  it('keeps valid lines readable and exposes the warning when later UTF-16 bytes are malformed', async () => {
    const path = join(homeDir, 'malformed.txt');
    await writeFile(path, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('good\n', 'utf16le'),
      Buffer.from([0x00, 0xd8]),
    ]));

    const [result] = await execute([toolCall('read_lossy', 'Read', { path, n_lines: 1, max_chars: 1200 })]);

    expect(result?.isError).not.toBe(true);
    expect(result?.output).toBe('1\tgood');
    if (result === undefined) throw new Error('expected a Read result');
    const visible = renderToolResultForModel(result)
      .map((part) => part.type === 'text' ? part.text : '').join('');
    expect(visible).toContain('Lossy UTF-16 decoding');
    expect(visible).toContain('may differ from the original file');
    expect(visible.length).toBeLessThanOrEqual(1200);
  });

  it('applies persisted Read defaults and caps explicit character requests', async () => {
    await readConfig.set('read', { defaultMaxChars: 1500, maxChars: 3000 });
    await readConfig.reload();
    const path = join(homeDir, 'configured.md');
    await writeFile(path, `${'x'.repeat(100)}\n`.repeat(100));

    const [defaultResult] = await execute([toolCall('read_default', 'Read', { path })]);
    const [largerResult] = await execute([toolCall('read_larger', 'Read', { path, max_chars: 10_000 })]);

    expect(defaultResult?.isError).not.toBe(true);
    expect(largerResult?.isError).not.toBe(true);
    if (typeof defaultResult?.output !== 'string' || typeof largerResult?.output !== 'string') {
      throw new TypeError('expected Read text');
    }
    expect(defaultResult.output.length + 1 + (defaultResult.note?.length ?? 0)).toBeLessThanOrEqual(1500);
    expect(largerResult.output.length + 1 + (largerResult.note?.length ?? 0)).toBeLessThanOrEqual(3000);
    expect(largerResult.output.length).toBeGreaterThan(defaultResult.output.length);
    expect(largerResult.note).toContain('Requested max_chars=10000 was capped at the configured maximum 3000.');
    expect(readFileSync(join(homeDir, 'config.toml'), 'utf8')).toContain('default_max_chars = 1500');
  });
});

function renderedOutputPath(output: string): string {
  const match = /^output_path: (.+)$/m.exec(output);
  if (match === null) throw new Error('expected tool output to include output_path');
  return match[1]!;
}

async function execute(
  calls: ToolCall[],
  signal?: AbortSignal,
  trace?: LLMRequestTrace,
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for await (const item of executor.execute(calls, {
    turnId: 0,
    signal: signal ?? new AbortController().signal,
    trace,
  })) {
    results.push(item.result);
    events.push({ type: 'tool.result', toolCallId: item.toolCallId, result: item.result });
  }
  return results;
}

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return {
    type: 'function',
    id,
    name,
    arguments: JSON.stringify(args),
  };
}

function eventTypes(): ToolExecutorEvent['type'][] {
  return events.map((event) => event.type);
}

function protocolEventTypes(): string[] {
  return protocolEvents.map((event) => event.type);
}

function pairedToolCallIds(): { readonly calls: string[]; readonly results: string[] } {
  return {
    calls: protocolEvents
      .filter(
        (event): event is ToolCallStarted =>
          event.type === 'tool.call.started',
      )
      .map((event) => event.toolCallId),
    results: protocolEvents
      .filter(
        (event): event is ToolResultEvent =>
          event.type === 'tool.result',
      )
      .map((event) => event.toolCallId),
  };
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class TestTool implements ExecutableTool<Record<string, unknown>> {
  readonly description = 'Test tool.';
  readonly parameters: Record<string, unknown>;
  readonly calls: Array<ExecutableToolContext & { readonly args: Record<string, unknown> }> = [];

  constructor(
    readonly name: string,
    private readonly options: {
      readonly parameters?: Record<string, unknown>;
      readonly accesses?: ToolAccesses;
      readonly stopBatchAfterThis?: boolean;
      readonly description?: string;
      readonly display?: ToolInputDisplay;
      readonly result?: ExecutableToolResult;
      readonly execute?: (
        ctx: ExecutableToolContext,
        args: Record<string, unknown>,
      ) => Promise<ExecutableToolResult>;
    } = {},
  ) {
    this.parameters = options.parameters ?? { type: 'object', additionalProperties: true };
  }

  resolveExecution(args: Record<string, unknown>): ToolExecution {
    return {
      approvalRule: this.name,
      accesses: this.options.accesses,
      stopBatchAfterThis: this.options.stopBatchAfterThis,
      description: this.options.description,
      display: this.options.display,
      execute: async (ctx) => {
        this.calls.push({ ...ctx, args });
        if (this.options.execute !== undefined) {
          return this.options.execute(ctx, args);
        }
        return this.options.result ?? {
          output: typeof args['text'] === 'string' ? args['text'] : `${this.name} result`,
        };
      },
    };
  }
}

class ControlledTool implements ExecutableTool<Record<string, unknown>> {
  readonly description = 'Controlled tool.';
  readonly parameters = { type: 'object', additionalProperties: true };
  readonly calls: ExecutableToolContext[] = [];
  readonly started: Promise<void>;
  private resolveStarted: () => void = () => {};

  constructor(
    readonly name: string,
    private readonly accesses: ToolAccesses,
  ) {
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
  }

  resolveExecution(): ToolExecution {
    return {
      approvalRule: this.name,
      accesses: this.accesses,
      execute: async (ctx) => {
        this.calls.push(ctx);
        this.resolveStarted();
        return new Promise<ExecutableToolResult>((resolve, reject) => {
          const onAbort = (): void => {
            ctx.signal.removeEventListener('abort', onAbort);
            const error = new Error(`${this.name} aborted`);
            error.name = 'AbortError';
            reject(error);
          };
          if (ctx.signal.aborted) {
            onAbort();
            return;
          }
          ctx.signal.addEventListener('abort', onAbort);
          setTimeout(() => {
            ctx.signal.removeEventListener('abort', onAbort);
            resolve({ output: `${this.name} result` });
          }, 50);
        });
      },
    };
  }
}
