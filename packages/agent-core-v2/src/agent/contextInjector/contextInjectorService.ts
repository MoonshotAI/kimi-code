/**
 * `contextInjector` domain — `IAgentContextInjectorService` implementation.
 *
 * The unified boundary scheduler for every model-facing reminder. At each
 * injection boundary (turn start, step, compaction follow-up, wire restore)
 * it first fires `onWillInject` — where boundary participants such as the
 * `reminderQueue` drain their persisted once-reminders (past-tense events,
 * exactly-once) — then reconciles the registered context providers
 * (present-tense state) through `loop` and `systemReminder`. Provider
 * positions are never cached: each provider call derives them by scanning
 * `contextMemory` for its own surviving injection messages, so splices,
 * compaction folds, and `wire` restoration need no index bookkeeping. Each
 * provider call receives the newest surviving injection of its own variant
 * (`lastInjection`) and the typed disclosure recorded on it (`lastDisclosure`),
 * so providers never read context layout or position indexes themselves. Turn-start providers run
 * synchronously after `turn.started` — before the turn's first step request
 * materializes its prompt — and must stay synchronous (a provider that throws
 * or returns a Promise is logged and skipped, so one bad provider cannot
 * starve the rest); they are also reconciled at every later step
 * boundary as a fallback for facts that arrive after `turn.started` (for
 * example, a queued turn cancelled while another turn is already running).
 * The plain-data `isNewTurn` flag is registered
 * into `agentState` (`IAgentStateService`) and read/written through it;
 * `entries` stays a plain instance field (its values hold provider functions,
 * not plain data). Bound at Agent scope.
 */

import { Disposable, toDisposable, type IDisposable } from "#/_base/di/lifecycle";
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { defineState } from '#/_base/state/stateRegistry';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
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
  readonly boundary: 'step' | 'turn-start';
}

export const contextInjectorIsNewTurnKey = defineState<boolean>(
  'contextInjector.isNewTurn',
  () => true,
);

export class AgentContextInjectorService extends Disposable implements IAgentContextInjectorService {
  declare readonly _serviceBrand: undefined;
  private readonly entries = new Set<ContextInjectionEntry>();
  private readonly willInject = this._register(new Emitter<void>());
  readonly onWillInject: Event<void> = this.willInject.event;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentLoopService loopService: IAgentLoopService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IEventBus private readonly eventBus: IEventBus,
    @ILogService private readonly log: ILogService,
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
        this.willInject.fire();
        this.isNewTurn = true;
        this.injectAtTurnStart();
      }),
    );
    this._register(
      wire.hooks.onDidRestore.register('context-injector', async (_ctx, next) => {
        this.willInject.fire();
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
    const entry: ContextInjectionEntry = {
      provider,
      name,
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
    this.willInject.fire();
    const isNewTurn = this.isNewTurn;
    this.isNewTurn = false;
    for (const entry of this.entries) {
      if (boundary !== undefined && !shouldRunAtBoundary(entry, boundary)) continue;
      const content = await entry.provider(this.providerContext(entry, isNewTurn));
      if (!this.entries.has(entry)) continue;
      this.appendResult(entry, content);
    }
  }

  private injectAtTurnStart(): void {
    for (const entry of this.entries) {
      if (entry.boundary !== 'turn-start') continue;
      let content: ReturnType<ContextInjectionProvider>;
      try {
        content = entry.provider(this.providerContext(entry, true));
      } catch (error) {
        this.log.error('turn-start context provider failed; skipping it', {
          name: entry.name,
          error,
        });
        continue;
      }
      if (isThenable(content)) {
        this.log.error('turn-start context provider returned a Promise; skipping it', {
          name: entry.name,
        });
        continue;
      }
      if (!this.entries.has(entry)) continue;
      this.appendResult(entry, content);
    }
  }

  private providerContext(
    entry: ContextInjectionEntry,
    isNewTurn: boolean,
  ): Parameters<ContextInjectionProvider>[0] {
    const injectedPositions = findInjections(this.context.get(), entry.name);
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
}

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

function shouldRunAtBoundary(
  entry: ContextInjectionEntry,
  boundary: NonNullable<ContextInjectionEntry['boundary']>,
): boolean {
  if (entry.boundary === boundary) return true;
  return boundary === 'step' && entry.boundary === 'turn-start';
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
