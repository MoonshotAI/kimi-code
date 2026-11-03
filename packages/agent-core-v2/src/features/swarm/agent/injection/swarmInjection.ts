import { Disposable } from '#/_base/di/lifecycle';
import type { IAgentReminderService } from '#/features/reminder/reminderService';
import type { ContextInjectionResult } from '#/features/reminder/types';

import SWARM_MODE_ENTER_REMINDER from '../enter-reminder.md?raw';
import type { SwarmModeTrigger } from '../swarm';

const SWARM_MODE_INJECTION_VARIANT = 'swarm_mode';

interface SwarmModeInjectionDisclosure {
  readonly kind: 'swarm_mode';
  readonly state: 'active';
}

export interface SwarmInjectionOptions {
  readonly getTrigger: () => SwarmModeTrigger | null;
  readonly isReminderDelivered: () => boolean;
}

export class SwarmInjection extends Disposable {
  constructor(
    private readonly options: SwarmInjectionOptions,
    injector: IAgentReminderService,
  ) {
    super();
    this._register(
      injector.register<SwarmModeInjectionDisclosure>(
        SWARM_MODE_INJECTION_VARIANT,
        () => this.reminder(),
      ),
    );
  }

  private reminder(): ContextInjectionResult<SwarmModeInjectionDisclosure> | undefined {
    const trigger = this.options.getTrigger();
    if (trigger === null || trigger === 'tool' || this.options.isReminderDelivered()) return undefined;
    return {
      content: SWARM_MODE_ENTER_REMINDER,
      disclosure: { kind: 'swarm_mode', state: 'active' },
    };
  }
}
