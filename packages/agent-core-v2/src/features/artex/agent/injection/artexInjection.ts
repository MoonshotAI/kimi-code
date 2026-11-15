import { Disposable } from '#/_base/di/lifecycle';
import type { IAgentReminderService } from '#/features/reminder/reminderService';
import type {
  ContextInjectionContext,
  ContextInjectionResult,
} from '#/features/reminder/types';

import { ARTEX_MODE_INJECTION_VARIANT } from '../artexMode';
import ARTEX_MODE_ENTER_REMINDER from '../artex-enter-reminder.md?raw';

interface ArtexModeInjectionDisclosure {
  readonly kind: 'artex_mode';
  readonly state: 'active';
}

export interface ArtexInjectionOptions {
  readonly isActive: () => boolean;
}

export class ArtexPlanningInjection extends Disposable {
  constructor(
    private readonly options: ArtexInjectionOptions,
    injector: IAgentReminderService,
  ) {
    super();
    this._register(
      injector.register<ArtexModeInjectionDisclosure>(
        ARTEX_MODE_INJECTION_VARIANT,
        (context) => this.reminder(context),
      ),
    );
  }

  private reminder(
    context: ContextInjectionContext<ArtexModeInjectionDisclosure>,
  ): ContextInjectionResult<ArtexModeInjectionDisclosure> | undefined {
    if (!this.options.isActive()) return undefined;
    if (context.injectedPositions.length > 0) return undefined;
    return {
      content: ARTEX_MODE_ENTER_REMINDER,
      disclosure: { kind: 'artex_mode', state: 'active' },
    };
  }
}
