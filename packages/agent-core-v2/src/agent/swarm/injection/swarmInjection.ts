/**
 * `swarm` domain — swarm-mode context injection.
 *
 * Owns the `swarm_mode` context-injection provider, mirroring
 * `permissionMode`: the enter guidance is re-announced whenever its live
 * positions are folded away (compaction), and enter/exit transitions render
 * the corresponding reminder. Tool-triggered swarms never render — the
 * AgentSwarm tool result already tells the model. Reconciliation derives the
 * rendered state from the latest surviving `contextMemory` message, so undo,
 * compaction, and restore cannot leave a stale in-memory render flag.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';

import SWARM_MODE_ENTER_REMINDER from '../enter-reminder.md?raw';
import SWARM_MODE_EXIT_REMINDER from '../exit-reminder.md?raw';
import type { SwarmModeTrigger } from '../swarm';

const SWARM_MODE_INJECTION_VARIANT = 'swarm_mode';

export interface SwarmInjectionOptions {
  readonly getTrigger: () => SwarmModeTrigger | null;
}

export class SwarmInjection extends Disposable {
  constructor(
    private readonly options: SwarmInjectionOptions,
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
  ) {
    super();
    this._register(
      dynamicInjector.register(SWARM_MODE_INJECTION_VARIANT, () => this.reminder()),
    );
  }

  private reminder(): string | undefined {
    const trigger = this.options.getTrigger();
    const active = trigger !== null && trigger !== 'tool';
    const rendered = lastRenderedFromHistory(this.context.get());
    if (active) return rendered === 'active' ? undefined : SWARM_MODE_ENTER_REMINDER;
    return rendered === 'active' ? SWARM_MODE_EXIT_REMINDER : undefined;
  }
}

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
