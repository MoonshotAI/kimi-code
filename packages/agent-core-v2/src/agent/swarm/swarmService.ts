/**
 * `swarm` domain — `IAgentSwarmService` implementation.
 *
 * Tracks swarm-mode enter/exit in the `wire` `SwarmModel` (mutated only through
 * the `swarm_mode.enter` / `swarm_mode.exit` Ops, read through `wire.getModel`),
 * derives `agent.status.updated` from the Ops' `toEvent`, announces the mode
 * through the `swarm_mode` context-injection provider (`SwarmInjection`),
 * mirrors replayable trailing-enter removal through `contextMemory`, and
 * auto-exits on turn end via `turn`. Bound at Agent scope. The service also
 * guards AgentSwarm batch exclusivity through an `onBeforeExecuteTool` veto
 * listener: an AgentSwarm call must be the only tool call in its batch;
 * anything else is vetoed with a `toolApproval.formatDenyMessage`-formatted
 * reason.
 */

import { Service } from '#/_base/di/service';
import { IInstantiationService } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IEventBus } from '#/app/event/eventBus';
import { IWireService } from '#/wire/wire';

import { SwarmInjection } from './injection/swarmInjection';
import { IAgentSwarmService, type SwarmModeTrigger } from './swarm';
import { swarmEnter, swarmExit, SwarmModel } from './swarmOps';

export class AgentSwarmService extends Service implements IAgentSwarmService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWireService private readonly wire: IWireService,
    @IInstantiationService instantiation: IInstantiationService,
    @IEventBus eventBus: IEventBus,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
  ) {
    super();
    this._register(
      instantiation.createInstance(SwarmInjection, {
        getTrigger: () => this.wire.getModel(SwarmModel),
      }),
    );
    this._register(
      eventBus.subscribe('turn.ended', () => {
        if (this.shouldAutoExit) {
          this.exit();
        }
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
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
    );
  }

  enter(trigger: SwarmModeTrigger): void {
    if (this.wire.getModel(SwarmModel) !== null) return;
    this.wire.dispatch(swarmEnter({ trigger }));
  }

  exit(): void {
    if (this.wire.getModel(SwarmModel) === null) return;
    const history = this.context.get();
    this.wire.dispatch(swarmExit({}));
    this.context.publishTrailingRemoval(history);
  }

  get isActive(): boolean {
    return this.wire.getModel(SwarmModel) !== null;
  }

  private get shouldAutoExit(): boolean {
    const trigger = this.wire.getModel(SwarmModel);
    return trigger === 'task' || trigger === 'tool';
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSwarmService,
  AgentSwarmService,
  ScopeActivation.OnScopeCreated,
  'swarm',
);

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
