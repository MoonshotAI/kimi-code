import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { Jimp } from 'jimp';

import type { ToolCall } from '#human/message';
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
  BeforeExecuteDecision,
  BeforeToolExecuteEvent,
  ToolDidExecuteContext,
  ToolExecutionOutcome,
  WillExecuteToolEvent,
} from '#/agent/toolExecutor/toolHooks';
import {
  ToolCallStarted,
  ToolUpdated,
  ToolResultEvent,
} from '#/agent/toolExecutor/toolExecutorEvents';
import { AgentToolExecutorService } from '#/agent/toolExecutor/toolExecutorService';
import {
  legacyDidExecuteContext,
  runLegacyStarting,
  runLegacyBeforeExecute,
} from '#/agent/toolExecutor/legacyHooks';
import {
  LegacyExecutableToolAdapter,
  ToolExecutor as HandlerToolExecutor,
  composeToolExecutorHooks,
  fileOutputStore,
  isToolDetachAck,
  legacyToolDurationMs,
  memoryOutputStore,
  textToolContent,
  toLegacyToolReturn,
  type ExecutableTool as HandlerExecutableTool,
  type LegacyToolPreparation,
  type ToolResult as HandlerToolResult,
} from '#/tool/executor';
import { parseToolCallArguments } from '#/tool/tool-args-parse';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { IAgentTaskOutputService } from '#/agent/task/taskOutput';
import { ToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncationService';
import { ReadTool } from '#/agent/tools/os/read/readTool';
import type { IAgentLoopService } from '#/agent/loop/loop';
import type { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { ReadMediaFileTool } from '#/agent/tools/read-media-file/readMediaFileTool';
import { SessionMediaStoreService } from '#/agent/media/sessionMediaStoreService';
import { JsonAtomicDocumentStore, TomlAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { GlobTool } from '#/agent/tools/os/glob/globTool';
import { ReadInputSchema, type ReadInput } from '#/agent/tools/os/read/read';
import { renderToolResultForModel } from '#/agent/contextMemory/toolResultRender';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import type { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import { stubWorkspaceContext } from '../../session/workspaceContext/stub-workspace-context';
import { stubAgentEnvironment } from '../../environment/stubs';
import { ConfigRegistry, ConfigService } from '#/app/config/configService';
import { IConfigRegistry, IConfigService } from '#/app/config/config';
import { IAtomicTomlDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { ILogService } from '#/_base/log/log';
import { makeAgentScopeContext, IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IEventBus } from '#/app/event/eventBus';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { IGitService } from '#/app/git/git';
import { IHostEnvironment as HostEnvironmentService } from '#/os/interface/hostEnvironment';
import { createAutoReviewReviewer } from '#/features/autoReview/autoReviewGate';
import { IAutoReviewService } from '#/features/autoReview/review';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionPolicyService } from '#/agent/permissionPolicy/permissionPolicy';
import { AgentPermissionPolicyService } from '#/agent/permissionPolicy/permissionPolicyService';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import { AgentPermissionGate } from '#/agent/permissionGate/permissionGateService';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { AgentToolApprovalService } from '#/agent/toolApproval/toolApprovalService';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { stubPermissionModeService } from '../permissionMode/stubs';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { registerLogServices, stubLog } from '../../_base/log/stubs';
import { stubBootstrap } from '../../app/bootstrap/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { registerStateServices } from '../../state/stubs';
import { registerTestAgentWireServices } from '../../wire/stubs';

type ToolExecutorEvent =
  | { readonly type: 'tool.result'; readonly toolCallId: string; readonly result: ToolResult };

type ProtocolEvent = ToolCallStarted | ToolUpdated | ToolResultEvent;

let disposables: DisposableStore;
let ix: TestInstantiationService;
let executor: IAgentToolExecutorService;
let registry: IAgentToolRegistryService;
let events: ToolExecutorEvent[];
let protocolEvents: ProtocolEvent[];
let telemetryEvents: TelemetryRecord[];
let truncateForModel: IAgentToolResultTruncationService['truncateForModel'];

let durations: number[];

beforeEach(() => {
  disposables = new DisposableStore();
  events = [];
  durations = [];
  protocolEvents = [];
  telemetryEvents = [];
  truncateForModel = async (input) => input.result;
  ix = createServices(disposables, {
    additionalServices: (reg) => {
      registerStateServices(reg);
      registerTestAgentWireServices(reg, 'wire/tool-executor');
      reg.define(IAgentToolRegistryService, AgentToolRegistryService);
      reg.define(IAgentToolExecutorService, AgentToolExecutorService);
      reg.defineInstance(IAgentTaskOutputService, { open: memoryOutputStore().open } as unknown as IAgentTaskOutputService);
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

describe('AgentToolExecutorService auto review', () => {
  it('does not execute a tool denied by the reviewer', async () => {
    installAutoReview({ kind: 'decision', decision: { risk: 'high', decision: 'deny' } });
    const tool = new TestTool('Write');
    registry.register(tool);

    const [result] = await execute([toolCall('call_review', 'Write', { path: 'outside.txt' })]);

    expect(result).toMatchObject({ isError: true, output: expect.stringContaining('not executed') });
    expect(tool.calls).toHaveLength(0);
  });

  it('executes a tool allowed by the reviewer', async () => {
    installAutoReview({ kind: 'decision', decision: { risk: 'low', decision: 'allow' } });
    const tool = new TestTool('Write');
    registry.register(tool);

    const [result] = await execute([toolCall('call_review', 'Write', { path: 'src/a.ts' })]);

    expect(result).not.toMatchObject({ isError: true });
    expect(tool.calls).toHaveLength(1);
  });

  it('starts every review in a batch before waiting for the first decision', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const release = deferred<import('#/features/autoReview/review').AutoReviewResult>();
    installAutoReview(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await release.promise;
      } finally {
        inFlight -= 1;
      }
    });
    const tool = new TestTool('Write');
    registry.register(tool);

    const pending = execute([
      toolCall('call_a', 'Write', { path: 'outside-a.txt' }),
      toolCall('call_b', 'Write', { path: 'outside-b.txt' }),
    ]);
    await vi.waitFor(() => {
      expect(maxInFlight).toBe(2);
    });
    release.resolve({ kind: 'decision', decision: { risk: 'high', decision: 'deny' } });

    const results = await pending;
    expect(results).toHaveLength(2);
    expect(tool.calls).toHaveLength(0);
  });

  it('cancels each review only after its own approval finishes', async () => {
    const signals: AbortSignal[] = [];
    installAutoReview(async (signal) => {
      signals.push(signal!);
      return { kind: 'decision', decision: { risk: 'low', decision: 'allow' } };
    });
    registry.register(new TestTool('Write'));

    await execute([
      toolCall('call_a', 'Write', { path: 'outside-a.txt' }),
      toolCall('call_b', 'Write', { path: 'outside-b.txt' }),
    ]);

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});

function installAutoReview(
  result:
    | import('#/features/autoReview/review').AutoReviewResult
    | ((signal?: AbortSignal) => Promise<import('#/features/autoReview/review').AutoReviewResult>),
): void {
  const permissions = disposables.add(new TestInstantiationService(undefined, false, ix));
  permissions.stub(IAgentPermissionModeService, stubPermissionModeService(() => 'auto'));
  permissions.stub(IFlagService, { enabled: () => true });
  permissions.stub(IAutoReviewService, {
    review: typeof result === 'function'
      ? (_context, _trigger, signal) => result(signal)
      : async () => result,
  });
  permissions.stub(IBootstrapService, stubBootstrap('/tmp', {}, { nonInteractive: true }));
  permissions.stub(IConfigService, { get: (() => undefined) as IConfigService['get'] });
  permissions.stub(IAgentPermissionRulesService, { rules: [], sessionApprovalRulePatterns: [] });
  permissions.stub(ISessionWorkspaceContext, stubWorkspaceContext('/workspace'));
  permissions.stub(HostEnvironmentService, { pathClass: 'posix' });
  permissions.stub(IAgentEnvironmentService, stubAgentEnvironment(new FakeEnvironment(
    { environmentId: 'local', generation: 'test' },
    { pathClass: 'posix' },
  ), { workDir: '/workspace' }));
  permissions.stub(IGitService, { findWorkTree: async () => null });
  permissions.stub(IAgentToolApprovalService, new AgentToolApprovalService(
    permissions.get(IAgentScopeContext),
    permissions.get(IAgentPermissionModeService),
    permissions.get(IAgentPermissionRulesService),
    permissions.get(ISessionContext),
    permissions.get(ITelemetryService),
    permissions.get(IEventDispatcher),
    permissions.get(IBootstrapService),
  ));
  permissions.set(IAgentPermissionPolicyService, new AgentPermissionPolicyService(
    permissions,
    permissions.get(IBootstrapService),
  ));
  const gate = new AgentPermissionGate(
    permissions.get(IAgentPermissionModeService),
    permissions.get(IAgentPermissionRulesService),
    permissions.get(IAgentPermissionPolicyService),
    permissions.get(IAgentToolApprovalService),
    permissions.get(ITelemetryService),
    executor,
  );
  disposables.add(
    gate.registerReviewer(
      createAutoReviewReviewer(
        permissions.get(IFlagService),
        permissions.get(IAgentPermissionModeService),
        () => permissions.get(IAutoReviewService),
      ),
    ),
  );
  permissions.set(IAgentPermissionGate, gate);
}

describe('AgentToolExecutorService', () => {
  it('resolves by interface and routes a successful tool call through execute', async () => {
    vi.useFakeTimers();
    try {
      const detach = vi.fn();
      const tool = new TestTool('echo', {
        execute: async (ctx, args) => {
          ctx.detach?.('background task_id=task-echo');
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          return { output: String(args['text']) };
        },
      });
      registry.register(tool);
      const starting = executor.registerLegacyStarting((event) => {
        event.waitUntil(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        });
      });
      truncateForModel = async (input) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        return input.result;
      };

      const pending = execute([toolCall('call_echo', 'echo', { text: 'hi' })], undefined, undefined, detach);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(25);
      await vi.advanceTimersByTimeAsync(500);
      const results = await pending;

      expect(results).toEqual([
        expect.objectContaining({
          output: 'hi',
        }),
      ]);
      expect(results[0]).not.toHaveProperty('stopTurn');
      expect(durations).toEqual([25]);
      expect(detach).toHaveBeenCalledWith('call_echo', 'background task_id=task-echo');
      expect(tool.calls).toEqual([
        expect.objectContaining({
          toolCallId: 'call_echo',
          turnId: 0,
          args: { text: 'hi' },
        }),
      ]);
      expect(eventTypes()).toEqual(['tool.result']);
      expect(protocolEventTypes()).toEqual([
        'tool.call.started',
        'tool.updated',
        'tool.updated',
        'tool.updated',
        'tool.updated',
        'tool.result',
      ]);
      expect(telemetryEvents).toContainEqual({
        event: 'tool_call',
        properties: expect.objectContaining({
          turn_id: 0,
          tool_call_id: 'call_echo',
          tool_name: 'echo',
          outcome: 'success',
          duration_ms: 25,
        }),
      });

      starting.dispose();
      truncateForModel = async (input) => input.result;
      const firstStarted = deferred();
      const secondStarted = deferred();
      const accesses = ToolAccesses.writeFile('/repo/leased.ts');
      const firstTool = new TestTool('lease-first', {
        accesses,
        execute: async () => {
          firstStarted.resolve();
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
          return { output: 'first' };
        },
      });
      const secondTool = new TestTool('lease-second', {
        accesses,
        execute: async () => {
          secondStarted.resolve();
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          return { output: 'second' };
        },
      });
      registry.register(firstTool);
      registry.register(secondTool);
      const first = executor.executor.execute(toolCall('lease-first-1', 'lease-first', {}), { turnId: 1, step: 0 });
      const second = executor.executor.execute(toolCall('lease-second-1', 'lease-second', {}), { turnId: 1, step: 0 });
      await firstStarted.promise;
      expect(secondTool.calls).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
      await secondStarted.promise;
      await vi.advanceTimersByTimeAsync(25);
      await Promise.all([first.wait(), second.wait()]);
      expect(legacyToolDurationMs(first.snapshot())).toBe(200);
      expect(legacyToolDurationMs(second.snapshot())).toBe(25);
      executor.release(first.taskId);
      executor.release(second.taskId);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects by policy before dynamic availability when a tool-call guard denies it', async () => {
    const tool = new TestTool('blocked');
    registry.register(tool, { source: 'mcp' });
    registerGuard(executor, ({ name, source }) =>
      name === 'blocked' && source === 'mcp' ? 'Tool "blocked" is disabled' : undefined,
    );
    registerUnavailable(executor, () => 'Tool "blocked" is not loaded');

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
    executor.registerLegacyStarting((event) => {
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
    await execute(
      [toolCall('call_dup', 'echo', { text: 'c' })],
      undefined,
      { requestId: 'trace-tool-1' },
    );
    expect(telemetryEvents).toContainEqual({
      event: 'tool_call',
      properties: expect.objectContaining({
        tool_call_id: 'call_dup',
        dup_type: 'normal',
        request_id: 'trace-tool-1',
      }),
    });
  });

  it('preserves valid internal notes and drops malformed result metadata', async () => {
    registry.register(new TestTool('captioned', {
      result: {
        output: 'image sent',
        note: '<system>Image compressed.</system>',
      },
    }));
    registry.register(new TestTool('malformed-meta', {
      result: {
        output: 'image sent',
        note: 123,
        truncated: false,
      } as unknown as ExecutableToolResult,
    }));

    const results = await execute([
      toolCall('call_captioned', 'captioned', {}),
      toolCall('call_malformed_meta', 'malformed-meta', {}),
    ]);

    expect(results[0]).toMatchObject({
      output: 'image sent',
      note: '<system>Image compressed.</system>',
    });
    expect(results[1]).toMatchObject({ output: 'image sent' });
    expect(results[1] as unknown as Record<string, unknown>).not.toHaveProperty('note');
    expect(results[1] as unknown as Record<string, unknown>).not.toHaveProperty('truncated');
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

  it('records an unknown tool error and preserves its valid args in tool.call.started', async () => {
    const results = await execute([toolCall('call_missing', 'missing', { x: 1 })]);

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
    const toolCallEvent = protocolEvents.find(
      (event): event is ToolCallStarted => event.type === 'tool.call.started',
    );
    expect(toolCallEvent?.args).toEqual({ x: 1 });
    expect(telemetryEvents).toContainEqual({
      event: 'tool_call',
      properties: expect.objectContaining({
        turn_id: 0,
        tool_call_id: 'call_missing',
        tool_name: 'missing',
        outcome: 'error',
        duration_ms: 0,
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

    expect(accepted).toEqual([expect.objectContaining({ output: 'dynamic result' })]);
    expect(accepted[0]).not.toHaveProperty('stopTurn');
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
    executor.registerLegacyStarting((event) => {
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
    expect(protocolEventTypes()).toEqual(['tool.call.started', 'tool.updated', 'tool.result']);
  });

  it('resolves a pending veto before reporting the tool call', async () => {
    const decision = deferred<BeforeExecuteDecision>();
    executor.registerLegacyStarting((event) => {
      event.waitUntil(() => decision.promise);
    });
    registry.register(new TestTool('echo'));

    const pending = execute([toolCall('call_echo', 'echo', { text: 'hi' })]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(protocolEventTypes()).toEqual([]);

    decision.resolve({ veto: { output: 'forbidden', isError: true } });
    await pending;
    expect(protocolEventTypes()).toEqual(['tool.call.started', 'tool.updated', 'tool.result']);
  });

  it('onBeforeExecuteTool veto bypasses execute with synthetic results while hook errors emit no tool events', async () => {
    vi.useFakeTimers();
    const first = new TestTool('first');
    const second = new TestTool('second');
    const third = new TestTool('third');
    const fourth = new TestTool('fourth');
    registry.register(first);
    registry.register(second);
    registry.register(third);
    registry.register(fourth);
    executor.registerLegacyStarting((event) => {
      if (event.toolCall.id === 'call_first') event.veto({ output: 'forbidden', isError: true });
      if (event.toolCall.id === 'call_second') event.veto({ output: 'synthetic' });
    });

    try {
      const results = await execute([
        toolCall('call_first', 'first', {}),
        toolCall('call_second', 'second', {}),
        toolCall('call_third', 'third', {}),
      ]);

      expect(results).toEqual([
        expect.objectContaining({ output: 'forbidden', isError: true }),
        expect.objectContaining({ output: 'synthetic' }),
        expect.objectContaining({ output: 'third result' }),
      ]);
      expect(first.calls).toEqual([]);
      expect(second.calls).toEqual([]);
      expect(third.calls).toHaveLength(1);
      expect(durations).toEqual([0, 0, 0]);
      expect(pairedToolCallIds()).toEqual({
        calls: ['call_first', 'call_second', 'call_third'],
        results: ['call_first', 'call_second', 'call_third'],
      });
    } finally {
      vi.useRealTimers();
    }

    const subscription = executor.registerHook({
      beforeExecute: () => {
        throw new Error('beforeExecute blew up');
      },
    });
    await expect(execute([toolCall('call_fourth', 'fourth', {})])).rejects.toThrow('beforeExecute blew up');
    subscription.dispose();
    expect(fourth.calls).toEqual([]);
    expect(protocolEvents.filter((event) => event.toolCallId === 'call_fourth')).toEqual([]);
    expect(events.filter((event) => event.toolCallId === 'call_fourth')).toEqual([]);
  });

  it('executes later tool calls instead of stopping the batch', async () => {
    const first = new TestTool('first');
    const second = new TestTool('second');
    registry.register(first);
    registry.register(second);

    const results = await execute([
      toolCall('call_first', 'first', {}),
      toolCall('call_second', 'second', {}),
      toolCall('call_unknown', 'unknown', {}),
    ]);

    expect(results).toHaveLength(3);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ output: 'first result' }),
      expect.objectContaining({ output: 'second result' }),
    ]));
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
  });

  it('yields independent tool results as each call finishes', async () => {
    const slowRelease = deferred();
    const fastRelease = deferred();
    const slowStarted = deferred();
    const fastStarted = deferred();
    const slow = new TestTool('slow', {
      accesses: ToolAccesses.readFile('/repo/slow.txt'),
      execute: async () => {
        slowStarted.resolve();
        await slowRelease.promise;
        return { output: 'slow' };
      },
    });
    const fast = new TestTool('fast', {
      accesses: ToolAccesses.readFile('/repo/slow.txt'),
      execute: async () => {
        fastStarted.resolve();
        await fastRelease.promise;
        return { output: 'fast' };
      },
    });
    registry.register(slow);
    registry.register(fast);

    const slowHandler = executor.executor.execute(toolCall('call_slow', 'slow', {}), { turnId: 0 });
    const fastHandler = executor.executor.execute(toolCall('call_fast', 'fast', {}), { turnId: 0 });
    const yielded: string[] = [];
    const slowResult = slowHandler.wait().then(() => {
      yielded.push('slow');
    });
    const fastResult = fastHandler.wait().then(() => {
      yielded.push('fast');
    });

    await Promise.all([slowStarted.promise, fastStarted.promise]);
    fastRelease.resolve();
    await fastResult;
    expect(yielded).toEqual(['fast']);

    slowRelease.resolve();
    await slowResult;
    expect(yielded).toEqual(['fast', 'slow']);
    executor.release(slowHandler.taskId);
    executor.release(fastHandler.taskId);

    const detachedRelease = deferred();
    const detachedStarted = deferred();
    const detachedFinalizerStarted = deferred();
    const detachedFinalizerRelease = deferred();
    const conflictingStarted = deferred();
    const nextBatchStarted = deferred();
    const accesses = ToolAccesses.writeFile('/repo/shared.ts');
    const detachedTool = new TestTool('detached', {
      accesses,
      execute: async () => {
        detachedStarted.resolve();
        await detachedRelease.promise;
        return { output: 'detached done' };
      },
    });
    const conflictingTool = new TestTool('conflicting', {
      accesses,
      execute: async () => {
        conflictingStarted.resolve();
        return { output: 'conflicting done' };
      },
    });
    const nextBatchTool = new TestTool('next-batch', {
      accesses,
      execute: async () => {
        nextBatchStarted.resolve();
        return { output: 'next batch done' };
      },
    });
    registry.register(detachedTool);
    registry.register(conflictingTool);
    registry.register(nextBatchTool);

    truncateForModel = async (input) => {
      if (input.toolCallId === 'call_detached') {
        detachedFinalizerStarted.resolve();
        await detachedFinalizerRelease.promise;
      }
      return input.result;
    };
    const detached = executor.executor.execute(toolCall('call_detached', 'detached', {}), { turnId: 1, step: 0 });
    const conflicting = executor.executor.execute(toolCall('call_conflicting', 'conflicting', {}), { turnId: 1, step: 0 });
    const nextBatch = executor.executor.execute(toolCall('call_next_batch', 'next-batch', {}), { turnId: 1, step: 1 });
    await detachedStarted.promise;
    expect(detached.detach('background')).toBeDefined();
    await Promise.all([conflictingStarted.promise, nextBatchStarted.promise]);
    expect(conflictingTool.calls).toHaveLength(1);
    expect(nextBatchTool.calls).toHaveLength(1);
    expect(detached.snapshot().status).toBe('running');

    detachedRelease.resolve();
    await detachedFinalizerStarted.promise;
    detachedFinalizerRelease.resolve();
    await detached.wait();
    await Promise.all([conflicting.wait(), nextBatch.wait()]);
    executor.release(detached.taskId);
    executor.release(conflicting.taskId);
    executor.release(nextBatch.taskId);
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

  it('publishes handler fields and output as tool.updated events', async () => {
    const updates: ToolUpdate[] = [
      { kind: 'stdout', text: 'working' },
      { kind: 'progress', text: 'half', percent: 50 },
    ];
    let created: readonly unknown[] = [];
    const tool = new TestTool('progress', {
      execute: async (ctx) => {
        created = executor.handlers();
        for (const update of updates) ctx.onUpdate?.(update);
        return { output: 'done' };
      },
    });
    registry.register(tool);

    await execute([toolCall('call_progress', 'progress', {})]);

    expect(created).toHaveLength(1);
    const events = protocolEvents.filter((event): event is ToolUpdated => event.type === 'tool.updated');
    const output = events.find((event) => event.output !== undefined);
    expect(output).toMatchObject({
      type: 'tool.updated',
      turnId: 0,
      toolCallId: 'call_progress',
      taskId: (created[0] as { taskId: string }).taskId,
      status: 'running',
      detached: false,
      fields: {},
      output: { offset: 0, text: 'working' },
    });
    expect(events.find((event) => event.fields['progress'] !== undefined)).toMatchObject({
      fields: { progress: { text: 'half', percent: 50 } },
      output: undefined,
    });
    expect(events.at(-1)).toMatchObject({
      status: 'success',
      detached: false,
      output: undefined,
    });
    expect(events.at(-1)?.fields).not.toHaveProperty('result');
    expect(events.at(-1)).not.toHaveProperty('args');
    expect(events.at(-1)).not.toHaveProperty('prepared');
  });

  it('does not start a queued conflicting tool after abort', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const first = new ControlledTool('first', ToolAccesses.writeFile('/repo/a.ts'));
      const second = new ControlledTool('second', ToolAccesses.writeFile('/repo/a.ts'));
      const outcomes = new Map<string, ToolExecutionOutcome>();
      registry.register(first);
      registry.register(second);
      registerLegacyDid(executor, 'capture-outcomes', async (ctx, next) => {
        outcomes.set(ctx.toolCall.id, ctx.outcome);
        await next();
      });

      const execution = execute(
        [toolCall('call_first', 'first', {}), toolCall('call_second', 'second', {})],
        controller.signal,
      );
      await first.started;
      await vi.advanceTimersByTimeAsync(25);
      controller.abort();
      const results = await execution;

      expect(first.calls).toHaveLength(1);
      expect(second.calls).toHaveLength(0);
      expect(outcomes).toEqual(
        new Map([
          ['call_first', 'aborted'],
          ['call_second', 'aborted'],
        ]),
      );
      expect(results).toEqual([
        expect.objectContaining({ output: 'Tool "first" was aborted', isError: true }),
        expect.objectContaining({ output: 'Tool "second" was aborted', isError: true }),
      ]);
      expect([...durations].toSorted((a, b) => a - b)).toEqual([0, 25]);
    } finally {
      vi.useRealTimers();
    }
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
    expect(paired.calls.toSorted()).toEqual(['call_first', 'call_second', 'call_third']);
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
    registerLegacyDid(executor, 'fail-finalize', async () => {
      throw new Error('finalize crashed');
    });

    const results = await execute([toolCall('call_echo', 'echo', { text: 'raw output' })]);

    expect(results).toEqual([
      expect.objectContaining({
        output: 'after-execute hook failed for "echo": finalize crashed',
        isError: true,
      }),
    ]);
    const toolResultEvents = events.filter((event) => event.type === 'tool.result');
    expect(JSON.stringify(toolResultEvents)).not.toContain('raw output');
  });

  it('stops one handler without aborting another handler', async () => {
    const first = new ControlledTool('first', ToolAccesses.readFile('/repo/first.ts'));
    const second = new ControlledTool('second', ToolAccesses.readFile('/repo/second.ts'));
    registry.register(first);
    registry.register(second);
    const firstHandler = executor.executor.execute(toolCall('call_first', 'first', {}), { turnId: 0 });
    const secondHandler = executor.executor.execute(toolCall('call_second', 'second', {}), { turnId: 0 });
    await Promise.all([first.started, second.started]);

    const stopped = await firstHandler.stop('cancel first');
    expect(stopped.outcome.type).toBe('aborted');
    expect(secondHandler.snapshot().status).toBe('running');
    expect((await secondHandler.wait()).outcome.type).toBe('success');
    executor.release(firstHandler.taskId);
    executor.release(secondHandler.taskId);
  });

  it('onDidExecuteTool can replace the final tool result', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    registerLegacyDid(executor, 'replace-result', async (ctx) => {
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
});

describe('onBeforeExecuteTool veto semantics', () => {
  it('applies the first veto and does not run later listeners', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    const later = vi.fn();
    executor.registerLegacyStarting((event) => {
      event.veto({ output: 'first', isError: true });
    });
    executor.registerLegacyStarting((event) => {
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
    executor.registerLegacyStarting((event) => {
      event.allow();
    });
    executor.registerLegacyStarting((event) => {
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
    executor.registerLegacyStarting((event) => {
      event.pass(metadata);
    });

    await execute([toolCall('call_echo', 'echo', { text: 'hi' })]);

    expect(tool.calls[0]).toEqual(expect.objectContaining({ metadata }));
  });

  it('never invokes waitUntil factories when an immediate veto decides the call', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    const askFactory = vi.fn(async () => undefined);
    executor.registerLegacyStarting((event) => {
      event.waitUntil(askFactory);
    });
    executor.registerLegacyStarting((event) => {
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
    executor.registerLegacyStarting((event) => {
      event.waitUntil(async () => {
        fulfilled.push('first');
        return undefined;
      });
    });
    executor.registerLegacyStarting((event) => {
      event.waitUntil(async () => {
        fulfilled.push('second');
        return { veto: { output: 'second-denied', isError: true } };
      });
    });
    executor.registerLegacyStarting((event) => {
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

  it('throws when a statement is made after the statement window closed', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    let captured: BeforeToolExecuteEvent | undefined;
    executor.registerLegacyStarting((event) => {
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
  it('awaits waitUntil work and lets calls through when it returns undefined', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    const gate = deferred<void>();
    registerLegacyWill(executor, (event) => {
      event.waitUntil(gate.promise);
    });

    const pending = execute([toolCall('call_echo', 'echo', { text: 'hi' })]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(tool.calls).toEqual([]);

    gate.resolve();
    const results = await pending;
    expect(results).toEqual([expect.objectContaining({ output: 'hi' })]);
    expect(tool.calls).toHaveLength(1);

    const passed = await execute([toolCall('call_passed', 'echo', { text: 'passed' })]);
    expect(passed).toEqual([expect.objectContaining({ output: 'passed' })]);
    expect(tool.calls).toHaveLength(2);
  });

  it('does not fire for a vetoed call', async () => {
    const tool = new TestTool('echo');
    registry.register(tool);
    const willListener = vi.fn();
    registerLegacyWill(executor, willListener);
    executor.registerLegacyStarting((event) => {
      event.veto({ output: 'nope', isError: true });
    });

    const results = await execute([toolCall('call_echo', 'echo', { text: 'hi' })]);

    expect(results).toEqual([expect.objectContaining({ output: 'nope', isError: true })]);
    expect(willListener).not.toHaveBeenCalled();
  });
});

describe('parseToolCallArguments', () => {
  it('parses valid JSON and treats null or empty arguments as an empty object', () => {
    expect(parseToolCallArguments(null)).toEqual({ data: {}, parseFailed: false });
    expect(parseToolCallArguments('')).toEqual({ data: {}, parseFailed: false });
    expect(parseToolCallArguments('{"text":"hi"}')).toEqual({
      data: { text: 'hi' },
      parseFailed: false,
    });
  });

  it('falls back to an empty object for malformed and unrecoverable JSON', () => {
    expect(parseToolCallArguments('{"text":"hi",}')).toEqual({
      data: {},
      parseFailed: true,
      error: expect.any(String),
    });
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
  let mediaEnvironment: IAgentEnvironmentService;

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
    const environment = Object.assign(new FakeEnvironment(
      { environmentId: 'local', generation: 'test' },
      { capabilities: ['fs', 'process'] },
    ), { fs: new HostFileSystem(), process: globProcess });
    const binding = stubAgentEnvironment(environment);
    mediaEnvironment = binding;
    registry.register(new ReadTool(
      binding,
      stubWorkspaceContext(homeDir),
      { catalog: { getSkillRoots: () => [] } } as unknown as ISessionSkillCatalog,
      truncation,
      readConfig,
      {
        getModelCapabilities: () => ({ image_in: true, video_in: true }),
      } as unknown as IAgentLoopService,
      { isToolActive: () => true } as unknown as IAgentToolPolicyService,
      { resolve: () => ({}) } as unknown as IAgentToolRegistryService,
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
    await readConfig.set('read', { maxChars: 500_000 });
    await readConfig.reload();
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
    const environmentFs = mediaEnvironment.inspect().fs!;
    vi.spyOn(environmentFs, 'stat').mockRejectedValue(new Error('client cannot access daemon storage'));
    vi.spyOn(environmentFs, 'readBytes').mockRejectedValue(new Error('client cannot access daemon storage'));
    vi.spyOn(environmentFs, 'readLines').mockImplementation(() => {
      throw new Error('client cannot access daemon storage');
    });
    registry.register(new ReadMediaFileTool(mediaEnvironment, { workspaceDir: homeDir, additionalDirs: [] }, attachmentStore));
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

  it('reads session text from its owner while workspace text still uses the environment buffer', async () => {
    const environmentFs = mediaEnvironment.inspect().fs!;
    const clientRead = vi.spyOn(environmentFs, 'readLines').mockImplementation(async function* () {
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
    expect(result.note).toBeUndefined();
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

function registerLegacyWill(
  executor: IAgentToolExecutorService,
  listener: (event: WillExecuteToolEvent) => void,
) {
  return executor.registerHook({
    beforeExecute: (context) => runLegacyBeforeExecute(context, listener),
  });
}

function registerLegacyDid(
  executor: IAgentToolExecutorService,
  idOrListener: string | ((context: ToolDidExecuteContext, next: () => Promise<void>) => Promise<void>),
  maybeListener?: (context: ToolDidExecuteContext, next: () => Promise<void>) => Promise<void>,
) {
  const listener = typeof idOrListener === 'string' ? maybeListener! : idOrListener;
  return executor.registerHook({
    afterExecute: async (context) => {
      const legacy = legacyDidExecuteContext(context);
      await listener(legacy, async () => {});
      const converted = toLegacyToolReturn(legacy.result, context.call.name);
      if (converted.outcome === 'failed') {
        return {
          ...context.result,
          content: converted.content,
          outcome: {
            type: 'failed' as const,
            error: {
              outcome: 'failed' as const,
              type: 'error' as const,
              phase: 'after-execute' as const,
              reason: converted.reason,
              data: converted.data,
            },
          },
        };
      }
      return { ...context.result, content: converted.content, outcome: { type: 'success' as const } };
    },
  });
}

function registerUnavailable(
  executor: IAgentToolExecutorService,
  describer: (toolName: string) => string | undefined,
) {
  return executor.registerHook({
    starting: (context) => {
      const text = describer(context.call.name);
      return text === undefined
        ? undefined
        : runLegacyStarting(context, (event) => event.veto({ output: text, isError: true }));
    },
  });
}

function registerGuard(
  executor: IAgentToolExecutorService,
  guard: (tool: { readonly name: string; readonly source: 'builtin' | 'user' | 'mcp' }) => string | undefined,
) {
  return executor.registerHook({
    starting: (context) => {
      const text = guard({ name: context.call.name, source: registry.listReferences().find((entry) => entry.name === context.call.name)?.source ?? 'builtin' });
      return text === undefined
        ? undefined
        : runLegacyStarting(context, (event) => event.veto({ output: text, isError: true }));
    },
  });
}

async function execute(
  calls: ToolCall[],
  signal?: AbortSignal,
  trace?: LLMRequestTrace,
  detach?: (toolCallId: string, text: string) => void,
): Promise<ToolResult[]> {
  return Promise.all(calls.map(async (call) => {
    const handler = executor.executor.execute(call, { turnId: 0, step: 0, trace });
    const onAbort = (): void => {
      void handler.stop(signal?.reason);
    };
    if (signal?.aborted === true) onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await handler;
      if (isToolDetachAck(response)) {
        const text = response.content.map((part) => part.type === 'text' ? part.text : '').join('\n');
        detach?.(call.id, text);
      }
      const final = await handler.wait();
      const snapshot = handler.snapshot();
      const prepared = snapshot.prepared;
      const legacy = prepared?.kind === 'execute' || prepared?.kind === 'synthetic'
        ? prepared.result
        : undefined;
      const result: ToolResult = {
        ...legacy,
        output: final.outcome.type !== 'success'
          ? final.content.every((part) => part.type === 'text')
            ? final.content.map((part) => part.type === 'text' ? part.text : '').join('')
            : final.content
          : (legacy?.output ?? (final.content.every((part) => part.type === 'text')
            ? final.content.map((part) => part.type === 'text' ? part.text : '').join('')
            : final.content)),
        isError: final.outcome.type === 'success' ? legacy?.isError : true,
        description: prepared?.kind === 'execute' ? prepared.description : undefined,
        display: prepared?.kind === 'execute' ? prepared.display : undefined,
        approvalRule: prepared?.kind === 'execute' ? prepared.approvalRule : undefined,
      };
      durations.push(legacyToolDurationMs(snapshot));
      events.push({ type: 'tool.result', toolCallId: call.id, result });
      return result;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      executor.release(handler.taskId);
    }
  }));
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

describe('ToolExecutor handler kernel', () => {
  it('settles success, business failure and invalid args with distinct outcomes and clocks', async () => {
    let wall = 1_000;
    let monotonic = 100;
    const invalidExecute = vi.fn(() => ({ content: textToolContent('must not run') }));
    const executor = new HandlerToolExecutor([
      {
        name: 'success',
        description: 'success',
        parameters: { type: 'object' },
        execute: () => ({ content: textToolContent('done') }),
      },
      {
        name: 'failure',
        description: 'failure',
        parameters: { type: 'object' },
        execute: () => ({
          content: textToolContent('business failure'),
          outcome: 'failed',
          subtype: 'timeout',
          reason: 'invalid business state',
        }),
      },
      {
        name: 'strict',
        description: 'strict',
        parameters: {
          type: 'object',
          properties: { value: { type: 'number' } },
          required: ['value'],
          additionalProperties: false,
        },
        execute: invalidExecute,
      },
    ], {
      now: () => (wall += 1_000),
      tick: () => (monotonic += 5),
    });

    const succeeded = executor.execute(toolCall('success-1', 'success', {}), undefined);
    const successResult = await succeeded.wait();
    expect(successResult).toMatchObject({
      toolCallId: 'success-1',
      content: textToolContent('done'),
      outcome: { type: 'success' },
    });
    const successTiming = succeeded.snapshot().timing;
    expect(successTiming.total.endedAt).not.toBeNull();
    expect(successTiming.total.elapsedMs).toBeGreaterThan(0);
    expect(successTiming.execute?.endedAt).not.toBeNull();
    expect(successTiming.execute?.elapsedMs).toBeGreaterThan(0);

    const failed = executor.execute(toolCall('failure-1', 'failure', {}), undefined);
    expect(failed.taskId).not.toBe(succeeded.taskId);
    expect(await failed.wait()).toMatchObject({
      content: textToolContent('business failure'),
      outcome: {
        type: 'failed',
        error: { type: 'timeout', phase: 'execute', reason: 'invalid business state' },
      },
    });
    expect(failed.snapshot().error).toMatchObject({ outcome: 'failed', type: 'timeout' });

    const invalid = executor.execute(toolCall('strict-1', 'strict', { value: 'bad' }), undefined);
    expect(await invalid.wait()).toMatchObject({
      outcome: { type: 'failed', error: { type: 'invalid', phase: 'validate' } },
    });
    expect(invalidExecute).not.toHaveBeenCalled();
  });

  it('returns a detach ack while wait continues to the real final result', async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const executor = new HandlerToolExecutor([{
      name: 'background',
      description: 'background',
      parameters: { type: 'object' },
      execute: async (context) => {
        context.onDetach((reason) => ({ content: textToolContent(`background: ${String(reason)}`) }));
        started.resolve();
        await release.promise;
        return { content: textToolContent('finished') };
      },
    }]);
    const handler = executor.execute(toolCall('background-1', 'background', {}), undefined);
    const response = Promise.resolve(handler);
    await started.promise;

    const ack = handler.detach('later');
    expect(ack).toBeDefined();
    expect(isToolDetachAck(ack!)).toBe(true);
    expect(ack).toMatchObject({
      detached: true,
      taskId: handler.taskId,
      content: textToolContent('background: later'),
    });
    expect(await response).toEqual(ack);
    await expect(Promise.race([
      handler.wait(5),
      new Promise((resolve) => setTimeout(() => resolve('still pending'), 25)),
    ])).rejects.toMatchObject({ name: 'ToolTimeoutError' });
    await expect(Promise.race([
      handler.wait(5),
      new Promise((resolve) => setTimeout(() => resolve('still pending'), 25)),
    ])).rejects.toMatchObject({ name: 'ToolTimeoutError' });
    const controller = new AbortController();
    const reason = new Error('stop waiting only');
    const aborted = Promise.race([
      handler.wait(undefined, controller.signal),
      new Promise((resolve) => setTimeout(() => resolve('still pending'), 25)),
    ]);
    controller.abort(reason);
    await expect(aborted).rejects.toBe(reason);
    expect(handler.snapshot()).toMatchObject({ status: 'running', detached: true });
    let completed = false;
    void handler.wait().then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    release.resolve();
    expect(await handler.wait(1_000)).toMatchObject({
      content: textToolContent('finished'),
      outcome: { type: 'success' },
    });
    expect(handler.snapshot()).toMatchObject({ detached: true, status: 'success' });
  });

  it('stops one execution through its internal signal without aborting another', async () => {
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const secondRelease = deferred<void>();
    let secondSignal: AbortSignal | undefined;
    const executor = new HandlerToolExecutor([
      {
        name: 'first',
        description: 'first',
        parameters: { type: 'object' },
        execute: async (context) => {
          firstStarted.resolve();
          return new Promise((resolve) => {
            context.signal.addEventListener('abort', () => {
              resolve({ content: textToolContent('first stopped') });
            }, { once: true });
          });
        },
      },
      {
        name: 'second',
        description: 'second',
        parameters: { type: 'object' },
        execute: async (context) => {
          secondSignal = context.signal;
          secondStarted.resolve();
          await secondRelease.promise;
          return { content: textToolContent('second finished') };
        },
      },
    ]);
    const first = executor.execute(toolCall('first-1', 'first', {}), undefined);
    const second = executor.execute(toolCall('second-1', 'second', {}), undefined);
    await Promise.all([firstStarted.promise, secondStarted.promise]);

    expect(await first.stop('cancel first')).toMatchObject({
      content: textToolContent('first stopped'),
      outcome: { type: 'aborted', error: { type: 'stopped', reason: 'cancel first' } },
    });
    expect(secondSignal?.aborted).toBe(false);
    expect(second.snapshot().status).toBe('running');
    expect((await first.stop('already stopped')).outcome).toMatchObject({ type: 'aborted' });
    expect(secondSignal?.aborted).toBe(false);

    secondRelease.resolve();
    expect((await second.wait()).outcome.type).toBe('success');
  });

  it('calls stopping once and uses asynchronous abandon as its final fallback', async () => {
    const started = deferred<void>();
    const abandon = deferred<void>();
    let stoppingCalls = 0;
    const executor = new HandlerToolExecutor([{
      name: 'hanging',
      description: 'hanging',
      parameters: { type: 'object' },
      execute: async () => {
        started.resolve();
        return new Promise<never>(() => {});
      },
      stopping: (context) => {
        stoppingCalls += 1;
        void abandon.promise.then(() => {
          context.abandon({ content: textToolContent('abandoned fallback') });
          context.abandon({ content: textToolContent('duplicate abandon') });
        });
      },
    }]);
    const handler = executor.execute(toolCall('hanging-1', 'hanging', {}), undefined);
    let finalChanges = 0;
    handler.observe((event) => {
      if (event.type === 'change' && event.snapshot.status === 'aborted') finalChanges += 1;
    });
    await started.promise;

    const stopping = handler.stop('halt');
    const repeatedStop = handler.stop('halt again');
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(stoppingCalls).toBe(1);
    expect(repeatedStop).toBe(stopping);

    abandon.resolve();
    expect(await stopping).toMatchObject({
      content: textToolContent('abandoned fallback'),
      outcome: { type: 'aborted', error: { type: 'abandoned', reason: 'halt' } },
    });
    expect(await repeatedStop).toMatchObject({
      outcome: { type: 'aborted', error: { type: 'abandoned' } },
    });
    expect(stoppingCalls).toBe(1);
    expect(finalChanges).toBe(1);
  });

  it('composes hooks in order and seals responses after execute settles', async () => {
    const events: string[] = [];
    const afterEntered = deferred<void>();
    const afterRelease = deferred<void>();
    const first = {
      label: 'first',
      starting() {
        events.push(`${this.label}:starting`);
        return { skipPermitting: true as const };
      },
      beforeExecute() {
        events.push(`${this.label}:before`);
      },
      afterExecute(context: { result: HandlerToolResult }) {
        events.push(`${this.label}:after`);
        return { ...context.result, content: textToolContent('first rewrite') };
      },
      observe(event: { type: string }) {
        if (event.type === 'created') events.push(`${this.label}:observe`);
      },
    };
    const second = {
      label: 'second',
      starting() {
        events.push(`${this.label}:starting`);
      },
      permitting() {
        events.push(`${this.label}:permitting`);
      },
      beforeExecute() {
        events.push(`${this.label}:before`);
      },
      async afterExecute(context: { result: HandlerToolResult }) {
        expect(context.result.content).toEqual(textToolContent('first rewrite'));
        events.push(`${this.label}:after`);
        afterEntered.resolve();
        await afterRelease.promise;
        return { ...context.result, content: textToolContent('second rewrite') };
      },
      observe(event: { type: string }) {
        if (event.type === 'created') events.push(`${this.label}:observe`);
      },
    };
    let executionSignal: AbortSignal | undefined;
    const executor = new HandlerToolExecutor([{
      name: 'hooked',
      description: 'hooked',
      parameters: { type: 'object' },
      execute: (context) => {
        executionSignal = context.signal;
        events.push('execute');
        return { content: textToolContent('raw') };
      },
    }], { hook: composeToolExecutorHooks([first, second]) });

    const handler = executor.execute(toolCall('hooked-1', 'hooked', {}), undefined);
    const response = Promise.resolve(handler);
    await afterEntered.promise;
    const lateStop = handler.stop('late stop');
    expect(handler.detach('late detach')).toBeUndefined();
    expect(executionSignal?.aborted).toBe(false);
    expect(handler.snapshot().stopReason).toBeUndefined();
    afterRelease.resolve();
    expect(await lateStop).toMatchObject({
      content: textToolContent('second rewrite'),
      outcome: { type: 'success' },
    });
    const final = await response;
    expect(isToolDetachAck(final)).toBe(false);
    expect(final).toMatchObject({
      content: textToolContent('second rewrite'),
      outcome: { type: 'success' },
    });
    expect(events).toEqual([
      'first:observe',
      'second:observe',
      'first:starting',
      'first:before',
      'second:before',
      'execute',
      'first:after',
      'second:after',
    ]);

    const entered = deferred<void>();
    const release = deferred<void>();
    const preHookEvents: string[] = [];
    const execute = vi.fn(() => ({ content: textToolContent('must not run') }));
    const rawHook = {
      label: 'raw-hook',
      starting: async function () {
        expect(this.label).toBe('raw-hook');
        preHookEvents.push('starting');
        entered.resolve();
        await release.promise;
      },
      afterExecute: () => {
        preHookEvents.push('after');
      },
    };
    const stoppedExecutor = new HandlerToolExecutor([{
      name: 'pre-hook-stop',
      description: 'pre-hook-stop',
      parameters: { type: 'object' },
      execute,
    }], { hook: rawHook });
    const stoppedHandler = stoppedExecutor.execute(
      toolCall('pre-hook-stop-1', 'pre-hook-stop', {}),
      undefined,
    );
    await entered.promise;
    const stopping = stoppedHandler.stop('stop before execute');
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(preHookEvents).toEqual(['starting']);
    release.resolve();
    expect((await stopping).outcome.type).toBe('aborted');
    expect(preHookEvents).toEqual(['starting', 'after']);
    expect(execute).not.toHaveBeenCalled();
  });

  it('reads fields and output mid-run and surfaces flush and close errors', async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const store = memoryOutputStore();
    const outputStore = {
      open(taskId: string) {
        const output = store.open(taskId);
        return {
          append: (chunk: string) => output.append(chunk),
          preview: (maxBytes?: number) => output.preview(maxBytes),
          read: (offset: number, maxBytes: number) => output.read(offset, maxBytes),
          flush: async () => {
            await output.flush();
            throw new Error('flush failed');
          },
          close: async () => {
            await output.close();
            throw new Error('close failed');
          },
          error: () => output.error(),
        };
      },
    };
    const executor = new HandlerToolExecutor([{
      name: 'output',
      description: 'output',
      parameters: { type: 'object' },
      execute: async (context) => {
        expect(context.write('abc')).toBe(0);
        expect(context.write('def')).toBe(3);
        context.set({ status: 'working', progress: { percent: 50 } });
        started.resolve();
        await release.promise;
        try {
          await context.flush();
        } catch (error) {
          context.set({ flushError: error instanceof Error ? error.message : String(error) });
        }
        return { content: textToolContent('done') };
      },
    }], { outputStore });
    const handler = executor.execute(toolCall('output-1', 'output', {}), undefined);
    const offsets: number[] = [];
    handler.observe((event) => {
      if (event.type === 'output') offsets.push(event.offset);
    });
    await started.promise;

    expect(handler.output()).toMatchObject({ totalBytes: 6, preview: 'abcdef' });
    expect(handler.fields()).toMatchObject({ status: 'working', progress: { percent: 50 } });
    release.resolve();
    expect(await handler.wait()).toMatchObject({
      outcome: { type: 'failed', error: { type: 'output', data: 'close failed' } },
    });
    expect(handler.fields()).toMatchObject({ flushError: 'flush failed' });
    expect(handler.snapshot().outputError).toBe('close failed');
    expect(offsets).toEqual([0, 3]);
  });

  it('reopens file output after close with restored bytes, offsets, preview and reads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tool-output-store-'));
    try {
      const initial = fileOutputStore(directory).open('restart-task');
      expect(initial.append('hello ')).toBe(0);
      expect(initial.append('世界')).toBe(6);
      await initial.close();

      const reopened = fileOutputStore(directory).open('restart-task');
      expect(reopened.preview()).toMatchObject({
        totalBytes: 12,
        preview: 'hello 世界',
        path: join(directory, 'restart-task.log'),
      });
      expect(await reopened.read(0, 5)).toBe('hello');
      expect(reopened.append('!')).toBe(12);
      await reopened.close();

      const reader = fileOutputStore(directory).open('restart-task');
      expect(reader.preview()).toMatchObject({ totalBytes: 13, preview: 'hello 世界!' });
      expect(await reader.read(6, 6)).toBe('世界');
      expect(await reader.read(12, 1)).toBe('!');
      await reader.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('runs legacy preparation, finalization, synthetic short-circuiting and updates', async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const steerSignal = new AbortController().signal;
    const remind = vi.fn();
    const legacy: ExecutableTool<Record<string, unknown>> = {
      name: 'legacy',
      description: 'legacy',
      parameters: { type: 'object', additionalProperties: true },
      resolveExecution(args) {
        if (args['synthetic'] === 'success') {
          return {
            output: 'synthetic success',
            note: 'success note',
            spill: { outputPath: '/unused' },
          } as unknown as ToolExecution;
        }
        if (args['synthetic'] === true) {
          return {
            output: 'synthetic failure',
            isError: true,
            stopTurn: true,
            note: 'legacy note',
            spill: { outputPath: '/unused' },
          };
        }
        return {
          approvalRule: 'legacy-rule',
          description: 'prepared description',
          display: { kind: 'generic', summary: 'legacy summary' },
          accesses: ToolAccesses.readFile('/repo'),
          matchesRule: (rule) => rule === 'yes',
          execute: async (context) => {
            expect(context.turnId).toBe(9);
            expect(context.trace).toEqual({ requestId: 'trace-legacy' });
            expect(context.metadata).toEqual({ source: 'test' });
            expect(context.steerSignal).toBe(steerSignal);
            expect(context.remind).toBe(remind);
            context.onUpdate?.({ kind: 'stdout', text: 'out-' });
            context.onUpdate?.({ kind: 'stderr', text: 'err' });
            context.onUpdate?.({ kind: 'status', text: 'working' });
            context.onUpdate?.({ kind: 'progress', text: 'half', percent: 50 });
            context.onUpdate?.({
              kind: 'custom',
              fields: { oauth: { url: 'https://example.com' } },
            });
            context.detach?.('legacy background');
            started.resolve();
            await release.promise;
            return {
              output: [{ type: 'text', text: 'legacy final' }],
              stopTurn: true,
              note: 'legacy note',
              spill: { outputPath: '/unused' },
            };
          },
        };
      },
    };
    const finalizerCalls: string[] = [];
    const adapter = new LegacyExecutableToolAdapter(legacy, async ({ toolName, toolCallId, result }) => {
      expect(toolName).toBe('legacy');
      expect(result.spill?.outputPath).toBe('/unused');
      finalizerCalls.push(toolCallId);
      if (result.isError === true) {
        return {
          ...result,
          output: 'finalized synthetic failure',
          note: 'finalized note',
          truncated: true,
        };
      }
      return result;
    });
    const preparations: LegacyToolPreparation[] = [];
    const afterPrepared: LegacyToolPreparation[] = [];
    let startingCalls = 0;
    let permittingCalls = 0;
    const executor = new HandlerToolExecutor([adapter], {
      hook: {
        starting: () => {
          startingCalls += 1;
        },
        permitting: () => {
          permittingCalls += 1;
        },
        beforeExecute: (context) => {
          preparations.push(context.prepared as LegacyToolPreparation);
        },
        afterExecute: (context) => {
          afterPrepared.push(context.prepared as LegacyToolPreparation);
        },
      },
    });
    const agentContext = {
      turnId: 9,
      trace: { requestId: 'trace-legacy' },
      metadata: { source: 'test' },
      steerSignal,
      remind,
    };
    const handler = executor.execute(toolCall('legacy-1', 'legacy', {}), agentContext);
    await started.promise;

    const prepared = preparations[0];
    expect(prepared).toMatchObject({
      kind: 'execute',
      approvalRule: 'legacy-rule',
      description: 'prepared description',
      display: { kind: 'generic', summary: 'legacy summary' },
      accesses: ToolAccesses.readFile('/repo'),
    });
    if (prepared?.kind !== 'execute') throw new Error('expected runnable legacy preparation');
    expect(prepared.execution.execute).toBeTypeOf('function');
    expect(prepared.matchesRule?.('yes')).toBe(true);
    expect(handler.output()).toMatchObject({ totalBytes: 7, preview: 'out-err' });
    expect(handler.fields()).toMatchObject({
      status: 'working',
      progress: { text: 'half', percent: 50 },
      oauth: { url: 'https://example.com' },
    });
    const ack = await handler;
    expect(isToolDetachAck(ack)).toBe(true);
    expect(ack).toMatchObject({ content: textToolContent('legacy background') });

    release.resolve();
    const final = await handler.wait();
    expect(final).toMatchObject({
      content: [
        ...textToolContent('legacy final'),
        ...textToolContent('legacy note'),
      ],
      outcome: { type: 'success' },
    });
    expect(final).not.toHaveProperty('stopTurn');
    expect(final).not.toHaveProperty('note');
    expect(final).not.toHaveProperty('spill');

    const synthetic = executor.execute(
      toolCall('legacy-2', 'legacy', { synthetic: true }),
      agentContext,
    );
    expect(await synthetic.wait()).toMatchObject({
      content: [
        ...textToolContent('finalized synthetic failure'),
        ...textToolContent('finalized note'),
      ],
      outcome: { type: 'failed', error: { type: 'error' } },
    });
    const successfulSynthetic = executor.execute(
      toolCall('legacy-3', 'legacy', { synthetic: 'success' }),
      agentContext,
    );
    expect(await successfulSynthetic.wait()).toMatchObject({
      content: [
        ...textToolContent('synthetic success'),
        ...textToolContent('success note'),
      ],
      outcome: { type: 'success' },
    });
    expect(startingCalls).toBe(1);
    expect(permittingCalls).toBe(1);
    expect(preparations).toHaveLength(1);
    expect(afterPrepared.map((item) => item.kind)).toEqual(['execute', 'synthetic', 'synthetic']);
    expect(finalizerCalls).toEqual(['legacy-1', 'legacy-2', 'legacy-3']);

    const replacement = new LegacyExecutableToolAdapter(legacy);
    executor.addExecute(replacement);
    expect(executor.removeExecute(adapter)).toBe(false);
    expect(executor.list()).toEqual([replacement]);
    expect(executor.removeExecute(replacement)).toBe(true);
    expect(executor.list()).toEqual([]);

    const slowResolve = deferred<void>();
    const slowFinalize = deferred<void>();
    const slowFinalizerEntered = deferred<void>();
    let syntheticNow = 0;
    const slowSyntheticExecutor = new HandlerToolExecutor([
      new LegacyExecutableToolAdapter({
        name: 'slow-synthetic',
        description: 'slow-synthetic',
        parameters: { type: 'object' },
        resolveExecution: async () => {
          await slowResolve.promise;
          return { output: 'slow synthetic' } as unknown as ToolExecution;
        },
      }, async ({ result }) => {
        slowFinalizerEntered.resolve();
        await slowFinalize.promise;
        return result;
      }, () => syntheticNow),
    ]);
    const slowSynthetic = slowSyntheticExecutor.execute(
      toolCall('slow-synthetic-1', 'slow-synthetic', {}),
      agentContext,
    );
    syntheticNow = 100;
    slowResolve.resolve();
    await slowFinalizerEntered.promise;
    syntheticNow = 200;
    slowFinalize.resolve();
    await slowSynthetic.wait();
    expect(legacyToolDurationMs(slowSynthetic.snapshot())).toBe(0);
    expect(slowSynthetic.snapshot().timing.execute).toBeNull();

    vi.useFakeTimers();
    let legacyNow = 0;
    const advance = async (ms: number): Promise<void> => {
      legacyNow += ms;
      await vi.advanceTimersByTimeAsync(ms);
    };
    try {
      const cooperativeStarted = deferred<void>();
      const cooperativeFinalizerStarted = deferred<void>();
      const hangingStarted = deferred<void>();
      const slowExecutionStarted = deferred<void>();
      const slowFinalizerStarted = deferred<void>();
      const finalizerRelease = deferred<void>();
      const slowFinalizerRelease = deferred<void>();
      const cancellable: ExecutableTool<Record<string, unknown>> = {
        name: 'cancellable',
        description: 'cancellable',
        parameters: { type: 'object', additionalProperties: true },
        resolveExecution: (args) => ({
          approvalRule: 'cancellable',
          execute: async ({ signal, toolCallId }) => {
            if (toolCallId === 'slow-finalizer-1') slowExecutionStarted.resolve();
            if (args['hang'] === true) {
              hangingStarted.resolve();
              return new Promise<never>(() => {});
            }
            cooperativeStarted.resolve();
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener('abort', () => resolve(), { once: true });
            });
            return { output: 'cooperative output' };
          },
        }),
      };
      const finalizerCalls: string[] = [];
      const afterExecuteCalls: string[] = [];
      const cancellingExecutor = new HandlerToolExecutor([
        new LegacyExecutableToolAdapter(cancellable, async ({ toolCallId, result }) => {
          finalizerCalls.push(toolCallId);
          if (toolCallId === 'slow-finalizer-1') {
            slowFinalizerStarted.resolve();
            await slowFinalizerRelease.promise;
          } else {
            if (toolCallId === 'cooperative-1') cooperativeFinalizerStarted.resolve();
            await finalizerRelease.promise;
          }
          return { ...result, output: 'finalized cooperative output' };
        }, () => legacyNow),
      ], {
        hook: {
          afterExecute: (context) => {
            afterExecuteCalls.push(context.call.id);
          },
        },
      });
      const cooperative = cancellingExecutor.execute(
        toolCall('cooperative-1', 'cancellable', {}),
        agentContext,
      );
      const hanging = cancellingExecutor.execute(
        toolCall('hanging-1', 'cancellable', { hang: true }),
        agentContext,
      );
      await Promise.all([cooperativeStarted.promise, hangingStarted.promise]);

      const stopping = cooperative.stop('stop cooperative');
      const repeatedStop = cooperative.stop('stop cooperative again');
      const hangingStop = hanging.stop('stop hanging');
      const repeatedHangingStop = hanging.stop('stop hanging again');
      let cooperativeSettled = false;
      let hangingSettled = false;
      void stopping.then(() => {
        cooperativeSettled = true;
      });
      void hangingStop.then(() => {
        hangingSettled = true;
      });
      await Promise.resolve();
      expect(cooperativeSettled).toBe(false);
      expect(hangingSettled).toBe(false);
      expect(repeatedStop).toBe(stopping);
      expect(repeatedHangingStop).toBe(hangingStop);
      await cooperativeFinalizerStarted.promise;

      await advance(1_999);
      expect(cooperativeSettled).toBe(false);
      expect(hangingSettled).toBe(false);
      finalizerRelease.resolve();
      await expect(stopping).resolves.toMatchObject({
        content: textToolContent('finalized cooperative output'),
        outcome: { type: 'aborted', error: { type: 'stopped', reason: 'stop cooperative' } },
      });
      expect(finalizerCalls).toEqual(['cooperative-1']);
      expect(legacyToolDurationMs(cooperative.snapshot())).toBe(0);

      await advance(1);
      await expect(hangingStop).resolves.toMatchObject({
        outcome: { type: 'aborted', error: { type: 'abandoned', reason: 'stop hanging' } },
      });
      expect(cooperative.snapshot().error).toMatchObject({ type: 'stopped' });
      expect(hanging.snapshot().error).toMatchObject({ type: 'abandoned' });
      expect(legacyToolDurationMs(hanging.snapshot())).toBe(2_000);

      const slowFinalizer = cancellingExecutor.execute(
        toolCall('slow-finalizer-1', 'cancellable', {}),
        agentContext,
      );
      await slowExecutionStarted.promise;
      let slowSettlements = 0;
      let slowAbandons = 0;
      slowFinalizer.observe((event) => {
        if (
          event.type === 'change' &&
          event.previous.error?.type !== 'abandoned' &&
          event.snapshot.error?.type === 'abandoned'
        ) slowAbandons += 1;
      });
      const slowSettled = slowFinalizer.wait().then((result) => {
        slowSettlements += 1;
        return result;
      });
      await advance(100);
      const slowStopping = slowFinalizer.stop('stop slow finalizer');
      await slowFinalizerStarted.promise;
      await advance(1_999);
      expect(slowSettlements).toBe(0);
      expect(slowAbandons).toBe(0);
      await advance(1);
      await expect(slowSettled).resolves.toMatchObject({
        outcome: { type: 'aborted', error: { type: 'abandoned', reason: 'stop slow finalizer' } },
      });
      await expect(slowStopping).resolves.toMatchObject({
        outcome: { type: 'aborted', error: { type: 'abandoned' } },
      });
      expect(slowAbandons).toBe(1);
      expect(legacyToolDurationMs(slowFinalizer.snapshot())).toBe(100);
      expect(afterExecuteCalls.filter((id) => id === 'slow-finalizer-1')).toHaveLength(1);

      slowFinalizerRelease.resolve();
      await advance(100);
      expect(slowSettlements).toBe(1);
      expect(slowAbandons).toBe(1);
      expect(legacyToolDurationMs(slowFinalizer.snapshot())).toBe(100);
      expect(afterExecuteCalls.filter((id) => id === 'slow-finalizer-1')).toHaveLength(1);
      expect(finalizerCalls.filter((id) => id === 'slow-finalizer-1')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
