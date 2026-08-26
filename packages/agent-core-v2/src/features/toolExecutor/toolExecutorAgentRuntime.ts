import { setup } from 'xstate';

import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/agent/runtime/agentRuntime';
import type { ToolCall } from '#/kosong/contract/message';
import type {
  MissingToolDescriber,
  ToolCallGuard,
  ToolDidExecuteHook,
  ToolExecutionFinishedEvent,
  ToolExecutionParticipationOrder,
  ToolExecutionResult,
  ToolExecutionVetoListener,
  ToolExecutorExecuteOptions,
  UnavailableToolDescriber,
} from '#/features/toolExecutor/toolExecutor';
import type { WillExecuteToolEvent } from '#/features/toolExecutor/toolHooks';
import {
  ToolExecutorDomain,
  toolExecutorEffects,
} from '#/features/toolExecutor/internal/domain';

interface ToolExecutorActorContext {
  readonly runtime: AgentRuntimeContext<unknown>;
  readonly domain: ToolExecutorDomain;
}

const toolExecutorActorLogic = setup({
  types: {} as {
    context: ToolExecutorActorContext;
    input: AgentRuntimeContext<unknown>;
    events: AgentRuntimeRestoreEvent;
  },
  actors: { toolExecutorEffects },
}).createMachine({
  context: ({ input }) => ({
    runtime: input,
    domain: new ToolExecutorDomain(input),
  }),
  invoke: {
    src: 'toolExecutorEffects',
    input: ({ context }) => context.domain,
  },
});

export class ToolExecutorRuntime {
  constructor(private readonly context: AgentRuntimeContext<unknown>) {}

  private get domain(): ToolExecutorDomain {
    return this.context.getLogicState<ToolExecutorActorContext>().domain;
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

export const AgentToolExecutor =
  defineAgentRuntimeContract<ToolExecutorRuntime>('toolExecutor');

export const toolExecutorAgentRuntimeProvider = defineAgentRuntimeProvider<
  unknown,
  ToolExecutorRuntime
>(AgentToolExecutor, {
  id: 'toolExecutor',
  logic: toolExecutorActorLogic,
  eager: true,
  createApi: (context) => new ToolExecutorRuntime(context),
  inspect: (snapshot) => {
    const { domain } = (snapshot as unknown as { context: ToolExecutorActorContext }).context;
    return {
      veto: domain.pipeline.beforeExecuteBus.participantNames(),
      did: domain.pipeline.didHookOrder,
    };
  },
});
