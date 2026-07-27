/**
 * `workflow` domain (L4) — `IWorkflowModeService` implementation.
 *
 * Tracks workflow-mode enter/exit in the `wire` `WorkflowModel` (mutated only
 * through the `workflow_mode.enter` / `workflow_mode.exit` Ops, read through
 * `wire.getModel`), mirrors it into `systemReminder` as live-only side effects,
 * and derives `agent.status.updated` from the Ops' `toEvent`.
 *
 * The enter-reminder removal on exit is a cross-model fold on `ContextModel`
 * (see `contextOps.ts`): dispatching `workflow_mode.exit` pops the reminder
 * when it is the last message, both live and on replay — exactly like v1's
 * restore-time `popMatchedMessage`. The service only publishes the live-only
 * `context.spliced` event for that pop (so injector bookkeeping stays in step)
 * and appends the exit reminder when nothing was popped.
 *
 * Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventBus } from '#/app/event/eventBus';
import { IWireService } from '#/wire/wire';
import ENTER_REMINDER from './enter-reminder.md?raw';
import EXIT_REMINDER from './exit-reminder.md?raw';
import { IWorkflowModeService, type WorkflowModeTrigger } from './workflowMode';
import { workflowModeEnter, workflowModeExit, WorkflowModel } from './workflowModeOps';
import { WorkflowModeInjection } from './workflowModeInjector';

export class WorkflowModeService extends Disposable implements IWorkflowModeService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWireService private readonly wire: IWireService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IAgentStateService states: IAgentStateService,
  ) {
    super();
    this._register(new WorkflowModeInjection(dynamicInjector, this, states));
  }

  enter(trigger: WorkflowModeTrigger): void {
    if (this.wire.getModel(WorkflowModel) !== null) return;
    this.wire.dispatch(workflowModeEnter({ trigger }));
    this.reminders.appendSystemReminder(ENTER_REMINDER, {
      kind: 'injection',
      variant: 'workflow_mode',
    });
  }

  exit(): void {
    const trigger = this.wire.getModel(WorkflowModel);
    if (trigger === null) return;
    const history = this.context.get();
    const last = history[history.length - 1];
    const willPop =
      last?.origin?.kind === 'injection' && last.origin.variant === 'workflow_mode';
    this.wire.dispatch(workflowModeExit({}));
    if (willPop) {
      this.eventBus.publish({
        type: 'context.spliced',
        start: history.length - 1,
        deleteCount: 1,
        messages: [],
      });
      return;
    }
    this.reminders.appendSystemReminder(EXIT_REMINDER, {
      kind: 'injection',
      variant: 'workflow_mode_exit',
    });
  }

  get isActive(): boolean {
    return this.wire.getModel(WorkflowModel) !== null;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IWorkflowModeService,
  WorkflowModeService,
  ScopeActivation.OnScopeCreated,
  'workflow',
);
