import type { Agent } from '..';

import SWARM_MODE_ENTER_REMINDER from './enter-reminder.md';
import SWARM_MODE_EXIT_REMINDER from './exit-reminder.md';
import ULTRA_SWARM_MODE_ENTER_REMINDER from './ultra-enter-reminder.md';

/**
 * manual = persistent toggle (/swarm on);
 * task = one-shot /swarm prompt;
 * ultra = persistent Ultra swarm toggle (/ultramode on);
 * ultra_task = one-shot /ultramode prompt;
 * tool = AgentSwarm entry.
 */
export type SwarmModeTrigger = 'manual' | 'task' | 'ultra' | 'ultra_task' | 'tool';

export class SwarmMode {
  protected active: SwarmModeTrigger | null = null;

  constructor(protected readonly agent: Agent) {}

  enter(trigger: SwarmModeTrigger): void {
    if (this.active !== null) return;
    this.agent.records.logRecord({ type: 'swarm_mode.enter', trigger });
    this.active = trigger;
    if (trigger !== 'tool') {
      this.agent.context.appendSystemReminder(enterReminderForTrigger(trigger), {
        kind: 'injection',
        variant: injectionVariantForTrigger(trigger),
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
    if (trigger === 'tool') return;
    const variant = injectionVariantForTrigger(trigger);
    if (this.agent.context.popMatchedMessage((origin) => origin?.kind === 'injection' && origin.variant === variant)) {
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

  get trigger(): SwarmModeTrigger | undefined {
    return this.active ?? undefined;
  }

  get shouldAutoExit(): boolean {
    return this.active === 'task' || this.active === 'ultra_task' || this.active === 'tool';
  }
}

function enterReminderForTrigger(trigger: SwarmModeTrigger): string {
  return trigger === 'ultra' || trigger === 'ultra_task'
    ? ULTRA_SWARM_MODE_ENTER_REMINDER
    : SWARM_MODE_ENTER_REMINDER;
}

function injectionVariantForTrigger(
  trigger: Exclude<SwarmModeTrigger, 'tool'>,
): 'swarm_mode' | 'ultra_swarm_mode' {
  return trigger === 'ultra' || trigger === 'ultra_task' ? 'ultra_swarm_mode' : 'swarm_mode';
}
