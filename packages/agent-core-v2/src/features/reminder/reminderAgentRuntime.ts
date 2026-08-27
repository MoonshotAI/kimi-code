import { fromCallback, setup } from 'xstate';

import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { isCompactionSummaryMessage } from '#/agent/contextMemory/compactionHandoff';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService, type BeforeStepContext } from '#/agent/loop/loop';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/agent/runtime/agentRuntime';
import { IEventBus } from '#/app/event/eventBus';

import { wrapSystemReminder } from './systemReminder';
import type {
  ContextInjectionContent,
  ContextInjectionContext,
  ContextInjectionMessage,
  ContextInjectionProvider,
  ContextInjectionResult,
  ReminderNotification,
  ReminderRegistration,
} from './types';

interface ReminderEntry {
  readonly provider: ContextInjectionProvider<unknown>;
  readonly variant: string;
}

const REMINDER_VARIANT_PRIORITY = new Map<string, number>([['date_change', -1]]);

interface ReminderActorContext {
  readonly entries: Set<ReminderEntry>;
  readonly runtime: AgentRuntimeContext<null>;
}

interface ReminderRegisterEvent {
  readonly type: 'reminder.register';
  readonly entry: ReminderEntry;
}

interface ReminderUnregisterEvent {
  readonly type: 'reminder.unregister';
  readonly entry: ReminderEntry;
}

type ReminderActorEvent = AgentRuntimeRestoreEvent | ReminderRegisterEvent | ReminderUnregisterEvent;

function actorContext(runtime: AgentRuntimeContext<null>): ReminderActorContext {
  return runtime.getLogicState<ReminderActorContext>();
}

function appendReminder(
  runtime: AgentRuntimeContext<null>,
  content: string,
  notification: ReminderNotification,
): void {
  runtime.get(IAgentContextMemoryService).append({
    role: 'user',
    content: [{ type: 'text', text: wrapSystemReminder(content) }],
    toolCalls: [],
    origin: {
      kind: 'injection',
      variant: notification.variant,
      ownerPromptId: notification.ownerPromptId,
    },
  });
}

function providerContext(
  runtime: AgentRuntimeContext<null>,
  entry: ReminderEntry,
  isNewTurn: boolean,
): ContextInjectionContext<unknown> {
  const history = runtime.get(IAgentContextMemoryService).get();
  const injectedPositions = findInjections(history, entry.variant);
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

async function injectEntry(
  runtime: AgentRuntimeContext<null>,
  entry: ReminderEntry,
  isNewTurn: boolean,
): Promise<void> {
  let content: Awaited<ReturnType<ContextInjectionProvider>>;
  try {
    content = await entry.provider(providerContext(runtime, entry, isNewTurn));
  } catch (error) {
    runtime.get(ILogService).error('context provider failed; skipping it', {
      name: entry.variant,
      error,
    });
    return;
  }
  if (!actorContext(runtime).entries.has(entry)) return;
  appendResult(runtime, entry, content);
}

function appendResult(
  runtime: AgentRuntimeContext<null>,
  entry: ReminderEntry,
  content: ContextInjectionContent | ContextInjectionResult<unknown> | undefined,
): void {
  if (content === undefined) return;
  const result: ContextInjectionResult<unknown> = isInjectionResult(content)
    ? content
    : { content };
  const origin = {
    kind: 'injection' as const,
    variant: entry.variant,
    disclosure: result.disclosure,
  };
  const resolved = result.content;
  if (typeof resolved === 'string') {
    if (resolved.trim().length === 0) return;
    runtime.get(IAgentContextMemoryService).append({
      role: 'user',
      content: [{ type: 'text', text: wrapSystemReminder(resolved) }],
      toolCalls: [],
      origin,
    });
    return;
  }
  if (isRawInjectionMessage(resolved)) {
    const message = resolved.message;
    if (message.content.length === 0 && (message.tools === undefined || message.tools.length === 0)) {
      return;
    }
    runtime.get(IAgentContextMemoryService).append({
      role: message.role,
      content: [...message.content],
      toolCalls: [],
      tools: message.tools,
      origin,
    });
    return;
  }
  if (resolved.length === 0) return;
  runtime.get(IAgentContextMemoryService).append({
    role: 'user',
    content: [...resolved],
    toolCalls: [],
    origin,
  });
}

async function inject(runtime: AgentRuntimeContext<null>, isNewTurn: boolean): Promise<void> {
  const entries = [...actorContext(runtime).entries].sort(
    (left, right) =>
      (REMINDER_VARIANT_PRIORITY.get(left.variant) ?? 0) -
      (REMINDER_VARIANT_PRIORITY.get(right.variant) ?? 0),
  );
  for (const entry of entries) await injectEntry(runtime, entry, isNewTurn);
}

const reminderEffects = fromCallback(({ input }: { input: { readonly runtime: AgentRuntimeContext<null> } }) => {
  let compactionRearmPending = false;
  const loop = input.runtime.get(IAgentLoopService);
  const takeCompactionRearm = (): boolean => {
    const pending = compactionRearmPending;
    compactionRearmPending = false;
    return pending;
  };
  const reconcileAroundStep = async (
    context: BeforeStepContext,
    next: (context?: BeforeStepContext) => Promise<void>,
  ): Promise<void> => {
    const rearmed = takeCompactionRearm();
    await inject(input.runtime, context.firstStepOfTurn || rearmed);
    await next();
    if (takeCompactionRearm()) await inject(input.runtime, true);
  };
  let hook: IDisposable;
  try {
    hook = loop.hooks.onWillBeginStep.register('context-injector', reconcileAroundStep, {
      before: 'full-compaction',
    });
  } catch {
    hook = loop.hooks.onWillBeginStep.register('context-injector', reconcileAroundStep);
  }
  const splice = input.runtime.get(IEventBus).subscribe(ContextSpliced, (event) => {
    if (isCompactionSplice(event)) compactionRearmPending = true;
  });
  return () => {
    splice.dispose();
    hook.dispose();
    actorContext(input.runtime).entries.clear();
  };
});

const reminderActorLogic = setup({
  types: {} as {
    context: ReminderActorContext;
    input: AgentRuntimeContext<null>;
    events: ReminderActorEvent;
  },
  actors: { reminderEffects },
}).createMachine({
  context: ({ input }) => ({ entries: new Set(), runtime: input }),
  initial: 'beforeRestore',
  states: {
    beforeRestore: {
      on: { 'runtime.restore': 'active' },
    },
    active: {
      invoke: {
        src: 'reminderEffects',
        input: ({ context }) => ({ runtime: context.runtime }),
      },
    },
  },
  on: {
    'reminder.register': {
      actions: ({ context, event }) => { context.entries.add(event.entry); },
    },
    'reminder.unregister': {
      actions: ({ context, event }) => { context.entries.delete(event.entry); },
    },
  },
});

export class ReminderRuntime {
  constructor(private readonly runtime: AgentRuntimeContext<null>) {}

  register<D = unknown>(variant: string, provider: ContextInjectionProvider<D>): ReminderRegistration {
    const entry: ReminderEntry = {
      provider: provider as ContextInjectionProvider<unknown>,
      variant,
    };
    this.runtime.send({ type: 'reminder.register', entry });
    return toDisposable(() => {
      try {
        this.runtime.send({ type: 'reminder.unregister', entry });
      } catch {}
    });
  }

  notify(content: string, notification: ReminderNotification): void {
    appendReminder(this.runtime, content, notification);
  }

  async reconcileWhenIdle(variant: string): Promise<void> {
    const loop = this.runtime.get(IAgentLoopService);
    const quiescence = loop.tryAcquireQuiescence();
    if (quiescence === undefined) return;
    try {
      for (const entry of actorContext(this.runtime).entries) {
        if (entry.variant === variant) await injectEntry(this.runtime, entry, false);
      }
    } finally {
      quiescence.dispose();
    }
  }
}

export const AgentReminder = defineAgentRuntimeContract<ReminderRuntime>('reminder');

export const reminderAgentRuntimeProvider = defineAgentRuntimeProvider<null, ReminderRuntime>(
  AgentReminder,
  {
    id: 'reminder',
    logic: reminderActorLogic,
    eager: true,
    createApi: (context) => new ReminderRuntime(context),
  },
);

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
  return typeof content === 'object' && content !== null && !Array.isArray(content) && 'content' in content;
}

function findInjections(history: readonly ContextMessage[], variant: string): number[] {
  const positions: number[] = [];
  history.forEach((message, index) => {
    if (message.origin?.kind === 'injection' && message.origin.variant === variant) positions.push(index);
  });
  return positions;
}
