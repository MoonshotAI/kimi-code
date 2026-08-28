import { Service } from '#/_base/di/service';
import { activateReminderWhenReady } from '#/features/reminder/internal/reminderActivation';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentContextMemory, ContextMemoryRuntime } from '#/features/contextMemory/contextMemoryAgentRuntime';
import { TurnEnded } from '#/features/loop/turnOps';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/features/toolExecutor/toolHooks';
import { activateToolExecutorWhenReady } from '#/features/toolExecutor/internal/executorActivation';
import { IEventBus } from '#/app/event/eventBus';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { SwarmInjection } from './injection/swarmInjection';
import { IAgentSwarmService, type SwarmModeTrigger } from './swarm';
import { SwarmModeEnter, SwarmModeExit, swarmKey } from '../swarmOps';

export class AgentSwarmService extends Service implements IAgentSwarmService {
  declare readonly _serviceBrand: undefined;

  private readonly context: ContextMemoryRuntime;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentLifecycleService manager: IAgentLifecycleService,
    @IEventBus eventBus: IEventBus,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    private readonly agentCtx: IAgentScopeContext,
    @IAgentStateService private readonly agentState: IAgentStateService,
  ) {
    super();
    this.context = manager.resolve(agentCtx.agentContext, AgentContextMemory);
    this.agentState.contributeState(swarmKey);
    this._register(
      activateReminderWhenReady(manager, this.agentCtx, (reminder) =>
        new SwarmInjection(
          { getTrigger: () => this.agentState.get(swarmKey) },
          reminder,
          this.context,
        ),
      ),
    );
    this._register(
      eventBus.subscribe(TurnEnded, () => {
        if (this.shouldAutoExit) {
          this.exit();
        }
      }),
    );
    this._register(
      activateToolExecutorWhenReady(manager, this.agentCtx, (executor) =>
        executor.participateExecution('swarm', (event) => {
          const agentSwarmCount = event.toolCalls.filter(
            (toolCall) => toolCall.name === 'AgentSwarm',
          ).length;
          if (agentSwarmCount === 0 || (agentSwarmCount === 1 && event.toolCalls.length === 1)) {
            return;
          }
          event.veto(
            denyToolExecution(
              this.toolApproval.formatDenyMessage(
                agentSwarmCount > 1
                  ? multipleAgentSwarmDeniedMessage(event.toolCalls.length > agentSwarmCount)
                  : mixedAgentSwarmDeniedMessage(),
              ),
            ),
          );
        }),
      ),
    );
  }

  enter(trigger: SwarmModeTrigger): void {
    if (this.agentState.get(swarmKey) !== null) return;
    void this.dispatcher.dispatch(new SwarmModeEnter({ agentId: this.agentCtx.agentId, trigger }));
  }

  exit(): void {
    if (this.agentState.get(swarmKey) === null) return;
    const history = this.context.get();
    void this.dispatcher.dispatch(new SwarmModeExit({ agentId: this.agentCtx.agentId }));
    this.context.publishTrailingRemoval(history);
  }

  get isActive(): boolean {
    return this.agentState.get(swarmKey) !== null;
  }

  private get shouldAutoExit(): boolean {
    const trigger = this.agentState.get(swarmKey);
    return trigger === 'task' || trigger === 'tool';
  }
}

function multipleAgentSwarmDeniedMessage(hasOtherToolCalls: boolean): string {
  const suffix = hasOtherToolCalls
    ? ' AgentSwarm also must not be combined with other tools in the same response.'
    : '';
  return (
    'AgentSwarm must be called one swarm at a time. Multiple AgentSwarm calls are not forbidden, ' +
    'but issue them sequentially: call one AgentSwarm, wait for its result, then call the next; ' +
    `or merge the work into a single AgentSwarm when one swarm can cover it.${suffix}`
  );
}

function mixedAgentSwarmDeniedMessage(): string {
  return (
    'AgentSwarm must be the only tool call in a model response. Retry with a single AgentSwarm ' +
    'call by itself, then call any other tools after it returns.'
  );
}
