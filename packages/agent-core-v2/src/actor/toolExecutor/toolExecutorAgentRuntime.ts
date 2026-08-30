import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
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
  catalogList,
  catalogListReferences,
  resolveCatalogTool,
} from '#/actor/toolExecutor/internal/catalog';
import {
  toolExecutorActorLogic,
  type BatchStream,
  type ToolExecutorExecuteEvent,
  type ToolExecutorMachineContext,
  type ToolExecutorMachineSnapshot,
} from '#/actor/toolExecutor/internal/toolExecutorMachine';

export type {
  ToolCallStartedInternalEvent,
  ToolCallSettledInternalEvent,
} from '#/actor/toolExecutor/internal/toolExecutorMachine';

export class AgentToolsRuntime {
  constructor(private readonly context: AgentRuntimeContext<unknown>) {}

  private get machine(): ToolExecutorMachineContext {
    return this.context.getLogicState<ToolExecutorMachineContext>();
  }

  availableTools(): readonly ToolInfo[] {
    return catalogList(this.machine.catalog);
  }

  activeTools(): readonly ToolInfo[] {
    return this.availableTools().filter((tool) => this.machine.policy.isActive(tool.name, tool.source));
  }

  activeCalls(): readonly ActiveToolCall[] {
    return this.machine.activeCalls;
  }

  get onDidChangeActiveCalls(): Event<readonly ActiveToolCall[]> {
    return this.machine.activeCallsEmitter.event;
  }

  get onDidChange(): Event<void> {
    return this.machine.catalog.changeEmitter.event;
  }

  resolve(name: string): ExecutableTool | undefined {
    return resolveCatalogTool(this.machine.catalog, name);
  }

  listReferences(): readonly { readonly name: string; readonly source: ToolInfo['source'] }[] {
    return catalogListReferences(this.machine.catalog);
  }

  isActive(name: string, source: ToolInfo['source'] = 'builtin'): boolean {
    return this.machine.policy.isActive(name, source);
  }

  isActiveForDisclosure(name: string, source: ToolInfo['source'] = 'builtin'): boolean {
    return this.machine.policy.isActiveForDisclosure(name, source);
  }

  setSessionDisabledTools(names: readonly string[]): Promise<void> {
    return this.machine.policy.setSessionDisabledTools(names);
  }

  toolsForModel(): readonly ShapedToolEntry[] {
    return this.machine.selection.shapeTools(this.availableTools());
  }

  shapeHistory(messages: readonly ContextMessage[]): readonly ContextMessage[] {
    return this.machine.selection.shapeHistory(messages);
  }

  select(names: readonly string[]): LoadToolsResult {
    return this.machine.selection.load(names);
  }

  selectionEnabled(): boolean {
    return this.machine.selection.enabled();
  }

  drainPendingToolSchemas(): readonly Tool[] | undefined {
    return this.machine.selection.drainPendingToolSchemas();
  }

  loadableToolsAnnouncement(): string | undefined {
    return this.machine.selection.loadableToolsAnnouncement();
  }

  async *execute(
    calls: ToolCall[],
    options: ToolExecutorExecuteOptions,
  ): AsyncIterable<ToolExecutionResult> {
    if (calls.length === 0) return;
    const reply: { stream?: BatchStream } = {};
    this.context.send({
      type: 'toolExecutor.executeBatch',
      calls,
      options,
      reply,
    } satisfies ToolExecutorExecuteEvent);
    const stream = reply.stream!;
    try {
      while (true) {
        const step = await stream.next();
        if (step.done === true) return;
        yield step.value;
      }
    } finally {
      await stream.settled;
    }
  }

  get onWillExecute(): Event<WillExecuteToolEvent> {
    return this.machine.willExecuteEmitter.event;
  }

  get onDidExecute(): Event<ToolExecutionFinishedEvent> {
    return this.machine.didExecuteEmitter.event;
  }

  participateExecution(
    name: string,
    listener: ToolExecutionVetoListener,
    order: ToolExecutionParticipationOrder = 'prePolicy',
  ): IDisposable {
    return this.machine.vetoBus.register(name, listener, order);
  }

  registerDidExecuteHook(
    name: string,
    hook: ToolDidExecuteHook,
    order: ToolExecutionParticipationOrder = 'prePolicy',
  ): IDisposable {
    return this.machine.didHooks.register(name, hook, order);
  }

  registerToolCallGuard(guard: ToolCallGuard): IDisposable {
    const slot = this.machine.guardSlot;
    slot.current = guard;
    return toDisposable(() => {
      if (slot.current === guard) slot.current = undefined;
    });
  }

  registerUnavailableToolDescriber(describer: UnavailableToolDescriber): IDisposable {
    const slot = this.machine.unavailableDescriberSlot;
    slot.current = describer;
    return toDisposable(() => {
      if (slot.current === describer) slot.current = undefined;
    });
  }

  registerMissingToolDescriber(describer: MissingToolDescriber): IDisposable {
    const slot = this.machine.missingDescriberSlot;
    slot.current = describer;
    return toDisposable(() => {
      if (slot.current === describer) slot.current = undefined;
    });
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
    const { context } = snapshot as unknown as ToolExecutorMachineSnapshot;
    return {
      veto: context.vetoBus.participantNames(),
      did: context.didHooks.order,
    };
  },
});
