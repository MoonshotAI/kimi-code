import type { Agent } from '..';

import SWARM_MODE_ENTER_REMINDER from './enter-reminder.md';
import SWARM_MODE_EXIT_REMINDER from './exit-reminder.md';

export class SwarmMode {
  protected active = false;

  constructor(protected readonly agent: Agent) {}

  enter(): void {
    if (this.active) return;
    this.agent.records.logRecord({ type: 'swarm_mode.enter' });
    this.active = true;
    this.agent.context.appendSystemReminder(SWARM_MODE_ENTER_REMINDER, {
      kind: 'injection',
      variant: 'swarm_mode',
    });
    this.agent.emitStatusUpdated({ swarmMode: true });
  }

  restoreEnter(): void {
    this.active = true;
  }

  exit(): void {
    if (!this.active) return;
    this.agent.records.logRecord({ type: 'swarm_mode.exit' });
    this.active = false;
    this.agent.emitStatusUpdated({ swarmMode: false });
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
    return this.active;
  }
}
