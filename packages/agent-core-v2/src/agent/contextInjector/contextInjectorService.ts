import {
  Disposable,
  toDisposable,
} from "#/_base/di";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IAgentLoopService } from '#/agent/loop';
import { IAgentSystemReminderService } from '#/agent/systemReminder';
import { IAgentTurnService } from '#/agent/turn';
import { IEventBus } from '#/app/event';
import type { ContextMessage } from '#/agent/contextMemory';
import {
  IAgentContextInjectorService,
  type ContextInjectionOptions,
  type ContextInjectionProvider,
} from './contextInjector';

interface ContextInjectionEntry {
  readonly cadence: ContextInjectionOptions['cadence'];
  readonly provider: ContextInjectionProvider;
  readonly variant: string;
  /** Live positions of this variant's injection messages, ascending. */
  readonly positions: number[];
  turnConsumed: boolean;
}

export class AgentContextInjectorService extends Disposable implements IAgentContextInjectorService {
  declare readonly _serviceBrand: undefined;
  private readonly entries = new Set<ContextInjectionEntry>();

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentTurnService turnService: IAgentTurnService,
    @IAgentLoopService loopService: IAgentLoopService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IEventBus private readonly eventBus: IEventBus,
  ) {
    super();
    this._register(
      loopService.hooks.beforeStep.register('context-injector', async (_ctx, next) => {
        await next();
        await this.inject();
      }),
    );
    this._register(
      this.eventBus.subscribe('turn.started', () => {
        for (const entry of this.entries) {
          entry.turnConsumed = false;
        }
      }),
    );
    this.eventBus.subscribe('context.spliced', (e) => this.handleSplice(e));
  }

  register(
    variant: string,
    provider: ContextInjectionProvider,
    options: ContextInjectionOptions = {},
  ) {
    const cadence = options.cadence ?? 'step';
    const positions = findInjections(this.context.get(), variant);
    const entry: ContextInjectionEntry = {
      cadence,
      provider,
      variant,
      positions,
      turnConsumed: cadence === 'turn' && positions.length > 0,
    };
    this.entries.add(entry);
    return toDisposable(() => {
      this.entries.delete(entry);
    });
  }

  private async inject(): Promise<void> {
    for (const entry of this.entries) {
      if (entry.cadence === 'turn') {
        if (entry.turnConsumed) continue;
        entry.turnConsumed = true;
      }
      const injectedPositions: readonly number[] = [...entry.positions];
      const content = await entry.provider({
        injectedPositions,
        lastInjectedAt: injectedPositions.at(-1) ?? null,
      });
      if (!this.entries.has(entry)) continue;
      if (content === undefined || content.trim().length === 0) continue;
      this.reminders.appendSystemReminder(content, {
        kind: 'injection',
        variant: entry.variant,
      });
    }
  }

  private handleSplice(splice: ContextSplice): void {
    let insertedInjections: Map<string, number[]> | undefined;
    splice.messages.forEach((message, offset) => {
      if (message.origin?.kind !== 'injection') return;
      insertedInjections ??= new Map();
      const positions = insertedInjections.get(message.origin.variant);
      if (positions === undefined) {
        insertedInjections.set(message.origin.variant, [splice.start + offset]);
      } else {
        positions.push(splice.start + offset);
      }
    });
    if (insertedInjections === undefined && splice.deleteCount === 0) return;

    const deletedEnd = splice.start + splice.deleteCount;
    const delta = splice.messages.length - splice.deleteCount;
    for (const entry of this.entries) {
      const adopted = insertedInjections?.get(entry.variant) ?? [];
      const positions = entry.positions;
      if (adopted.length === 0 && positions.length === 0) continue;
      // Mirror the context splice onto the ascending positions array: shift
      // survivors past the deleted range, then replace the deleted segment
      // with the adopted insertions (which land in [start, start + inserted)).
      let lo = 0;
      while (lo < positions.length && positions[lo]! < splice.start) lo++;
      let hi = lo;
      while (hi < positions.length && positions[hi]! < deletedEnd) hi++;
      for (let index = hi; index < positions.length; index++) {
        positions[index] = positions[index]! + delta;
      }
      positions.splice(lo, hi - lo, ...adopted);
      if (adopted.length > 0 && entry.cadence === 'turn') {
        entry.turnConsumed = true;
      }
    }
  }
}

type ContextSplice = {
  readonly start: number;
  readonly deleteCount: number;
  readonly messages: readonly ContextMessage[];
};

function findInjections(
  history: readonly ContextMessage[],
  variant: string,
): number[] {
  const positions: number[] = [];
  history.forEach((message, index) => {
    if (message.origin?.kind === 'injection' && message.origin.variant === variant) {
      positions.push(index);
    }
  });
  return positions;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextInjectorService,
  AgentContextInjectorService,
  InstantiationType.Delayed,
  'contextInjector',
);
