/**
 * `workflow` domain (L4) — workflow-mode context injection.
 *
 * Owns the `workflow_mode` context-injection provider: while workflow mode is
 * active it emits the enter reminder (re-injected after compaction), and on
 * the first inject after deactivation it emits the exit reminder. It reads the
 * live workflow state through `IWorkflowModeService` and the recent history
 * through `IAgentContextMemoryService`. The plain-data state (`wasActive`) is
 * registered into `agentState` (`IAgentStateService`) and read/written through
 * it.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { defineState } from '#/_base/state/stateRegistry';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentStateService } from '#/agent/state/agentState';
import { IWorkflowModeService } from '#/agent/workflow/workflowMode';
import ENTER_REMINDER from './enter-reminder.md?raw';
import EXIT_REMINDER from './exit-reminder.md?raw';

const WORKFLOW_MODE_INJECTION_VARIANT = 'workflow_mode';

export const workflowWasActiveKey = defineState<boolean>('workflow.wasActive', () => false);

export class WorkflowModeInjection extends Disposable {
  constructor(
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IWorkflowModeService private readonly workflow: IWorkflowModeService,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.register(workflowWasActiveKey);

    this._register(
      dynamicInjector.register(WORKFLOW_MODE_INJECTION_VARIANT, () => {
        const { isActive } = this.workflow;

        if (isActive) {
          if (!this.states.get(workflowWasActiveKey)) {
            this.states.set(workflowWasActiveKey, true);
          }
          return ENTER_REMINDER;
        }

        if (this.states.get(workflowWasActiveKey)) {
          this.states.set(workflowWasActiveKey, false);
          return EXIT_REMINDER;
        }

        return undefined;
      }),
    );
  }
}
