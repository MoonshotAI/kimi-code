/**
 * `contextInjector` domain — `IAgentContextInjectorService` implementation.
 *
 * Reconciles registered model-context providers against `contextMemory`,
 * observes turn and step boundaries through `eventBus` and `loop`, writes
 * reminders through `systemReminder`, and reports provider failures through
 * `log`. Bound at Agent scope.
 */

import { toDisposable, type IDisposable } from "#/_base/di/lifecycle";
import { Service } from "#/_base/di/service";
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService, type BeforeStepContext } from '#/agent/loop/loop';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IEventBus } from '#/app/event/eventBus';
import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  IAgentContextInjectorService,
  type ContextInjectionContent,
  type ContextInjectionContext,
  type ContextInjectionMessage,
  type ContextInjectionProvider,
  type ContextInjectionResult,
  type SyncContextInjectionProvider,
} from './contextInjector';

interface ContextInjectionEntry {
  readonly provider: ContextInjectionProvider<unknown>;
  readonly name: string;
  readonly boundary: 'step' | 'turn-start';
}

export class AgentContextInjectorService extends Service implements IAgentContextInjectorService {
  declare readonly _serviceBrand: undefined;
  private readonly entries = new Set<ContextInjectionEntry>();
  private enclosingStep: BeforeStepContext | undefined;
  private newTurnDeliveredTo: BeforeStepContext | undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentLoopService private readonly loopService: IAgentLoopService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IEventBus private readonly eventBus: IEventBus,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this._register(
      loopService.hooks.onWillBeginStep.register('context-injector', async (ctx, next) => {
        this.enclosingStep = ctx;
        try {
          await next();
        } finally {
          this.enclosingStep = undefined;
        }
        await this.inject('step', ctx.firstStepOfTurn && this.newTurnDeliveredTo !== ctx);
      }),
    );
    this._register(
      this.eventBus.subscribe('turn.started', () => {
        this.injectAtTurnStart();
      }),
    );
  }

  register<D = unknown>(
    name: string,
    provider: ContextInjectionProvider<D>,
  ): IDisposable {
    return this.registerProvider(name, provider, 'step');
  }

  registerAtTurnStart<D = unknown>(
    name: string,
    provider: SyncContextInjectionProvider<D>,
  ): IDisposable {
    return this.registerProvider(name, provider, 'turn-start');
  }

  private registerProvider<D>(
    name: string,
    provider: ContextInjectionProvider<D>,
    boundary: ContextInjectionEntry['boundary'],
  ): IDisposable {
    const entry: ContextInjectionEntry = {
      provider: provider as ContextInjectionProvider<unknown>,
      name,
      boundary,
    };
    this.entries.add(entry);
    return toDisposable(() => {
      this.entries.delete(entry);
    });
  }

  async injectAfterCompaction(): Promise<void> {
    this.newTurnDeliveredTo = this.enclosingStep;
    await this.inject(undefined, true);
  }

  async reconcileWhenIdle(name: string): Promise<void> {
    const quiescence = this.loopService.tryAcquireQuiescence();
    if (quiescence === undefined) return;
    try {
      for (const entry of this.entries) {
        if (entry.name !== name) continue;
        await this.injectEntry(entry, false);
      }
    } finally {
      quiescence.dispose();
    }
  }

  private async inject(
    boundary: ContextInjectionEntry['boundary'] | undefined,
    isNewTurn: boolean,
  ): Promise<void> {
    for (const entry of this.entries) {
      if (boundary !== undefined && !shouldRunAtBoundary(entry, boundary)) continue;
      await this.injectEntry(entry, isNewTurn);
    }
  }

  private async injectEntry(entry: ContextInjectionEntry, isNewTurn: boolean): Promise<void> {
    let content: Awaited<ReturnType<ContextInjectionProvider>>;
    try {
      content = await entry.provider(this.providerContext(entry, isNewTurn));
    } catch (error) {
      this.log.error('context provider failed; skipping it', { name: entry.name, error });
      return;
    }
    if (!this.entries.has(entry)) return;
    this.appendResult(entry, content);
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
  ): ContextInjectionContext<unknown> {
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
    content: ContextInjectionContent | ContextInjectionResult<unknown> | undefined,
  ): void {
    if (content === undefined) return;
    const result: ContextInjectionResult<unknown> = isInjectionResult(content)
      ? content
      : { content };
    const origin = {
      kind: 'injection' as const,
      variant: entry.name,
      disclosure: result.disclosure,
    };
    const resolved = result.content;
    if (typeof resolved === 'string') {
      if (resolved.trim().length === 0) return;
      this.reminders.appendSystemReminder(resolved, origin);
      return;
    }
    if (isRawInjectionMessage(resolved)) {
      const message = resolved.message;
      if (
        message.content.length === 0 &&
        (message.tools === undefined || message.tools.length === 0)
      ) {
        return;
      }
      this.context.append({
        role: message.role,
        content: [...message.content],
        toolCalls: [],
        tools: message.tools,
        origin,
      });
      return;
    }
    if (resolved.length === 0) return;
    this.context.append({
      role: 'user',
      content: [...resolved],
      toolCalls: [],
      origin,
    });
  }
}

function isRawInjectionMessage(
  content: Exclude<ContextInjectionContent, string>,
): content is { readonly message: ContextInjectionMessage } {
  return !Array.isArray(content);
}

function isInjectionResult(
  content: ContextInjectionContent | ContextInjectionResult<unknown>,
): content is ContextInjectionResult<unknown> {
  return (
    typeof content === 'object' &&
    content !== null &&
    !Array.isArray(content) &&
    'content' in content
  );
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
