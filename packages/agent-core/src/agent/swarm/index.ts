import { createDecorator } from '../../di';
import { IContextService } from '../context';
import { IRecordsService } from '../records';

import SWARM_MODE_ENTER_REMINDER from './enter-reminder.md?raw';
import SWARM_MODE_EXIT_REMINDER from './exit-reminder.md?raw';

/**
 * manual = persistent toggle (/swarm on);
 * task = one-shot /swarm prompt;
 * tool = AgentSwarm entry.
 */
export type SwarmModeTrigger = 'manual' | 'task' | 'tool';

export class SwarmMode {
  protected active: SwarmModeTrigger | null = null;

  constructor(
    private readonly emitStatusUpdated?: () => void,
    @IRecordsService private readonly records?: IRecordsService,
    @IContextService private readonly context?: IContextService,
  ) {}

  enter(trigger: SwarmModeTrigger): void {
    if (this.active !== null) return;
    this.records?.logRecord({ type: 'swarm_mode.enter', trigger });
    this.active = trigger;
    if (trigger !== 'tool') {
      this.context?.appendSystemReminder(SWARM_MODE_ENTER_REMINDER, {
        kind: 'injection',
        variant: 'swarm_mode',
      });
    }
    this.emitStatusUpdated?.();
  }

  restoreEnter(trigger: SwarmModeTrigger): void {
    this.active = trigger;
  }

  exit(): void {
    if (this.active === null) return;
    this.records?.logRecord({ type: 'swarm_mode.exit' });
    const trigger = this.active;
    this.active = null;
    this.emitStatusUpdated?.();
    if (trigger === 'tool') return;
    if (this.context?.popMatchedMessage((origin) => origin?.kind === 'injection' && origin.variant === 'swarm_mode')) {
      return;
    }
    if (!this.records?.restoring) {
      this.context?.appendSystemReminder(SWARM_MODE_EXIT_REMINDER, {
        kind: 'injection',
        variant: 'swarm_mode_exit',
      });
    }
  }

  get isActive(): boolean {
    return this.active !== null;
  }

  get shouldAutoExit(): boolean {
    return this.active === 'task' || this.active === 'tool';
  }
}

export interface ISwarmService extends Pick<SwarmMode, keyof SwarmMode> {
  readonly _serviceBrand: undefined;

  /** @internal migration bridge — reach the raw manager; do not use in new code. */
  unwrap(): SwarmMode;
}

export const ISwarmService = createDecorator<ISwarmService>('swarmService');

export class SwarmService extends SwarmMode implements ISwarmService {
  readonly _serviceBrand: undefined;
  unwrap(): SwarmMode {
    return this;
  }
}
