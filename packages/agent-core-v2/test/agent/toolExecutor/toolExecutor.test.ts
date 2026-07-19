import type { ToolCall } from '#/kosong/contract/message';
import type { DomainEvent } from '#/app/event/eventBus';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import {
  ToolAccesses,
  type ExecutableTool,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
  type ToolResult,
  type ToolUpdate,
} from '#/tool/toolContract';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { AgentToolExecutorService, parseToolCallArguments } from '#/agent/toolExecutor/toolExecutorService';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IEventBus } from '#/app/event/eventBus';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { AgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContextService';
import { registerLogServices } from '../../_base/log/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { registerTestAgentWireServices } from '../../wire/stubs';

type ToolExecutorEvent =
  | { readonly type: 'tool.result'; readonly toolCallId: string; readonly result: ToolResult };

let disposables: DisposableStore;
let ix: TestInstantiationService;
let executor: IAgentToolExecutorService;
let registry: IAgentToolRegistryService;
let events: ToolExecutorEvent[];
let protocolEvents: DomainEvent[];
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
      registerTestAgentWireServices(reg, 'wire/tool-executor');
      reg.define(IAgentToolRegistryService, AgentToolRegistryService);
      reg.define(IAgentToolExecutorService, AgentToolExecutorService);
      reg.defineInstance(ITelemetryService, recordingTelemetry(telemetryEvents));
      reg.defineInstance(IAgentTelemetryContextService, new AgentTelemetryContextService());
      reg.defineInstance(IAgentToolResultTruncationService, {
        _serviceBrand: undefined,
        truncateForModel: (input) => truncateForModel(input),
      });
      reg.defineInstance(IEventBus, {
        publish: (event: { type: string }) => {
          if (event.type.startsWith('tool.')) {
            protocolEvents.push(event as unknown as DomainEvent);
          }
        },
        subscribe: (..._args: unknown[]) => ({ dispose: () => {} }),
      } as IEventBus);
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

  it('tags tool_call telemetry with recorded dup types, defaulting to normal', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    let tag = true;
    executor.hooks.onBeforeExecuteTool.register('test-dup-tag', async (ctx, next) => {
      if (tag && ctx.toolCall.id === 'call_dup') executor.recordDupType('call_dup', 'cross_step');
      await next();
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
      (event): event is Extract<DomainEvent, { type: 'tool.result' }> =>
        event.type === 'tool.result',
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
      (event): event is Extract<DomainEvent, { type: 'tool.call.started' }> =>
        event.type === 'tool.call.started',
    );
    expect(toolCallEvent?.args).toEqual({ x: 1 });
  });

  it('onBeforeExecuteTool block records an error result without invoking execute', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    executor.hooks.onBeforeExecuteTool.register('block', async (ctx) => {
      ctx.decision = { block: true, reason: 'forbidden' };
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

  it('onBeforeExecuteTool syntheticResult bypasses execute', async () => {
    const first = new TestTool('first');
    const second = new TestTool('second');
    registry.register(first);
    registry.register(second);
    executor.hooks.onBeforeExecuteTool.register('synthetic', async (ctx) => {
      if (ctx.toolCall.id !== 'call_first') return;
      ctx.decision = {
        syntheticResult: {
          output: 'synthetic',
        },
      };
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
      { type: 'tool.progress', turnId: 0, toolCallId: 'call_progress', update: updates[0] },
      { type: 'tool.progress', turnId: 0, toolCallId: 'call_progress', update: updates[1] },
    ]);
  });

  it('does not start a queued conflicting tool after abort', async () => {
    const controller = new AbortController();
    const first = new ControlledTool('first', ToolAccesses.writeFile('/repo/a.ts'));
    const second = new ControlledTool('second', ToolAccesses.writeFile('/repo/a.ts'));
    registry.register(first);
    registry.register(second);

    const execution = execute(
      [toolCall('call_first', 'first', {}), toolCall('call_second', 'second', {})],
      controller.signal,
    );
    await first.started;
    controller.abort();
    const results = await execution;

    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(0);
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

function protocolEventTypes(): DomainEvent['type'][] {
  return protocolEvents.map((event) => event.type);
}

function pairedToolCallIds(): { readonly calls: string[]; readonly results: string[] } {
  return {
    calls: protocolEvents
      .filter(
        (event): event is Extract<DomainEvent, { type: 'tool.call.started' }> =>
          event.type === 'tool.call.started',
      )
      .map((event) => event.toolCallId),
    results: protocolEvents
      .filter(
        (event): event is Extract<DomainEvent, { type: 'tool.result' }> =>
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
