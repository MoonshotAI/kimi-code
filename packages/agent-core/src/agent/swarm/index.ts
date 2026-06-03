import type { Agent } from '..';
import type { ContentPart } from '@moonshot-ai/kosong';

import SWARM_MODE_REMINDER from './swarm-mode-reminder.md';

const SWARM_MODE_EXIT_REMINDER = 'Swarm mode has ended.';

export class SwarmMode {
  protected active = false;

  constructor(protected readonly agent: Agent) {}

  run(input: readonly ContentPart[]): void {
    this.agent.records.logRecord({ type: 'swarm_mode.enter' });
    this.active = true;
    this.agent.context.appendSystemReminder(SWARM_MODE_REMINDER, {
      kind: 'injection',
      variant: 'swarm_mode',
    });
    this.agent.emitStatusUpdated();
    if (this.agent.records.restoring) {
      this.agent.turn.restorePrompt();
    } else {
      const turnId = this.agent.turn.prompt(input);
      if (turnId === null) this.exit();
    }
  }

  exit(): void {
    if (!this.active) return;
    this.agent.records.logRecord({ type: 'swarm_mode.exit' });
    this.active = false;
    if (this.agent.records.restoring) {
      return;
    }
    this.agent.context.appendSystemReminder(SWARM_MODE_EXIT_REMINDER, {
      kind: 'injection',
      variant: 'swarm_mode_exit',
    });
    this.agent.emitStatusUpdated();
  }

  get isActive(): boolean {
    return this.active;
  }
}
