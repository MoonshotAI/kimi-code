/**
 * `contextInjector` domain — `IAgentContextInjectorService` implementation.
 *
 * Reconciles registered model-context providers against `contextMemory` at the
 * head of every loop step (before the step's request is built), so every LLM
 * request sees the freshest injections. A compaction splice re-arms the
 * new-turn flag for the next step. `reconcileWhenIdle` lets out-of-loop
 * callers (SDK RPC surfaces) refresh one provider immediately while the loop
 * is quiet. Writes reminders through `systemReminder` and reports provider
 * failures through `log`. Bound at Agent scope.
 */

import { toDisposable, type IDisposable } from "#/_base/di/lifecycle";
import { Service } from "#/_base/di/service";
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { isCompactionSummaryMessage } from '#/agent/contextMemory/compactionHandoff';
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
} from './contextInjector';

interface ContextInjectionEntry {
  readonly provider: ContextInjectionProvider<unknown>;
  readonly name: string;
}

export class AgentContextInjectorService extends Service implements IAgentContextInjectorService {
  declare readonly _serviceBrand: undefined;
  private readonly entries = new Set<ContextInjectionEntry>();
  private compactionRearmPending = false;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentLoopService private readonly loopService: IAgentLoopService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IEventBus private readonly eventBus: IEventBus,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this._register(
      loopService.hooks.onWillBeginStep.register('context-injector', (ctx, next) =>
        this.reconcileAroundStep(ctx, next),
      ),
    );
    this._register(
      this.eventBus.subscribe('context.spliced', (splice) => {
        if (isCompactionSplice(splice)) this.compactionRearmPending = true;
      }),
    );
  }

  register<D = unknown>(
    name: string,
    provider: ContextInjectionProvider<D>,
  ): IDisposable {
    const entry: ContextInjectionEntry = {
      provider: provider as ContextInjectionProvider<unknown>,
      name,
    };
    this.entries.add(entry);
    return toDisposable(() => {
      this.entries.delete(entry);
    });
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

  private async reconcileAroundStep(
    ctx: BeforeStepContext,
    next: (context?: BeforeStepContext) => Promise<void>,
  ): Promise<void> {
    const rearmed = this.takeCompactionRearm();
    await this.inject(ctx.firstStepOfTurn || rearmed);
    await next();
    // Compaction can run inside a later handler of this same chain
    // (full-compaction's beforeStep). Its splice always drops injection
    // messages, so re-reconcile here — still before the step's request.
    if (this.takeCompactionRearm()) {
      await this.inject(true);
    }
  }

  /** Reads and clears the flag set when a compaction splice arrives. */
  private takeCompactionRearm(): boolean {
    const pending = this.compactionRearmPending;
    this.compactionRearmPending = false;
    return pending;
  }

  private async inject(isNewTurn: boolean): Promise<void> {
    for (const entry of this.entries) {
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

  private providerContext(
    entry: ContextInjectionEntry,
    isNewTurn: boolean,
  ): ContextInjectionContext<unknown> {
    const history = this.context.get();
    const injectedPositions = findInjections(history, entry.name);
    const lastInjectedAt = injectedPositions.at(-1) ?? null;
    const lastInjection = lastInjectedAt === null ? undefined : history[lastInjectedAt];
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

function isCompactionSplice(splice: {
  readonly deleteCount: number;
  readonly messages: readonly ContextMessage[];
}): boolean {
  return splice.deleteCount > 0 && splice.messages.some(isCompactionSummaryMessage);
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

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextInjectorService,
  AgentContextInjectorService,
  ScopeActivation.OnScopeCreated,
  'contextInjector',
);
