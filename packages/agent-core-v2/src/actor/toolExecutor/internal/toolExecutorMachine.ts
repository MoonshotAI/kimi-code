import { enqueueActions, fromCallback, setup, type Snapshot } from 'xstate';

import type { IDisposable } from '#/_base/di/lifecycle';
import { AsyncEmitter, Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import type { AgentRuntimeContext, AgentRuntimeRestoreEvent } from '#/actor/agentRuntime';
import { IAgentHostService, type AgentHost } from '#/agent/host/agentHost';
import { IGitService } from '#/app/git/git';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMcpHandle } from '#/session/mcp/sessionMcpHandle';
import { ISessionToolResultTruncationService } from '#/agent/toolResultTruncation/sessionToolResultTruncationService';
import { getLoopControl } from '#/actor/loop/internal/access';
import { TurnEnded } from '#/actor/loop/turnOps';
import { ContextSpliced } from '#/actor/contextMemory/contextEvents';
import { CompactionCompleted } from '#/actor/fullCompaction/fullCompactionEvents';
import { activateReminderWhenReady } from '#/actor/reminder/internal/reminderActivation';
import { mcpDiscoveryKey } from '#/agent/mcp/mcpDiscoveryOps';
import { IAgentToolContributionSource } from '#/agent/toolRegistry/toolContributionSourceService';
import type {
  AgentToolContribution as AgentToolContributionRecord,
  AgentToolFactoryContext,
  AgentToolProviderContribution,
} from '#/agent/toolRegistry/toolContribution';
import {
  DYNAMIC_TOOL_SCHEMA_VARIANT,
  LOADABLE_TOOLS_VARIANT,
} from '#/agent/toolSelect/dynamicTools';
import type { ToolCall } from '#/kosong/contract/message';
import type { ExecutableToolResult, ToolAccesses } from '#/tool/toolContract';
import { ToolAccesses as ToolAccessesValue } from '#/tool/toolContract';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import {
  PERMISSION_GATE_PARTICIPANT,
  TOOL_DEDUPE_PARTICIPANT,
  type ActiveToolCall,
  type MissingToolDescriber,
  type ToolCallDupType,
  type ToolCallGuard,
  type ToolExecutionFinishedEvent,
  type ToolExecutionResult,
  type ToolExecutorExecuteOptions,
  type UnavailableToolDescriber,
} from '#/actor/toolExecutor/toolExecutor';
import { SELECT_TOOLS_TOOL_NAME } from '#/actor/toolExecutor/toolSelection';
import type { WillExecuteToolEvent } from '#/actor/toolExecutor/toolHooks';

import { BeforeToolExecuteBus } from '#/actor/toolExecutor/internal/beforeToolExecute';
import { DidExecuteHookRegistry } from '#/actor/toolExecutor/internal/participants';
import {
  catalogListReferences,
  catalogViewOf,
  createToolCatalogState,
  disposeCatalog,
  reconcileCatalogContributions,
  resolveCatalogTool,
  setCatalogSource,
  type CatalogContributionDeps,
  type CatalogSourceEntry,
  type ToolCatalogState,
} from '#/actor/toolExecutor/internal/catalog';
import {
  preflightToolCall,
  type ToolCallPipelineDeps,
} from '#/actor/toolExecutor/internal/executor';
import {
  createMcpState,
  flushPendingMcpDiscoveries,
  handleMcpServerStatusChange,
  mcpDiscoveryWritesReadyKey,
  mcpMcpToolsByServerKey,
  mcpWaitForInitialLoad,
  type McpDeps,
  type McpState,
} from '#/actor/toolExecutor/internal/mcpToolProvider';
import type { McpServerEntry } from '#/mcpCore/connection-manager';
import { ToolExecutionPermissionGatePolicy } from '#/actor/toolExecutor/internal/permissionGate';
import { ToolExecutionPermissionPolicyChain } from '#/actor/toolExecutor/internal/permissionPolicy';
import { AgentToolsSelection } from '#/actor/toolExecutor/internal/selection';
import {
  createToolDedupeState,
  dedupeBeginStep,
  dedupeCheck,
  dedupeClearTurnRecords,
  dedupeEndStep,
  dedupeFinalize,
  dedupeRegisterSkipped,
  dedupeResetDupTypes,
  dedupeTakeDupType,
  type ToolDedupeCallInput,
  type ToolDedupeFinalization,
  type ToolDedupeResult,
  type ToolDedupeState,
} from '#/actor/toolExecutor/internal/toolDedupe';
import { AgentToolsPolicy } from '#/actor/toolExecutor/internal/toolPolicy';
import {
  toolCallLogic,
  type ToolCallActorRef,
  type ToolCallParentNotice,
} from '#/actor/toolExecutor/internal/toolCallMachine';

export class BatchStream {
  private readonly buffer: ToolExecutionResult[] = [];
  private waiter: ((step: IteratorResult<ToolExecutionResult, undefined>) => void) | undefined;
  private waiterReject: ((error: unknown) => void) | undefined;
  private done = false;
  private failure: { readonly error: unknown } | undefined;
  private settle!: () => void;
  readonly settled = new Promise<void>((resolve) => {
    this.settle = resolve;
  });

  push(result: ToolExecutionResult): void {
    const waiter = this.waiter;
    if (waiter !== undefined) {
      this.waiter = undefined;
      this.waiterReject = undefined;
      waiter({ done: false, value: result });
      return;
    }
    this.buffer.push(result);
  }

  end(): void {
    this.done = true;
    this.settle();
    const waiter = this.waiter;
    if (waiter !== undefined) {
      this.waiter = undefined;
      this.waiterReject = undefined;
      waiter({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    this.done = true;
    this.failure = { error };
    this.settle();
    const reject = this.waiterReject;
    if (reject !== undefined) {
      this.waiter = undefined;
      this.waiterReject = undefined;
      reject(error);
    }
  }

  next(): Promise<IteratorResult<ToolExecutionResult, undefined>> {
    const buffered = this.buffer.shift();
    if (buffered !== undefined) return Promise.resolve({ done: false, value: buffered });
    if (this.failure !== undefined) return Promise.reject(this.failure.error as Error);
    if (this.done) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => {
      this.waiter = resolve;
      this.waiterReject = reject;
    });
  }
}

type BatchCallStatus =
  | 'pending'
  | 'preparing'
  | 'ready'
  | 'running'
  | 'finalizing'
  | 'done'
  | 'failed'
  | 'cancelled';

interface BatchCall {
  readonly index: number;
  readonly ref: ToolCallActorRef;
  status: BatchCallStatus;
  accesses: ToolAccesses | undefined;
}

export interface BatchRecord {
  readonly batchId: number;
  readonly options: ToolExecutorExecuteOptions;
  readonly calls: BatchCall[];
  prepareCursor: number;
  stopBatch: boolean;
  error: { readonly cause: unknown } | undefined;
  readonly stream: BatchStream;
}

interface MutableSlot<T> {
  current: T | undefined;
}

export interface ToolExecutorMachineContext {
  readonly runtime: AgentRuntimeContext<unknown>;
  readonly host: AgentHost;
  readonly catalog: ToolCatalogState;
  readonly catalogDeps: CatalogContributionDeps;
  readonly policy: AgentToolsPolicy;
  readonly selection: AgentToolsSelection;
  readonly vetoBus: BeforeToolExecuteBus;
  readonly didHooks: DidExecuteHookRegistry;
  readonly willExecuteEmitter: AsyncEmitter<WillExecuteToolEvent>;
  readonly didExecuteEmitter: Emitter<ToolExecutionFinishedEvent>;
  readonly guardSlot: MutableSlot<ToolCallGuard>;
  readonly unavailableDescriberSlot: MutableSlot<UnavailableToolDescriber>;
  readonly missingDescriberSlot: MutableSlot<MissingToolDescriber>;
  readonly dedupe: ToolDedupeState;
  readonly mcp: McpState;
  readonly mcpDeps: McpDeps;
  readonly callDeps: ToolCallPipelineDeps;
  readonly batches: Map<number, BatchRecord>;
  nextBatchId: number;
  activeCalls: readonly ActiveToolCall[];
  readonly activeCallsEmitter: Emitter<readonly ActiveToolCall[]>;
}

export type ToolExecutorMachineSnapshot = Snapshot<unknown> & {
  readonly context: ToolExecutorMachineContext;
};

export interface ToolCallStartedInternalEvent {
  readonly type: 'toolExecutor.callStarted';
  readonly call: ActiveToolCall;
}

export interface ToolCallSettledInternalEvent {
  readonly type: 'toolExecutor.callSettled';
  readonly toolCallId: string;
}

export interface ToolExecutorExecuteEvent {
  readonly type: 'toolExecutor.executeBatch';
  readonly calls: readonly ToolCall[];
  readonly options: ToolExecutorExecuteOptions;
  readonly reply: { stream?: BatchStream };
}

interface DedupeCheckEvent {
  readonly type: 'toolExecutor.dedupeCheck';
  readonly input: ToolDedupeCallInput;
  readonly reply: { syntheticResult?: ToolDedupeResult | null };
}

interface DedupeRegisterSkippedEvent {
  readonly type: 'toolExecutor.dedupeRegisterSkipped';
  readonly input: ToolDedupeCallInput;
  readonly rawArguments: unknown;
}

interface DedupeFinalizeEvent {
  readonly type: 'toolExecutor.dedupeFinalize';
  readonly input: ToolDedupeCallInput;
  readonly result: ToolDedupeResult;
  readonly reply: { finalization?: ToolDedupeFinalization };
}

interface DedupeStepBeginEvent {
  readonly type: 'toolExecutor.dedupeStepBegin';
  readonly turnId?: number;
  readonly step?: number;
}

interface DedupeStepEndEvent {
  readonly type: 'toolExecutor.dedupeStepEnd';
}

interface DedupeTurnEndedEvent {
  readonly type: 'toolExecutor.dedupeTurnEnded';
}

interface DupTypeTakeEvent {
  readonly type: 'toolExecutor.dupTypeTake';
  readonly toolCallId: string;
  readonly reply: { dupType?: ToolCallDupType };
}

interface CatalogReconcileEvent {
  readonly type: 'toolExecutor.catalogReconcile';
  readonly records: readonly AgentToolContributionRecord[];
}

interface CatalogSourceSetEvent {
  readonly type: 'toolExecutor.catalogSourceSet';
  readonly owner: unknown;
  readonly entries: readonly CatalogSourceEntry[];
}

interface McpStatusEvent {
  readonly type: 'toolExecutor.mcpStatus';
  readonly entry: McpServerEntry;
}

interface McpFlushDiscoveriesEvent {
  readonly type: 'toolExecutor.mcpFlushDiscoveries';
}

export type ToolExecutorMachineEvent =
  | ToolCallStartedInternalEvent
  | ToolCallSettledInternalEvent
  | ToolExecutorExecuteEvent
  | ToolCallParentNotice
  | DedupeCheckEvent
  | DedupeRegisterSkippedEvent
  | DedupeFinalizeEvent
  | DedupeStepBeginEvent
  | DedupeStepEndEvent
  | DedupeTurnEndedEvent
  | DupTypeTakeEvent
  | CatalogReconcileEvent
  | CatalogSourceSetEvent
  | McpStatusEvent
  | McpFlushDiscoveriesEvent
  | AgentRuntimeRestoreEvent;

export function toolExecutorMachineOf(
  runtime: AgentRuntimeContext<unknown>,
): ToolExecutorMachineContext {
  return runtime.getLogicState<ToolExecutorMachineContext>();
}

function dedupeCallInputOf(input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly trace: LLMRequestTrace | undefined;
}): ToolDedupeCallInput {
  return input;
}

function buildMachineContext(runtime: AgentRuntimeContext<unknown>): ToolExecutorMachineContext {
  const host = runtime.get(IAgentHostService).of(runtime.agent);
  const catalog = createToolCatalogState();
  const policy = new AgentToolsPolicy(runtime);
  const selection = new AgentToolsSelection(runtime, catalogViewOf(catalog), policy);
  const vetoBus = new BeforeToolExecuteBus();
  const didHooks = new DidExecuteHookRegistry();
  const willExecuteEmitter = new AsyncEmitter<WillExecuteToolEvent>();
  const didExecuteEmitter = new Emitter<ToolExecutionFinishedEvent>();

  const guardSlot: MutableSlot<ToolCallGuard> = {
    current: ({ name, source }) => {
      const active =
        name === SELECT_TOOLS_TOOL_NAME
          ? policy.isActiveForDisclosure(name, source)
          : policy.isActive(name, source);
      return active ? undefined : `Tool "${name}" is disabled by the active tool policy`;
    },
  };
  const unavailableDescriberSlot: MutableSlot<UnavailableToolDescriber> = {
    current: (name) => selection.describeUnavailableTool(name),
  };
  const missingDescriberSlot: MutableSlot<MissingToolDescriber> = {
    current: (name) => selection.describeMissingTool(name),
  };

  const policyChain = new ToolExecutionPermissionPolicyChain(
    runtime.get(IAgentLifecycleService),
    host.scopeContext,
    host.agentRuntime,
    runtime.get(ISessionWorkspaceContext),
    runtime.get(IGitService),
  );
  const gate = new ToolExecutionPermissionGatePolicy(runtime, policyChain);
  vetoBus.register(PERMISSION_GATE_PARTICIPANT, (event) => gate.adjudicate(event));
  vetoBus.register(TOOL_DEDUPE_PARTICIPANT, (event) => {
    const reply: DedupeCheckEvent['reply'] = {};
    runtime.send({
      type: 'toolExecutor.dedupeCheck',
      input: dedupeCallInputOf({
        toolCallId: event.toolCall.id,
        toolName: event.toolCall.name,
        args: event.args,
        trace: event.trace,
      }),
      reply,
    } satisfies DedupeCheckEvent);
    if (reply.syntheticResult !== null && reply.syntheticResult !== undefined) {
      event.veto(reply.syntheticResult as ExecutableToolResult);
    }
  });
  didHooks.register(TOOL_DEDUPE_PARTICIPANT, async (ctx, next) => {
    runtime.send({
      type: 'toolExecutor.dedupeRegisterSkipped',
      input: dedupeCallInputOf({
        toolCallId: ctx.toolCall.id,
        toolName: ctx.toolCall.name,
        args: ctx.args,
        trace: ctx.trace,
      }),
      rawArguments: ctx.toolCall.arguments,
    } satisfies DedupeRegisterSkippedEvent);
    const reply: DedupeFinalizeEvent['reply'] = {};
    runtime.send({
      type: 'toolExecutor.dedupeFinalize',
      input: dedupeCallInputOf({
        toolCallId: ctx.toolCall.id,
        toolName: ctx.toolCall.name,
        args: ctx.args,
        trace: ctx.trace,
      }),
      result: ctx.result as ToolDedupeResult,
      reply,
    } satisfies DedupeFinalizeEvent);
    const finalization = reply.finalization!;
    ctx.result = ('result' in finalization
      ? finalization.result
      : await finalization.pending) as ExecutableToolResult;
    if (ctx.result.stopTurn === true) {
      ctx.stopTurn = true;
    }
    await next();
  });

  const factoryContext: AgentToolFactoryContext = {
    agent: runtime.agent,
    host,
    get: (id) => runtime.get(id),
    enabled: () => selection.enabled(),
    load: (names) => selection.load(names),
    isActive: (name, source) => policy.isActive(name, source),
    isActiveForProfile: (profile, name, source) => policy.isActiveForProfile(profile, name, source),
    contributions: () => runtime.get(IAgentToolContributionSource).view.items,
    resolve: (name) => resolveCatalogTool(catalog, name),
    listReferences: () => catalogListReferences(catalog),
  };
  const catalogDeps: CatalogContributionDeps = {
    factoryContext,
    shouldActivate: (record) => {
      const required = record.options.requiredRuntimeCapabilities;
      const runtimeAllowed = required === undefined || host.agentRuntime.isAvailable(required);
      return (
        runtimeAllowed && policy.isActive(record.options.name, record.options.source ?? 'builtin')
      );
    },
  };

  const mcpDeps: McpDeps = {
    catalog,
    mcpHandle: runtime.get(ISessionMcpHandle),
    sessionContext: runtime.get(ISessionContext),
    dispatcher: host.dispatcher,
    telemetry: host.telemetry,
    scopeContext: host.scopeContext,
    states: host.state,
  };

  const callDeps: ToolCallPipelineDeps = {
    runtime,
    vetoBus,
    willExecuteEmitter,
    didHooks: didHooks.hooks,
    didExecuteEmitter,
    telemetry: host.telemetry,
    truncation: () => runtime.get(ISessionToolResultTruncationService).of(runtime.agent),
    takeDupType: (toolCallId) => {
      const reply: DupTypeTakeEvent['reply'] = {};
      runtime.send({ type: 'toolExecutor.dupTypeTake', toolCallId, reply } satisfies DupTypeTakeEvent);
      return reply.dupType;
    },
  };

  return {
    runtime,
    host,
    catalog,
    catalogDeps,
    policy,
    selection,
    vetoBus,
    didHooks,
    willExecuteEmitter,
    didExecuteEmitter,
    guardSlot,
    unavailableDescriberSlot,
    missingDescriberSlot,
    dedupe: createToolDedupeState(),
    mcp: createMcpState(),
    mcpDeps,
    callDeps,
    batches: new Map(),
    nextBatchId: 0,
    activeCalls: [],
    activeCallsEmitter: new Emitter<readonly ActiveToolCall[]>(),
  };
}

function pumpBatch(batch: BatchRecord): void {
  if (batch.error !== undefined) return;
  if (batch.calls.some((call) => call.status === 'pending' || call.status === 'preparing')) return;
  const active = batch.calls
    .filter((call) => call.status === 'running')
    .map((call) => call.accesses!);
  const queuedBefore: ToolAccesses[] = [];
  for (const call of batch.calls) {
    if (call.status !== 'ready') continue;
    const blocked = [...active, ...queuedBefore].some((accesses) =>
      ToolAccessesValue.conflict(call.accesses!, accesses),
    );
    if (blocked) {
      queuedBefore.push(call.accesses!);
      continue;
    }
    call.status = 'running';
    active.push(call.accesses!);
    call.ref.send({ type: 'call.start' });
  }
}

function batchDone(batch: BatchRecord): boolean {
  return batch.calls.every(
    (call) => call.status === 'done' || call.status === 'failed' || call.status === 'cancelled',
  );
}

function finishBatchIfDone(
  context: ToolExecutorMachineContext,
  batch: BatchRecord,
): void {
  if (!batchDone(batch)) return;
  if (batch.error !== undefined) batch.stream.fail(batch.error.cause);
  else batch.stream.end();
  context.batches.delete(batch.batchId);
}

const toolExecutorEffects = fromCallback(
  ({ input }: { input: AgentRuntimeContext<unknown> }) => {
    const runtime = input;
    const machine = (): ToolExecutorMachineContext => toolExecutorMachineOf(runtime);
    const host = machine().host;
    const loop = getLoopControl(runtime.agent);
    const lifecycle = runtime.get(IAgentLifecycleService);
    const mcpDeps = machine().mcpDeps;
    host.state.contributeState(mcpDiscoveryKey);
    host.state.contributeState(mcpMcpToolsByServerKey);
    host.state.contributeState(mcpDiscoveryWritesReadyKey);

    const contributionSource = runtime.get(IAgentToolContributionSource);
    const contributions = contributionSource.view;
    const providers = contributionSource.providers;
    const providerSubscriptions = new Map<AgentToolProviderContribution, IDisposable>();
    const reconcileProviders = (): void => {
      const active = new Set(
        providers.items.filter((record) => record.agentId === runtime.agent.agentId),
      );
      for (const [record, subscription] of providerSubscriptions) {
        if (active.has(record)) continue;
        subscription.dispose();
        providerSubscriptions.delete(record);
        runtime.send({
          type: 'toolExecutor.catalogSourceSet',
          owner: record,
          entries: [],
        } satisfies CatalogSourceSetEvent);
      }
      for (const record of active) {
        if (!providerSubscriptions.has(record)) {
          providerSubscriptions.set(
            record,
            record.onDidChange(() => {
              runtime.send({
                type: 'toolExecutor.catalogSourceSet',
                owner: record,
                entries: record.snapshot(),
              } satisfies CatalogSourceSetEvent);
            }),
          );
        }
        runtime.send({
          type: 'toolExecutor.catalogSourceSet',
          owner: record,
          entries: record.snapshot(),
        } satisfies CatalogSourceSetEvent);
      }
    };

    runtime.send({
      type: 'toolExecutor.catalogReconcile',
      records: contributions.items,
    } satisfies CatalogReconcileEvent);
    reconcileProviders();

    const disposables: IDisposable[] = [
      contributions.onDidChange(() => {
        runtime.send({
          type: 'toolExecutor.catalogReconcile',
          records: contributions.items,
        } satisfies CatalogReconcileEvent);
      }),
      providers.onDidChange(reconcileProviders),
      host.eventBus.subscribe(TurnEnded, () => {
        runtime.send({ type: 'toolExecutor.dedupeTurnEnded' } satisfies DedupeTurnEndedEvent);
      }),
      loop.hooks.onWillBeginStep.register(TOOL_DEDUPE_PARTICIPANT, async (ctx, next) => {
        runtime.send({
          type: 'toolExecutor.dedupeStepBegin',
          turnId: ctx.turnId,
          step: ctx.step,
        } satisfies DedupeStepBeginEvent);
        await next();
      }),
      loop.hooks.onDidFinishStep.register(TOOL_DEDUPE_PARTICIPANT, async (_ctx, next) => {
        runtime.send({ type: 'toolExecutor.dedupeStepEnd' } satisfies DedupeStepEndEvent);
        await next();
      }),
      loop.hooks.onWillBeginStep.register('mcp', async (ctx, next) => {
        await mcpWaitForInitialLoad(mcpDeps, ctx.signal);
        await next();
      }),
      machine().willExecuteEmitter.event((event) => {
        event.waitUntil(mcpWaitForInitialLoad(mcpDeps, event.signal));
      }),
      host.dispatcher.hooks.onDidRestore.register('mcp', async (_ctx, next) => {
        runtime.send({ type: 'toolExecutor.mcpFlushDiscoveries' } satisfies McpFlushDiscoveriesEvent);
        await next();
      }),
      {
        dispose: mcpDeps.mcpHandle.connectionManager.onStatusChange((entry) => {
          runtime.send({ type: 'toolExecutor.mcpStatus', entry } satisfies McpStatusEvent);
        }),
      },
      activateReminderWhenReady(lifecycle, host.scopeContext, (reminder) =>
        reminder.register(LOADABLE_TOOLS_VARIANT, ({ isNewTurn }) =>
          isNewTurn ? machine().selection.loadableToolsAnnouncement() : undefined,
        ),
      ),
      activateReminderWhenReady(lifecycle, host.scopeContext, (reminder) =>
        reminder.register(DYNAMIC_TOOL_SCHEMA_VARIANT, () => {
          const tools = machine().selection.drainPendingToolSchemas();
          if (tools === undefined) return undefined;
          return { message: { role: 'system', content: [], tools } };
        }),
      ),
      host.eventBus.subscribe(CompactionCompleted, () => {
        machine().selection.clearPendingLoaded();
      }),
      host.eventBus.subscribe(ContextSpliced, (splice) => {
        if (splice.deleteCount === 0 || splice.messages.length > 0) return;
        machine().selection.dropPendingLoadedNotLanded();
      }),
    ];

    for (const entry of mcpDeps.mcpHandle.connectionManager.list()) {
      runtime.send({ type: 'toolExecutor.mcpStatus', entry } satisfies McpStatusEvent);
    }

    return () => {
      for (let index = disposables.length - 1; index >= 0; index -= 1) {
        disposables[index]!.dispose();
      }
      for (const subscription of providerSubscriptions.values()) subscription.dispose();
      providerSubscriptions.clear();
      const context = machine();
      disposeCatalog(context.catalog);
      context.willExecuteEmitter.dispose();
      context.didExecuteEmitter.dispose();
      context.activeCallsEmitter.dispose();
    };
  },
);

export const toolExecutorActorLogic = setup({
  types: {} as {
    context: ToolExecutorMachineContext;
    input: AgentRuntimeContext<unknown>;
    events: ToolExecutorMachineEvent;
  },
  actors: { toolExecutorEffects, toolCall: toolCallLogic },
  actions: {
    applyCallStarted: enqueueActions(({ context, event, enqueue }) => {
      const e = event as ToolCallStartedInternalEvent;
      const next = [
        ...context.activeCalls.filter(
          (call) => call.turnId === e.call.turnId && call.toolCallId !== e.call.toolCallId,
        ),
        e.call,
      ];
      enqueue.assign({ activeCalls: next });
      context.activeCallsEmitter.fire(next);
    }),
    applyCallSettled: enqueueActions(({ context, event, enqueue }) => {
      const e = event as ToolCallSettledInternalEvent;
      const next = context.activeCalls.filter((call) => call.toolCallId !== e.toolCallId);
      if (next.length === context.activeCalls.length) return;
      enqueue.assign({ activeCalls: next });
    }),
    handleExecuteBatch: enqueueActions(({ context, event, enqueue }) => {
      const e = event as ToolExecutorExecuteEvent;
      dedupeResetDupTypes(context.dedupe, e.options.turnId);
      const batchId = context.nextBatchId;
      enqueue.assign({ nextBatchId: batchId + 1 });
      const stream = new BatchStream();
      e.reply.stream = stream;
      const batch: BatchRecord = {
        batchId,
        options: e.options,
        calls: [],
        prepareCursor: 0,
        stopBatch: false,
        error: undefined,
        stream,
      };
      const preflighted = e.calls.map((call) =>
        preflightToolCall(
          {
            catalog: context.catalog,
            guard: context.guardSlot.current,
            describeUnavailableTool: context.unavailableDescriberSlot.current,
            describeMissingTool: context.missingDescriberSlot.current,
            log: context.runtime.get(ILogService),
          },
          call,
        ),
      );
      enqueue.assign(({ spawn }) => {
        preflighted.forEach((call, index) => {
          const ref = spawn('toolCall', {
            id: `toolCall-${batchId}-${index}`,
            input: {
              deps: context.callDeps,
              batchId,
              index,
              call,
              calls: e.calls,
              options: e.options,
            },
          });
          batch.calls.push({
            index,
            ref: ref as ToolCallActorRef,
            status: 'pending',
            accesses: undefined,
          });
        });
        context.batches.set(batchId, batch);
        return {};
      });
      enqueue(() => {
        const first = batch.calls[0]!;
        first.status = 'preparing';
        first.ref.send({ type: 'call.prepare' });
      });
    }),
    handleCallPrepared: ({ context, event }) => {
      const e = event as Extract<ToolCallParentNotice, { type: 'toolExecutor.call.prepared' }>;
      const batch = context.batches.get(e.batchId);
      if (batch === undefined) return;
      const call = batch.calls[e.index]!;
      call.status = 'ready';
      call.accesses = e.accesses;
      if (e.stopBatchAfterThis) batch.stopBatch = true;
      if (batch.error !== undefined) {
        call.status = 'cancelled';
        finishBatchIfDone(context, batch);
        return;
      }
      if (e.index + 1 > batch.prepareCursor) batch.prepareCursor = e.index + 1;
      if (batch.prepareCursor < batch.calls.length) {
        if (batch.stopBatch) {
          for (let index = batch.prepareCursor; index < batch.calls.length; index += 1) {
            const remaining = batch.calls[index]!;
            remaining.status = 'preparing';
            remaining.ref.send({ type: 'call.skip' });
          }
          batch.prepareCursor = batch.calls.length;
        } else {
          const nextCall = batch.calls[batch.prepareCursor]!;
          nextCall.status = 'preparing';
          nextCall.ref.send({ type: 'call.prepare' });
        }
      }
      pumpBatch(batch);
    },
    handleCallRan: ({ context, event }) => {
      const e = event as Extract<ToolCallParentNotice, { type: 'toolExecutor.call.ran' }>;
      const batch = context.batches.get(e.batchId);
      if (batch === undefined) return;
      batch.calls[e.index]!.status = 'finalizing';
      pumpBatch(batch);
    },
    handleCallSettled: enqueueActions(({ context, event, enqueue }) => {
      const e = event as Extract<ToolCallParentNotice, { type: 'toolExecutor.call.settled' }>;
      const batch = context.batches.get(e.batchId);
      if (batch === undefined) return;
      const call = batch.calls[e.index]!;
      call.status = 'done';
      batch.stream.push(e.result);
      enqueue.stopChild(call.ref);
      finishBatchIfDone(context, batch);
    }),
    handleCallFailed: enqueueActions(({ context, event, enqueue }) => {
      const e = event as Extract<ToolCallParentNotice, { type: 'toolExecutor.call.failed' }>;
      const batch = context.batches.get(e.batchId);
      if (batch === undefined) return;
      batch.error ??= { cause: e.error };
      const call = batch.calls[e.index]!;
      call.status = 'failed';
      enqueue.stopChild(call.ref);
      for (const other of batch.calls) {
        if (other.status !== 'pending' && other.status !== 'ready') continue;
        other.status = 'cancelled';
        enqueue.stopChild(other.ref);
      }
      finishBatchIfDone(context, batch);
    }),
    handleDedupeCheck: ({ context, event }) => {
      const e = event as DedupeCheckEvent;
      e.reply.syntheticResult = dedupeCheck(context.dedupe, context.host.telemetry, e.input);
    },
    handleDedupeRegisterSkipped: ({ context, event }) => {
      const e = event as DedupeRegisterSkippedEvent;
      dedupeRegisterSkipped(context.dedupe, context.host.telemetry, e.input, e.rawArguments);
    },
    handleDedupeFinalize: ({ context, event }) => {
      const e = event as DedupeFinalizeEvent;
      e.reply.finalization = dedupeFinalize(
        context.dedupe,
        context.host.telemetry,
        e.input,
        e.result,
      );
    },
    handleDedupeStepBegin: ({ context, event }) => {
      const e = event as DedupeStepBeginEvent;
      dedupeBeginStep(context.dedupe, e.turnId, e.step);
    },
    handleDedupeStepEnd: ({ context }) => {
      dedupeEndStep(context.dedupe);
    },
    handleDedupeTurnEnded: ({ context }) => {
      dedupeClearTurnRecords(context.dedupe);
    },
    handleDupTypeTake: ({ context, event }) => {
      const e = event as DupTypeTakeEvent;
      e.reply.dupType = dedupeTakeDupType(context.dedupe, e.toolCallId);
    },
    handleCatalogReconcile: ({ context, event }) => {
      const e = event as CatalogReconcileEvent;
      reconcileCatalogContributions(context.catalog, context.catalogDeps, e.records);
    },
    handleCatalogSourceSet: ({ context, event }) => {
      const e = event as CatalogSourceSetEvent;
      setCatalogSource(context.catalog, e.owner, e.entries);
    },
    handleMcpStatus: ({ context, event }) => {
      const e = event as McpStatusEvent;
      handleMcpServerStatusChange(context.mcp, context.mcpDeps, e.entry);
    },
    handleMcpFlushDiscoveries: ({ context }) => {
      flushPendingMcpDiscoveries(context.mcp, context.mcpDeps);
    },
  },
}).createMachine({
  context: ({ input }) => buildMachineContext(input),
  invoke: {
    src: 'toolExecutorEffects',
    input: ({ context }) => context.runtime,
  },
  on: {
    'toolExecutor.callStarted': { actions: 'applyCallStarted' },
    'toolExecutor.callSettled': { actions: 'applyCallSettled' },
    'toolExecutor.executeBatch': { actions: 'handleExecuteBatch' },
    'toolExecutor.call.prepared': { actions: 'handleCallPrepared' },
    'toolExecutor.call.ran': { actions: 'handleCallRan' },
    'toolExecutor.call.settled': { actions: 'handleCallSettled' },
    'toolExecutor.call.failed': { actions: 'handleCallFailed' },
    'toolExecutor.dedupeCheck': { actions: 'handleDedupeCheck' },
    'toolExecutor.dedupeRegisterSkipped': { actions: 'handleDedupeRegisterSkipped' },
    'toolExecutor.dedupeFinalize': { actions: 'handleDedupeFinalize' },
    'toolExecutor.dedupeStepBegin': { actions: 'handleDedupeStepBegin' },
    'toolExecutor.dedupeStepEnd': { actions: 'handleDedupeStepEnd' },
    'toolExecutor.dedupeTurnEnded': { actions: 'handleDedupeTurnEnded' },
    'toolExecutor.dupTypeTake': { actions: 'handleDupTypeTake' },
    'toolExecutor.catalogReconcile': { actions: 'handleCatalogReconcile' },
    'toolExecutor.catalogSourceSet': { actions: 'handleCatalogSourceSet' },
    'toolExecutor.mcpStatus': { actions: 'handleMcpStatus' },
    'toolExecutor.mcpFlushDiscoveries': { actions: 'handleMcpFlushDiscoveries' },
    'runtime.restore': {},
  },
});
