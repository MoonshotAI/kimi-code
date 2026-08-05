/**
 * `contextInjector` domain — `IAgentContextInjectorService` implementation.
 *
 * The unified boundary scheduler for every model-facing reminder. It drains
 * the persisted once-reminder queue (`reminderQueue`, past-tense events,
 * exactly-once) ahead of reconciling the registered context providers
 * (present-tense state) through `loop` and `systemReminder`, tracks provider
 * positions in `contextMemory` through `eventBus`, and reconciles those
 * positions after `wire` restoration. Each provider call receives the
 * newest surviving injection of its own variant (`lastInjection`) and the
 * typed disclosure recorded on it (`lastDisclosure`), so providers never read
 * context layout or position indexes themselves. The plain-data `isNewTurn`
 * flag is registered into `agentState` (`IAgentStateService`) and read/written
 * through it; `entries` stays a plain instance field (its values hold provider
 * functions, not plain data). Bound at Agent scope.
 */

import { Disposable, toDisposable, type IDisposable } from "#/_base/di/lifecycle";
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentReminderQueueService } from '#/agent/reminderQueue/reminderQueue';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IEventBus } from '#/app/event/eventBus';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IWireService } from '#/wire/wire';
import {
  IAgentContextInjectorService,
  type ContextInjectionContent,
  type ContextInjectionProvider,
  type ContextInjectionResult,
  type SyncContextInjectionProvider,
} from './contextInjector';

interface ContextInjectionEntry {
  readonly provider: ContextInjectionProvider;
  readonly name: string;
  readonly positions: number[];
  readonly boundary: 'step' | 'turn-start';
}

export const contextInjectorIsNewTurnKey = defineState<boolean>(
  'contextInjector.isNewTurn',
  () => true,
);

export class AgentContextInjectorService extends Disposable implements IAgentContextInjectorService {
  declare readonly _serviceBrand: undefined;
  private readonly entries = new Set<ContextInjectionEntry>();

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentLoopService loopService: IAgentLoopService,
    @IAgentReminderQueueService private readonly reminderQueue: IAgentReminderQueueService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IEventBus private readonly eventBus: IEventBus,
    @IWireService wire: IWireService,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.register(contextInjectorIsNewTurnKey);
    this._register(
      loopService.hooks.onWillBeginStep.register('context-injector', async (_ctx, next) => {
        await next();
        await this.inject('step');
      }),
    );
    this._register(
      this.eventBus.subscribe('turn.started', () => {
        this.reminderQueue.drain();
        this.isNewTurn = true;
        this.injectAtTurnStart();
      }),
    );
    this._register(
      this.eventBus.subscribe('context.spliced', (e) => {
        this.handleSplice(e);
      }),
    );
    this._register(
      wire.hooks.onDidRestore.register('context-injector', async (_ctx, next) => {
        this.reminderQueue.drain();
        this.resyncPositions();
        await next();
      }),
    );
  }

  private get isNewTurn(): boolean {
    return this.states.get(contextInjectorIsNewTurnKey);
  }

  private set isNewTurn(value: boolean) {
    this.states.set(contextInjectorIsNewTurnKey, value);
  }

  register(
    name: string,
    provider: ContextInjectionProvider,
  ): IDisposable {
    return this.registerProvider(name, provider, 'step');
  }

  registerAtTurnStart(
    name: string,
    provider: SyncContextInjectionProvider,
  ): IDisposable {
    return this.registerProvider(name, provider, 'turn-start');
  }

  private registerProvider(
    name: string,
    provider: ContextInjectionProvider,
    boundary: ContextInjectionEntry['boundary'],
  ): IDisposable {
    const positions = findInjections(this.context.get(), name);
    const entry: ContextInjectionEntry = {
      provider,
      name,
      positions,
      boundary,
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

  private async inject(boundary?: ContextInjectionEntry['boundary']): Promise<void> {
    this.reminderQueue.drain();
    const isNewTurn = this.isNewTurn;
    this.isNewTurn = false;
    for (const entry of this.entries) {
      // A turn-start provider is also reconciled at the step boundary as a
      // fallback for facts that arrive after `turn.started` (for example, a
      // queued turn cancelled while another turn is already running).
      if (
        boundary !== undefined &&
        entry.boundary !== boundary &&
        !(boundary === 'step' && entry.boundary === 'turn-start')
      ) continue;
      const content = await entry.provider(this.providerContext(entry, isNewTurn));
      if (!this.entries.has(entry)) continue;
      this.appendResult(entry, content);
    }
  }

  private injectAtTurnStart(): void {
    for (const entry of this.entries) {
      if (entry.boundary !== 'turn-start') continue;
      const content = entry.provider(this.providerContext(entry, true));
      if (isThenable(content)) {
        throw new TypeError(`Turn-start context provider "${entry.name}" returned a Promise`);
      }
      if (!this.entries.has(entry)) continue;
      this.appendResult(entry, content);
    }
  }

  private providerContext(
    entry: ContextInjectionEntry,
    isNewTurn: boolean,
  ): Parameters<ContextInjectionProvider>[0] {
    const injectedPositions: readonly number[] = [...entry.positions];
    const lastInjectedAt = injectedPositions.at(-1) ?? null;
    const lastInjection = lastInjectedAt === null
      ? undefined
      : this.context.get()[lastInjectedAt];
    return {
      injectedPositions,
      lastInjectedAt,
      lastInjection,
      lastDisclosure:
        lastInjection?.origin?.kind === 'injection'
          ? lastInjection.origin.disclosure
          : undefined,
      isNewTurn,
    };
  }

  private appendResult(
    entry: ContextInjectionEntry,
    content: ContextInjectionContent | ContextInjectionResult | undefined,
  ): void {
    if (content === undefined) return;
    const result: ContextInjectionResult =
      typeof content === 'object' && content !== null && !Array.isArray(content)
        ? (content as ContextInjectionResult)
        : { content: content as ContextInjectionContent };
    const origin = {
      kind: 'injection' as const,
      variant: entry.name,
      disclosure: result.disclosure,
    };
    if (typeof result.content === 'string') {
      if (result.content.trim().length === 0) return;
      this.reminders.appendSystemReminder(result.content, origin);
      return;
    }
    if (result.content.length === 0) return;
    this.context.append({
      role: 'user',
      content: [...result.content],
      toolCalls: [],
      origin,
    });
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

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' && value !== null) || typeof value === 'function'
  ) && 'then' in value && typeof value.then === 'function';
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextInjectorService,
  AgentContextInjectorService,
  ScopeActivation.OnScopeCreated,
  'contextInjector',
);
