/**
 * `swarm` domain (L4) — `IAgentSwarmService` implementation.
 *
 * Tracks swarm-mode enter/exit in the `wire` `SwarmModel` (mutated only through
 * the `swarm_mode.enter` / `swarm_mode.exit` Ops, read through `wire.getModel`),
 * mirrors it into `systemReminder` as live-only side effects, derives
 * `agent.status.updated` from the Ops' `toEvent`, and auto-exits on turn end via
 * `turn`. The enter-reminder removal on exit is a cross-model fold on
 * `ContextModel` (see `contextOps.ts`): dispatching `swarm_mode.exit` pops the
 * reminder when it is the last message, both live and on replay — exactly like
 * v1's restore-time `popMatchedMessage`. The service only publishes the
 * live-only `context.spliced` event for that pop (so injector bookkeeping
 * stays in step) and appends the exit reminder when nothing was
 * popped. Bound at Agent scope. The `AgentSwarm` tool self-registers via
 * `registerTool(...)` in `tools/agent-swarm.ts`. The service also guards
 * AgentSwarm batch exclusivity through an `onBeforeExecuteTool` veto
 * listener: an AgentSwarm call must be the only tool call in its batch,
 * anything else is vetoed with a `toolApproval.formatDenyMessage`-formatted
 * reason.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IEventBus } from '#/app/event/eventBus';
import { IWireService } from '#/wire/wire';
import SWARM_MODE_ENTER_REMINDER from './enter-reminder.md?raw';
import SWARM_MODE_EXIT_REMINDER from './exit-reminder.md?raw';
import { IAgentSwarmService, type SwarmModeTrigger } from './swarm';
import { swarmEnter, swarmExit, SwarmModel } from './swarmOps';

export class AgentSwarmService extends Disposable implements IAgentSwarmService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWireService private readonly wire: IWireService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
  ) {
    super();
    this._register(
      this.eventBus.subscribe('turn.ended', () => {
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
    if (trigger !== 'tool') {
      this.reminders.appendSystemReminder(SWARM_MODE_ENTER_REMINDER, {
        kind: 'injection',
        variant: 'swarm_mode',
      });
    }
  }

  exit(): void {
    const trigger = this.wire.getModel(SwarmModel);
    if (trigger === null) return;
    const history = this.context.get();
    const last = history[history.length - 1];
    const willPop =
      last?.origin?.kind === 'injection' && last.origin.variant === 'swarm_mode';
    this.wire.dispatch(swarmExit({}));
    if (trigger === 'tool') return;
    if (willPop) {
      this.eventBus.publish({
        type: 'context.spliced',
        start: history.length - 1,
        deleteCount: 1,
        messages: [],
      });
      return;
    }
    this.reminders.appendSystemReminder(SWARM_MODE_EXIT_REMINDER, {
      kind: 'injection',
      variant: 'swarm_mode_exit',
    });
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
  InstantiationType.Eager,
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
