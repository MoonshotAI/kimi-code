import { Service } from '#/_base/di/service';
import { toDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { defineState } from '#/state/state';
export { abortedToolOutput } from '#/_base/utils/abort';
import type { ToolCallEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolRegistryService, type ToolRegistryChange } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { IAgentTaskOutputService } from '#/agent/task/taskOutput';
import { ToolAccesses, type ExecutableTool } from '#/tool/toolContract';
import { BeforeToolExecuteEmitter } from './beforeToolExecuteEvent';
import { legacyExecutionContext, legacyStartingDecision } from './legacyHooks';
import {
  composeToolExecutorHooks,
  LegacyExecutableToolAdapter,
  legacyToolDurationMs,
  ToolExecutor,
  type ToolExecutionEvent,
} from '#/tool/executor';

import {
  IAgentToolExecutorService,
  type AgentToolExecutionHandler,
  type AgentToolExecutor,
  type AgentToolHook,
  type ToolCallDupType,
} from './toolExecutor';
import { ToolCallStarted, ToolUpdated, ToolResultEvent } from './toolExecutorEvents';
import { ToolScheduler } from './toolScheduler';

export const toolExecutorToolCallDupTypesKey = defineState<Map<string, ToolCallDupType>>(
  'toolExecutor.toolCallDupTypes',
  () => new Map(),
);
export const toolExecutorDupTypeTurnIdKey = defineState<number | undefined>(
  'toolExecutor.dupTypeTurnId',
  () => undefined as number | undefined,
);

interface AdapterEntry {
  readonly tool: ExecutableTool;
  readonly adapter: LegacyExecutableToolAdapter;
}

interface SchedulerBatch {
  readonly scheduler: ToolScheduler<void>;
  handlers: number;
}

export class AgentToolExecutorService extends Service implements IAgentToolExecutorService {
  declare readonly _serviceBrand: undefined;
  readonly executor: AgentToolExecutor;

  private readonly hooks: AgentToolHook[] = [];
  private readonly legacyStarting = new BeforeToolExecuteEmitter();
  private readonly adapters = new Map<string, AdapterEntry>();
  private readonly batches = new Map<string, SchedulerBatch>();
  private readonly batchByTask = new Map<string, string>();
  private readonly leases = new Map<string, () => void>();
  private readonly liveHandlers = new Map<string, AgentToolExecutionHandler>();
  private readonly taskIdsByCall = new Map<string, string[]>();
  private readonly announced = new WeakSet<object>();
  private readonly completed = new WeakSet<object>();

  constructor(
    @IAgentToolRegistryService private readonly registry: IAgentToolRegistryService,
    @IAgentToolResultTruncationService private readonly truncation: IAgentToolResultTruncationService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentTaskOutputService private readonly taskOutputs: IAgentTaskOutputService,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.contributeState(toolExecutorToolCallDupTypesKey);
    this.states.contributeState(toolExecutorDupTypeTurnIdKey);
    const resetHook: AgentToolHook = {
      starting: (context) => {
        if (context.context.turnId !== this.dupTypeTurnId) {
          this.dupTypeTurnId = context.context.turnId;
          this.toolCallDupTypes.clear();
        }
      },
    };
    const legacyHook: AgentToolHook = {
      starting: async (context) => {
        const decision = await this.legacyStarting.fireBeforeExecute(legacyExecutionContext(context));
        return legacyStartingDecision(context, decision);
      },
    };
    const internalHook: AgentToolHook = {
      beforeExecute: async (context) => {
        if (context.prepared.kind !== 'execute') return;
        const { batch } = this.batch(context.context.turnId, context.context.step, context.taskId);
        const release = await batch.scheduler.lease(
          context.prepared.accesses ?? ToolAccesses.all(),
          context.signal,
        );
        this.leases.set(context.taskId, release);
        context.prepared.onExecuted = () => {
          this.leases.get(context.taskId)?.();
          this.leases.delete(context.taskId);
        };
      },
      observe: (event) => this.observe(event),
    };
    const hooks = this.hooks;
    this.executor = new ToolExecutor([], {
      outputStore: this.taskOutputs,
      get hook() {
        return composeToolExecutorHooks([resetHook, legacyHook, ...hooks, internalHook]);
      },
    });
    for (const reference of registry.listReferences()) {
      const tool = registry.resolve(reference.name);
      if (tool !== undefined) this.registerTool(tool);
    }
    this._register(this.legacyStarting);
    this._register(registry.onDidChange((change) => this.registryChanged(change)));
  }

  private get toolCallDupTypes(): Map<string, ToolCallDupType> {
    return this.states.get(toolExecutorToolCallDupTypesKey);
  }

  private get dupTypeTurnId(): number | undefined {
    return this.states.get(toolExecutorDupTypeTurnIdKey);
  }

  private set dupTypeTurnId(value: number | undefined) {
    this.states.set(toolExecutorDupTypeTurnIdKey, value);
  }

  registerHook(hook: AgentToolHook) {
    this.hooks.push(hook);
    return toDisposable(() => {
      const index = this.hooks.indexOf(hook);
      if (index >= 0) this.hooks.splice(index, 1);
    });
  }

  registerLegacyStarting(listener: Parameters<BeforeToolExecuteEmitter['event']>[0]) {
    return this.legacyStarting.event(listener);
  }

  handlers(): readonly AgentToolExecutionHandler[] {
    return [...this.liveHandlers.values()];
  }

  handler(taskId: string): AgentToolExecutionHandler | undefined {
    return this.liveHandlers.get(taskId);
  }

  handlerForCall(toolCallId: string): AgentToolExecutionHandler | undefined {
    const ids = this.taskIdsByCall.get(toolCallId);
    const taskId = ids?.at(-1);
    return taskId === undefined ? undefined : this.liveHandlers.get(taskId);
  }

  release(taskId: string): void {
    const handler = this.liveHandlers.get(taskId);
    if (handler === undefined) return;
    this.liveHandlers.delete(taskId);
    const callId = handler.snapshot().id;
    const ids = this.taskIdsByCall.get(callId);
    if (ids !== undefined) {
      const remaining = ids.filter((id) => id !== taskId);
      if (remaining.length === 0) this.taskIdsByCall.delete(callId);
      else this.taskIdsByCall.set(callId, remaining);
    }
    this.leases.get(taskId)?.();
    this.leases.delete(taskId);
    const key = this.batchByTask.get(taskId);
    this.batchByTask.delete(taskId);
    if (key === undefined) return;
    const batch = this.batches.get(key);
    if (batch === undefined) return;
    batch.handlers -= 1;
    if (batch.handlers === 0) this.batches.delete(key);
  }

  private batch(turnId: number, step: number | undefined, taskId: string): { readonly key: string; readonly batch: SchedulerBatch } {
    const key = `${turnId}:${step ?? taskId}`;
    let batch = this.batches.get(key);
    if (batch === undefined) {
      batch = { scheduler: new ToolScheduler<void>(), handlers: 0 };
      this.batches.set(key, batch);
    }
    return { key, batch };
  }

  recordDupType(toolCallId: string, dupType: ToolCallDupType): void {
    this.toolCallDupTypes.set(toolCallId, dupType);
  }

  private registerTool(tool: ExecutableTool): void {
    const adapter = new LegacyExecutableToolAdapter(
      tool,
      (input) => this.truncation.truncateForModel(input),
    );
    this.adapters.set(tool.name, { tool, adapter });
    this.executor.addExecute(adapter);
  }

  private registryChanged(change: ToolRegistryChange): void {
    const current = this.adapters.get(change.tool.name);
    if (change.type === 'unregistered') {
      if (current?.tool !== change.tool) return;
      this.executor.removeExecute(current.adapter);
      this.adapters.delete(change.tool.name);
      return;
    }
    this.registerTool(change.tool);
  }

  private observe(event: ToolExecutionEvent<any, any, any>): void {
    const { handler } = event;
    if (event.type === 'created') {
      this.liveHandlers.set(handler.taskId, handler);
      const ids = this.taskIdsByCall.get(event.call.id) ?? [];
      ids.push(handler.taskId);
      this.taskIdsByCall.set(event.call.id, ids);
      const { key, batch } = this.batch(event.context.turnId, event.context.step, handler.taskId);
      batch.handlers += 1;
      this.batchByTask.set(handler.taskId, key);
      void handler.wait().catch(() => this.release(handler.taskId));
      return;
    }
    this.announce(event);
    if (!this.announced.has(handler)) return;
    const snapshot = handler.snapshot();
    if (event.type === 'change' && snapshot.detached) {
      this.leases.get(handler.taskId)?.();
      this.leases.delete(handler.taskId);
    }
    void this.dispatcher.dispatch(new ToolUpdated({
      agentId: this.scopeContext.agentId,
      turnId: event.context.turnId,
      toolCallId: event.call.id,
      taskId: handler.taskId,
      status: snapshot.status,
      detached: snapshot.detached,
      fields: snapshot.fields,
      output: event.type === 'output' ? { offset: event.offset, text: event.text } : undefined,
    }));
    if (event.type === 'output') return;
    const status = snapshot.status;
    if (status !== 'success' && status !== 'failed' && status !== 'aborted') return;
    if (this.completed.has(handler)) return;
    this.completed.add(handler);
    this.leases.get(handler.taskId)?.();
    this.leases.delete(handler.taskId);
    const result = this.resultOf(event);
    const outcome = snapshot.error?.outcome ?? 'success';
    void this.dispatcher.dispatch(new ToolResultEvent({
      agentId: this.scopeContext.agentId,
      turnId: event.context.turnId,
      toolCallId: event.call.id,
      output: result?.output ?? this.finalContent(event),
      isError: outcome === 'success' ? undefined : true,
      synthetic: snapshot.prepared?.kind === 'synthetic' ? true : undefined,
    }));
    this.track(event, outcome);
  }

  private announce(event: ToolExecutionEvent<any, any, any>): void {
    if (this.announced.has(event.handler)) return;
    const snapshot = event.handler.snapshot();
    const ready = snapshot.phase === 'execute' ||
      snapshot.status === 'failed' ||
      snapshot.status === 'aborted' ||
      snapshot.status === 'success';
    if (!ready) return;
    this.announced.add(event.handler);
    const prepared = snapshot.prepared;
    void this.dispatcher.dispatch(new ToolCallStarted({
      agentId: this.scopeContext.agentId,
      turnId: event.context.turnId,
      toolCallId: event.call.id,
      name: event.call.name,
      args: snapshot.args,
      description: prepared?.kind === 'execute' ? prepared.description : undefined,
      display: prepared?.kind === 'execute' ? prepared.display : undefined,
    }));
  }

  private resultOf(event: ToolExecutionEvent<any, any, any>) {
    const prepared = event.handler.snapshot().prepared;
    if (prepared?.kind === 'execute') return prepared.result;
    return prepared?.kind === 'synthetic' ? prepared.result : undefined;
  }

  private finalContent(event: ToolExecutionEvent<any, any, any>) {
    const snapshot = event.handler.snapshot();
    return snapshot.error === undefined ? [] : [{ type: 'text' as const, text: snapshot.error.reason }];
  }

  private track(event: ToolExecutionEvent<any, any, any>, outcome: 'success' | 'failed' | 'aborted'): void {
    const snapshot = event.handler.snapshot();
    const properties: ToolCallEvent = {
      turn_id: event.context.turnId,
      tool_call_id: event.call.id,
      tool_name: event.call.name,
      outcome: outcome === 'success' ? 'success' : 'error',
      duration_ms: legacyToolDurationMs(snapshot),
      dup_type: this.toolCallDupTypes.get(event.call.id) ?? 'normal',
      request_id: event.context.trace?.requestId,
    };
    this.toolCallDupTypes.delete(event.call.id);
    if (outcome !== 'success') properties['error_type'] = 'error';
    this.telemetry.track2('tool_call', properties);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolExecutorService,
  AgentToolExecutorService,
  ScopeActivation.OnScopeCreated,
  'toolExecutor',
);
