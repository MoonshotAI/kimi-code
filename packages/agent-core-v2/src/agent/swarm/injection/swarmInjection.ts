/**
 * `swarm` domain — swarm-mode context injection.
 *
 * Registers swarm-mode guidance through `contextInjector` and reads
 * `contextMemory` for restored legacy state. Used by the Agent-scoped swarm
 * service.
 */

import { Disposable } from '#/_base/di/lifecycle';
import {
  IAgentContextInjectorService,
  type ContextInjectionContext,
  type ContextInjectionResult,
} from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';

import SWARM_MODE_ENTER_REMINDER from '../enter-reminder.md?raw';
import SWARM_MODE_EXIT_REMINDER from '../exit-reminder.md?raw';
import type { SwarmModeTrigger } from '../swarm';

const SWARM_MODE_INJECTION_VARIANT = 'swarm_mode';
const LEGACY_SWARM_MODE_EXIT_VARIANT = 'swarm_mode_exit';

interface SwarmModeInjectionDisclosure {
  readonly kind: 'swarm_mode';
  readonly state: 'active' | 'inactive';
}

export interface SwarmInjectionOptions {
  readonly getTrigger: () => SwarmModeTrigger | null;
}

export class SwarmInjection extends Disposable {
  constructor(
    private readonly options: SwarmInjectionOptions,
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
  ) {
    super();
    this._register(
      injector.register<SwarmModeInjectionDisclosure>(
        SWARM_MODE_INJECTION_VARIANT,
        (ctx) => this.reminder(ctx),
      ),
    );
  }

  private reminder(
    ctx: ContextInjectionContext<SwarmModeInjectionDisclosure>,
  ): ContextInjectionResult<SwarmModeInjectionDisclosure> | undefined {
    const trigger = this.options.getTrigger();
    const active = trigger !== null && trigger !== 'tool';
    const rendered = this.renderedState(ctx);
    if (active) {
      return rendered === 'active'
        ? undefined
        : {
            content: SWARM_MODE_ENTER_REMINDER,
            disclosure: { kind: 'swarm_mode', state: 'active' },
          };
    }
    return rendered === 'active'
      ? {
          content: SWARM_MODE_EXIT_REMINDER,
          disclosure: { kind: 'swarm_mode', state: 'inactive' },
        }
      : undefined;
  }

  private renderedState(
    ctx: ContextInjectionContext<SwarmModeInjectionDisclosure>,
  ): 'active' | 'inactive' | undefined {
    if (ctx.lastDisclosure !== undefined) return ctx.lastDisclosure.state;
    const history = this.context.get();
    for (let i = history.length - 1; i >= 0; i--) {
      const origin = history[i]!.origin;
      if (origin?.kind !== 'injection') continue;
      if (origin.variant === LEGACY_SWARM_MODE_EXIT_VARIANT) return 'inactive';
      if (origin.variant === SWARM_MODE_INJECTION_VARIANT) return 'active';
    }
    return undefined;
  }
}
