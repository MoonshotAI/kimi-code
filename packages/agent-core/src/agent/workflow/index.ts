import type { Agent } from '..';

import ENTER_REMINDER from './enter-reminder.md?raw';
import EXIT_REMINDER from './exit-reminder.md?raw';

export type WorkflowModeTrigger = 'manual' | 'command';

export class WorkflowMode {
  protected active: WorkflowModeTrigger | null = null;

  constructor(protected readonly agent: Agent) {}

  enter(trigger: WorkflowModeTrigger): void {
    if (this.active !== null) return;
    this.agent.records.logRecord({ type: 'workflow_mode.enter', trigger });
    this.active = trigger;
    this.agent.context.appendSystemReminder(ENTER_REMINDER, {
      kind: 'injection',
      variant: 'workflow_mode',
    });
    this.agent.emitStatusUpdated();
  }

  exit(): void {
    if (this.active === null) return;
    this.agent.records.logRecord({ type: 'workflow_mode.exit' });
    const trigger = this.active;
    this.active = null;
    this.agent.emitStatusUpdated();
    if (trigger === 'command') {
      /* ok, inject exit reminder */
    }
    if (
      this.agent.context.popMatchedMessage(
        (origin) => origin?.kind === 'injection' && origin.variant === 'workflow_mode',
      )
    ) {
      return;
    }
    if (!this.agent.records.restoring) {
      this.agent.context.appendSystemReminder(EXIT_REMINDER, {
        kind: 'injection',
        variant: 'workflow_mode_exit',
      });
    }
  }

  get isActive(): boolean {
    return this.active !== null;
  }

  restoreEnter(trigger: WorkflowModeTrigger): void {
    this.active = trigger;
  }
}
