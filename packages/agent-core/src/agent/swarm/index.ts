import type { Agent } from '..';

import SWARM_MODE_ENTER_REMINDER from './enter-reminder.md';
import SWARM_MODE_EXIT_REMINDER from './exit-reminder.md';

export type SwarmModeTrigger = 'explicit' | 'implicit';

export class SwarmMode {
  protected active: SwarmModeTrigger | null = null;

  constructor(protected readonly agent: Agent) {}

  enter(trigger: SwarmModeTrigger): void {
    if (this.active !== null) return;
    this.agent.records.logRecord({ type: 'swarm_mode.enter', trigger });
    this.active = trigger;
    if (trigger === 'explicit') {
      this.agent.context.appendSystemReminder(SWARM_MODE_ENTER_REMINDER, {
        kind: 'injection',
        variant: 'swarm_mode',
      });
    }
    this.agent.emitStatusUpdated();
  }

  restoreEnter(trigger: SwarmModeTrigger): void {
    this.active = trigger;
  }

  exit(): void {
    if (this.active === null) return;
    this.agent.records.logRecord({ type: 'swarm_mode.exit' });
    const trigger = this.active;
    this.active = null;
    this.agent.emitStatusUpdated();
    if (trigger !== 'explicit') return;
    if (this.agent.context.popMatchedMessage((origin) => origin?.kind === 'injection' && origin.variant === 'swarm_mode')) {
      return;
    }
    if (!this.agent.records.restoring) {
      this.agent.context.appendSystemReminder(SWARM_MODE_EXIT_REMINDER, {
        kind: 'injection',
        variant: 'swarm_mode_exit',
      });
    }
  }

  get isActive(): boolean {
    return this.active !== null;
  }
}
