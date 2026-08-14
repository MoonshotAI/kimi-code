/**
 * `contextInjector` domain — `IAgentContextInjectorService` implementation.
 *
 * Injects registered context providers through `loop` and `systemReminder`.
 * Injection positions are NOT tracked state: they are a pure read-time scan
 * (`findInjections`) over the model-visible window served by `contextMemory`,
 * so splices, compaction derivation, undo, and wire restoration can never
 * desync them. Each provider call receives the
 * newest surviving injection of its own variant (`lastInjection`) and the
 * typed disclosure recorded on it (`lastDisclosure`), so providers never read
 * context layout or position indexes themselves. The plain-data `isNewTurn`
 * flag is registered into `agentState` (`IAgentStateService`) and read/written
 * through it; `entries` stays a plain instance field (its values hold provider
 * functions, not plain data). Bound at Agent scope.
 */

import { toDisposable } from "#/_base/di/lifecycle";
import { Service } from "#/_base/di/service";
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IEventBus } from '#/app/event/eventBus';
import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  IAgentContextInjectorService,
  type ContextInjectionContent,
  type ContextInjectionProvider,
  type ContextInjectionResult,
} from './contextInjector';

interface ContextInjectionEntry {
  readonly provider: ContextInjectionProvider;
  readonly name: string;
}

export const contextInjectorIsNewTurnKey = defineState<boolean>(
  'contextInjector.isNewTurn',
  () => true,
);

export class AgentContextInjectorService extends Service implements IAgentContextInjectorService {
  declare readonly _serviceBrand: undefined;
  private readonly entries = new Set<ContextInjectionEntry>();

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentLoopService loopService: IAgentLoopService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.register(contextInjectorIsNewTurnKey);
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
  ) {
    const entry: ContextInjectionEntry = { provider, name };
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
    const history = this.context.get();
    for (const entry of this.entries) {
      const injectedPositions: readonly number[] = findInjections(history, entry.name);
      const lastInjectedAt = injectedPositions.at(-1) ?? null;
      const lastInjection = lastInjectedAt === null ? undefined : history[lastInjectedAt];
      const content = await entry.provider({
        injectedPositions,
        lastInjectedAt,
        lastInjection,
        lastDisclosure:
          lastInjection?.origin?.kind === 'injection'
            ? lastInjection.origin.disclosure
            : undefined,
        isNewTurn,
      });
      if (!this.entries.has(entry)) continue;
      if (content === undefined) continue;
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
        if (result.content.trim().length === 0) continue;
        this.reminders.appendSystemReminder(result.content, origin);
        continue;
      }
      if (result.content.length === 0) continue;
      this.context.append({
        role: 'user',
        content: [...result.content],
        toolCalls: [],
        origin,
      });
    }
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

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextInjectorService,
  AgentContextInjectorService,
  ScopeActivation.OnScopeCreated,
  'contextInjector',
);
