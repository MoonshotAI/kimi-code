import { enqueueActions, setup } from 'xstate';

import type { IDisposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/actor/agentRuntime';
import type { ToolCall } from '#/kosong/contract/message';
import type { ExecutableTool, ToolInfo } from '#/tool/toolContract';
import type { Tool } from '#/kosong/contract/tool';
import type { ContextMessage } from '#/actor/contextMemory/types';
import type { LoadToolsResult, ShapedToolEntry } from '#/actor/toolExecutor/toolSelection';
import type {
  ActiveToolCall,
  MissingToolDescriber,
  ToolCallGuard,
  ToolDidExecuteHook,
  ToolExecutionFinishedEvent,
  ToolExecutionParticipationOrder,
  ToolExecutionResult,
  ToolExecutionVetoListener,
  ToolExecutorExecuteOptions,
  UnavailableToolDescriber,
} from '#/actor/toolExecutor/toolExecutor';
import type { WillExecuteToolEvent } from '#/actor/toolExecutor/toolHooks';
import {
  ToolExecutorDomain,
  toolExecutorEffects,
} from '#/actor/toolExecutor/internal/domain';

interface ToolExecutorActorContext {
  readonly runtime: AgentRuntimeContext<unknown>;
  readonly domain: ToolExecutorDomain;
  readonly activeCalls: readonly ActiveToolCall[];
  readonly activeCallsEmitter: Emitter<readonly ActiveToolCall[]>;
}

export interface ToolCallStartedInternalEvent {
  readonly type: 'toolExecutor.callStarted';
  readonly call: ActiveToolCall;
}

export interface ToolCallSettledInternalEvent {
  readonly type: 'toolExecutor.callSettled';
  readonly toolCallId: string;
}

const toolExecutorActorLogic = setup({
  types: {} as {
    context: ToolExecutorActorContext;
    input: AgentRuntimeContext<unknown>;
    events: AgentRuntimeRestoreEvent | ToolCallStartedInternalEvent | ToolCallSettledInternalEvent;
  },
  actors: { toolExecutorEffects },
}).createMachine({
  context: ({ input }) => ({
    runtime: input,
    domain: new ToolExecutorDomain(input),
    activeCalls: [],
    activeCallsEmitter: new Emitter<readonly ActiveToolCall[]>(),
  }),
  invoke: {
    src: 'toolExecutorEffects',
    input: ({ context }) => context.domain,
  },
  on: {
    'toolExecutor.callStarted': {
      actions: enqueueActions(({ context, event, enqueue }) => {
        const next = [
          ...context.activeCalls.filter(
            (call) => call.turnId === event.call.turnId && call.toolCallId !== event.call.toolCallId,
          ),
          event.call,
        ];
        enqueue.assign({ activeCalls: next });
        context.activeCallsEmitter.fire(next);
      }),
    },
    'toolExecutor.callSettled': {
      actions: enqueueActions(({ context, event, enqueue }) => {
        const next = context.activeCalls.filter((call) => call.toolCallId !== event.toolCallId);
        if (next.length === context.activeCalls.length) return;
        enqueue.assign({ activeCalls: next });
      }),
    },
  },
});

export class AgentToolsRuntime {
  constructor(private readonly context: AgentRuntimeContext<unknown>) {}

  private get domain(): ToolExecutorDomain {
    return this.context.getLogicState<ToolExecutorActorContext>().domain;
  }

  availableTools(): readonly ToolInfo[] {
    return this.domain.catalog.list();
  }

  activeTools(): readonly ToolInfo[] {
    return this.availableTools().filter((tool) => this.domain.policy.isActive(tool.name, tool.source));
  }

  activeCalls(): readonly ActiveToolCall[] {
    return this.context.getLogicState<ToolExecutorActorContext>().activeCalls;
  }

  get onDidChangeActiveCalls(): Event<readonly ActiveToolCall[]> {
    return this.context.getLogicState<ToolExecutorActorContext>().activeCallsEmitter.event;
  }

  get onDidChange(): Event<void> {
    return this.domain.catalog.onDidChange;
  }

  resolve(name: string): ExecutableTool | undefined {
    return this.domain.catalog.resolve(name);
  }

  listReferences(): readonly { readonly name: string; readonly source: ToolInfo['source'] }[] {
    return this.domain.catalog.listReferences();
  }

  isActive(name: string, source: ToolInfo['source'] = 'builtin'): boolean {
    return this.domain.policy.isActive(name, source);
  }

  isActiveForDisclosure(name: string, source: ToolInfo['source'] = 'builtin'): boolean {
    return this.domain.policy.isActiveForDisclosure(name, source);
  }

  setSessionDisabledTools(names: readonly string[]): Promise<void> {
    return this.domain.policy.setSessionDisabledTools(names);
  }

  toolsForModel(): readonly ShapedToolEntry[] {
    return this.domain.selection.shapeTools(this.availableTools());
  }

  shapeHistory(messages: readonly ContextMessage[]): readonly ContextMessage[] {
    return this.domain.selection.shapeHistory(messages);
  }

  select(names: readonly string[]): LoadToolsResult {
    return this.domain.selection.load(names);
  }

  selectionEnabled(): boolean {
    return this.domain.selection.enabled();
  }

  drainPendingToolSchemas(): readonly Tool[] | undefined {
    return this.domain.selection.drainPendingToolSchemas();
  }

  loadableToolsAnnouncement(): string | undefined {
    return this.domain.selection.loadableToolsAnnouncement();
  }

  execute(
    calls: ToolCall[],
    options: ToolExecutorExecuteOptions,
  ): AsyncIterable<ToolExecutionResult> {
    return this.domain.pipeline.execute(calls, options);
  }

  get onWillExecute(): Event<WillExecuteToolEvent> {
    return this.domain.pipeline.onWillExecute;
  }

  get onDidExecute(): Event<ToolExecutionFinishedEvent> {
    return this.domain.pipeline.onDidExecute;
  }

  participateExecution(
    name: string,
    listener: ToolExecutionVetoListener,
    order: ToolExecutionParticipationOrder = 'prePolicy',
  ): IDisposable {
    return this.domain.pipeline.beforeExecuteBus.register(name, listener, order);
  }

  registerDidExecuteHook(
    name: string,
    hook: ToolDidExecuteHook,
    order: ToolExecutionParticipationOrder = 'prePolicy',
  ): IDisposable {
    return this.domain.pipeline.registerDidExecuteHook(name, hook, order);
  }

  registerToolCallGuard(guard: ToolCallGuard): IDisposable {
    return this.domain.pipeline.registerToolCallGuard(guard);
  }

  registerUnavailableToolDescriber(describer: UnavailableToolDescriber): IDisposable {
    return this.domain.pipeline.registerUnavailableToolDescriber(describer);
  }

  registerMissingToolDescriber(describer: MissingToolDescriber): IDisposable {
    return this.domain.pipeline.registerMissingToolDescriber(describer);
  }
}

export const AgentTools =
  defineAgentRuntimeContract<AgentToolsRuntime>('tools');

export const agentToolsRuntimeProvider = defineAgentRuntimeProvider<
  unknown,
  AgentToolsRuntime
>(AgentTools, {
  id: 'tools',
  logic: toolExecutorActorLogic,
  eager: true,
  createApi: (context) => new AgentToolsRuntime(context),
  inspect: (snapshot) => {
    const { domain } = (snapshot as unknown as { context: ToolExecutorActorContext }).context;
    return {
      veto: domain.pipeline.beforeExecuteBus.participantNames(),
      did: domain.pipeline.didHookOrder,
    };
  },
});

