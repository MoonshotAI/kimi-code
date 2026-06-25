import {
  Disposable,
  registerSingleton,
  SyncDescriptor,
  toDisposable,
} from "#/_base/di";

import { IContextMemory } from '../contextMemory/contextMemory';
import { ITurnRunner } from '../turnRunner/turnRunner';
import type { ContextMessage } from '../types';
import {
  IDynamicInjector,
  type DynamicInjectionOptions,
  type DynamicInjectionProvider,
} from './dynamicInjector';

interface DynamicInjectionEntry {
  readonly cadence: DynamicInjectionOptions['cadence'];
  readonly provider: DynamicInjectionProvider;
  readonly variant: string;
  injectedAt: number | null;
  resolveHistory: boolean;
  turnConsumed: boolean;
}

export class DynamicInjectorService extends Disposable implements IDynamicInjector {
  private readonly entries = new Set<DynamicInjectionEntry>();
  private readonly selfInsertedMessages = new WeakMap<ContextMessage, DynamicInjectionEntry>();

  constructor(
    @IContextMemory private readonly context: IContextMemory,
    @ITurnRunner turnRunner: ITurnRunner,
  ) {
    super();
    this._register(
      turnRunner.hooks.beforeStep.register('dynamic-injector', async (_ctx, next) => {
        await next();
        await this.inject();
      }),
    );
    this._register(
      turnRunner.hooks.onLaunched.register('dynamic-injector', (_ctx, next) => {
        for (const entry of this.entries) {
          if (entry.cadence !== 'turn') continue;
          entry.injectedAt = null;
          entry.resolveHistory = false;
          entry.turnConsumed = false;
        }
        return next();
      }),
    );
    context.hooks.onSpliced.register('dynamic-injector', (ctx, next) => {
      this.handleSplice(ctx);
      return next();
    });
  }

  register(
    variant: string,
    provider: DynamicInjectionProvider,
    options: DynamicInjectionOptions = {},
  ) {
    const entry: DynamicInjectionEntry = {
      cadence: options.cadence ?? 'step',
      provider,
      variant,
      injectedAt: null,
      resolveHistory: true,
      turnConsumed: false,
    };
    this.entries.add(entry);
    return toDisposable(() => {
      this.entries.delete(entry);
    });
  }

  private async inject(): Promise<void> {
    for (const entry of this.entries) {
      const history = this.context.getHistory();
      if (entry.resolveHistory) {
        entry.injectedAt ??= findLastInjection(history, entry.variant);
      }
      if (entry.cadence === 'turn') {
        if (entry.turnConsumed || entry.injectedAt !== null) continue;
        entry.turnConsumed = true;
      }
      const content = await entry.provider({
        injectedAt: entry.injectedAt,
      });
      if (!this.entries.has(entry)) continue;
      if (content === undefined || content.trim().length === 0) continue;
      const injectedAt = this.context.getHistory().length;
      const message = createInjectionMessage(content, entry.variant);
      this.selfInsertedMessages.set(message, entry);
      this.context.spliceHistory(injectedAt, 0, [message]);
      entry.injectedAt = injectedAt;
      entry.resolveHistory = false;
      this.selfInsertedMessages.delete(message);
    }
  }

  private handleSplice(splice: ContextSplice): void {
    const selfInserted = new Map<DynamicInjectionEntry, number>();
    splice.messages.forEach((message, offset) => {
      const entry = this.selfInsertedMessages.get(message);
      if (entry !== undefined) {
        selfInserted.set(entry, splice.start + offset);
      }
    });
    const previousLength =
      this.context.getHistory().length - splice.messages.length + splice.deleteCount;

    for (const entry of this.entries) {
      const ownInsertedAt = selfInserted.get(entry);
      if (ownInsertedAt !== undefined) {
        entry.injectedAt = ownInsertedAt;
        entry.resolveHistory = false;
        continue;
      }
      entry.injectedAt = updateInjectedAt(entry.injectedAt, splice, previousLength);
    }
  }
}

type ContextSplice = {
  readonly start: number;
  readonly deleteCount: number;
  readonly messages: readonly ContextMessage[];
};

function updateInjectedAt(
  injectedAt: number | null,
  splice: ContextSplice,
  previousLength: number,
): number | null {
  if (injectedAt === null) return null;
  if (isClearSplice(splice, previousLength)) return null;
  if (isCompactionSplice(splice)) {
    const next = injectedAt - splice.deleteCount + 1;
    return next >= 0 ? next : null;
  }
  if (isSingleMessageRemoval(splice)) {
    if (injectedAt > splice.start) return injectedAt - 1;
    if (injectedAt === splice.start) return null;
    return injectedAt;
  }
  const deletedEnd = splice.start + splice.deleteCount;
  if (injectedAt < splice.start) return injectedAt;
  if (injectedAt < deletedEnd) return null;
  return injectedAt + splice.messages.length - splice.deleteCount;
}

function isClearSplice(splice: ContextSplice, previousLength: number): boolean {
  return splice.start === 0 && splice.deleteCount >= previousLength && splice.messages.length === 0;
}

function isCompactionSplice(splice: ContextSplice): boolean {
  return (
    splice.start === 0 &&
    splice.deleteCount > 0 &&
    splice.messages.length === 1 &&
    splice.messages[0]?.origin?.kind === 'compaction_summary'
  );
}

function isSingleMessageRemoval(splice: ContextSplice): boolean {
  return splice.deleteCount === 1 && splice.messages.length === 0;
}

function findLastInjection(
  history: readonly ContextMessage[],
  variant: string,
): number | null {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message?.origin?.kind === 'injection' && message.origin.variant === variant) {
      return index;
    }
  }
  return null;
}

function createInjectionMessage(content: string, variant: string): ContextMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `<system-reminder>\n${content.trim()}\n</system-reminder>`,
      },
    ],
    toolCalls: [],
    origin: { kind: 'injection', variant },
  };
}

registerSingleton(IDynamicInjector, new SyncDescriptor(DynamicInjectorService, [], true));
