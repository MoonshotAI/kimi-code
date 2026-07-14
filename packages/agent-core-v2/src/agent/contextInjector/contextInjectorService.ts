/**
 * `contextInjector` domain (L4) — `IAgentContextInjectorService` implementation.
 *
 * Injects registered context providers through `loop` and `systemReminder`,
 * tracks their positions in `contextMemory` through `eventBus`, and reconciles
 * those positions after `wire` restoration. Bound at Agent scope.
 */

import { Disposable, toDisposable } from "#/_base/di/lifecycle";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IEventBus } from '#/app/event/eventBus';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService } from '#/wire/wireService';
import {
  IAgentContextInjectorService,
  type ContextInjectionProvider,
} from './contextInjector';

interface ContextInjectionEntry {
  readonly provider: ContextInjectionProvider;
  readonly name: string;
  readonly positions: number[];
}

export class AgentContextInjectorService extends Disposable implements IAgentContextInjectorService {
  declare readonly _serviceBrand: undefined;
  private readonly entries = new Set<ContextInjectionEntry>();
  private isNewTurn = true;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentLoopService loopService: IAgentLoopService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentWireService wire: IWireService,
  ) {
    super();
    this._register(
      loopService.hooks.onWillBeginStep.register('context-injector', async (_ctx, next) => {
        await next();
        await this.inject();
      }),
    );
    this._register(
      this.eventBus.subscribe('turn.started', () => {
        this.isNewTurn = true;
      }),
    );
    this._register(this.eventBus.subscribe('context.spliced', (e) => {
      this.handleSplice(e);
    }));
    this._register(wire.onRestored(() => {
      this.resyncPositions();
    }));
  }

  register(
    name: string,
    provider: ContextInjectionProvider,
  ) {
    const positions = findInjections(this.context.get(), name);
    const entry: ContextInjectionEntry = {
      provider,
      name,
      positions,
    };
    this.entries.add(entry);
    return toDisposable(() => {
      this.entries.delete(entry);
    });
  }

  async injectAfterCompaction(): Promise<void> {
    this.isNewTurn = true;
    await this.inject();
  }

  private async inject(): Promise<void> {
    const isNewTurn = this.isNewTurn;
    this.isNewTurn = false;
    for (const entry of this.entries) {
      const injectedPositions: readonly number[] = [...entry.positions];
      const content = await entry.provider({
        injectedPositions,
        lastInjectedAt: injectedPositions.at(-1) ?? null,
        isNewTurn,
      });
      if (!this.entries.has(entry)) continue;
      if (content === undefined) continue;
      const origin = { kind: 'injection' as const, variant: entry.name };
      if (typeof content === 'string') {
        if (content.trim().length === 0) continue;
        this.reminders.appendSystemReminder(content, origin);
        continue;
      }
      if (content.length === 0) continue;
      this.context.append({
        role: 'user',
        content: [...content],
        toolCalls: [],
        origin,
      });
    }
  }

  private resyncPositions(): void {
    const history = this.context.get();
    for (const entry of this.entries) {
      const found = findInjections(history, entry.name);
      entry.positions.length = 0;
      entry.positions.push(...found);
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
      const adopted = insertedInjections?.get(entry.name) ?? [];
      const positions = entry.positions;
      if (adopted.length === 0 && positions.length === 0) continue;
      let lo = 0;
      while (lo < positions.length && positions[lo]! < splice.start) lo++;
      let hi = lo;
      while (hi < positions.length && positions[hi]! < deletedEnd) hi++;
      for (let index = hi; index < positions.length; index++) {
        positions[index] = positions[index]! + delta;
      }
      positions.splice(lo, hi - lo, ...adopted);
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
