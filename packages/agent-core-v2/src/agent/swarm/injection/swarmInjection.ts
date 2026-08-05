/**
 * `swarm` domain — swarm-mode context injection.
 *
 * Owns the `swarm_mode` context-injection provider, mirroring
 * `permissionMode`: the enter guidance is re-announced whenever its live
 * positions are folded away (compaction), and enter/exit transitions render
 * the corresponding reminder. Tool-triggered swarms never render — the
 * AgentSwarm tool result already tells the model. The plain-data
 * last-rendered flag is registered into `agentState` (`IAgentStateService`)
 * and read/written through it; on wire restore it is seeded from the last
 * `swarm_mode` reminder surviving in the replayed history, so a resume
 * neither duplicates the live enter guidance nor leaves a stale one
 * uncorrected (a seeded `active` that no longer matches the model renders
 * the exit reminder).
 */

import { Disposable } from '#/_base/di/lifecycle';
import { defineState } from '#/_base/state/stateRegistry';
import {
  IAgentContextInjectorService,
  type ContextInjectionContext,
} from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentStateService } from '#/agent/state/agentState';
import { IWireService } from '#/wire/wire';

import SWARM_MODE_ENTER_REMINDER from '../enter-reminder.md?raw';
import SWARM_MODE_EXIT_REMINDER from '../exit-reminder.md?raw';
import type { SwarmModeTrigger } from '../swarm';

const SWARM_MODE_INJECTION_VARIANT = 'swarm_mode';

export const swarmLastRenderedKey = defineState<'active' | 'inactive' | undefined>(
  'swarm.lastRendered',
  () => undefined as 'active' | 'inactive' | undefined,
);

export interface SwarmInjectionOptions {
  readonly getTrigger: () => SwarmModeTrigger | null;
}

export class SwarmInjection extends Disposable {
  constructor(
    private readonly options: SwarmInjectionOptions,
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IWireService wire: IWireService,
  ) {
    super();
    this.states.register(swarmLastRenderedKey);
    this._register(
      dynamicInjector.register(SWARM_MODE_INJECTION_VARIANT, (ctx) => this.reminder(ctx)),
    );
    this._register(
      wire.hooks.onDidRestore.register('swarm-injection', async (_ctx, next) => {
        // Replay rebuilt the history; seed the live flag from the last
        // rendered reminder so the resume neither duplicates live guidance
        // nor leaves a stale one uncorrected.
        const rendered = lastRenderedFromHistory(this.context.get());
        if (rendered !== undefined) this.lastRendered = rendered;
        await next();
      }),
    );
  }

  private get lastRendered(): 'active' | 'inactive' | undefined {
    return this.states.get(swarmLastRenderedKey);
  }

  private set lastRendered(value: 'active' | 'inactive' | undefined) {
    this.states.set(swarmLastRenderedKey, value);
  }

  private reminder({ injectedPositions }: ContextInjectionContext): string | undefined {
    const trigger = this.options.getTrigger();
    const active = trigger !== null && trigger !== 'tool';
    if (active === (this.lastRendered === 'active')) {
      if (injectedPositions.length > 0 || !active) return undefined;
      return SWARM_MODE_ENTER_REMINDER;
    }
    this.lastRendered = active ? 'active' : 'inactive';
    return active ? SWARM_MODE_ENTER_REMINDER : SWARM_MODE_EXIT_REMINDER;
  }
}

/**
 * Recover the rendered state from the replayed history: the last
 * `swarm_mode` reminder whose content still matches an enter/exit render.
 * Legacy exit reminders (variant `swarm_mode_exit`, written before the
 * injector owned the render) are matched too; an unrecognized latest
 * reminder seeds nothing.
 */
function lastRenderedFromHistory(
  history: readonly ContextMessage[],
): 'active' | 'inactive' | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!;
    const origin = message.origin;
    if (origin?.kind !== 'injection') continue;
    if (origin.variant !== SWARM_MODE_INJECTION_VARIANT && origin.variant !== 'swarm_mode_exit') {
      continue;
    }
    const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    if (text === `<system-reminder>\n${SWARM_MODE_ENTER_REMINDER.trim()}\n</system-reminder>`) {
      return 'active';
    }
    if (text === `<system-reminder>\n${SWARM_MODE_EXIT_REMINDER.trim()}\n</system-reminder>`) {
      return 'inactive';
    }
    return undefined;
  }
  return undefined;
}
