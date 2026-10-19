import { toDisposable } from '#/_base/di/lifecycle';
import type { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { isCompactionSummaryMessage } from '#/agent/contextMemory/compactionHandoff';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import type { IAgentLoopService } from '#/agent/loop/loop';
import type { IEventBus } from '#/app/event/eventBus';
import type { IAgentReminderService } from '#/features/reminder/reminderService';
import { wrapSystemReminder } from '#/features/reminder/systemReminder';
import type {
  ContextInjectionContent,
  ContextInjectionMessage,
  ContextInjectionProvider,
  ContextInjectionResult,
  ReminderNotification,
} from '#/features/reminder/types';

export function createReminderStub(input: {
  register?<D>(variant: string, provider: ContextInjectionProvider<D>): { dispose(): void };
  notify?(content: string, notification: ReminderNotification): void;
  reconcileWhenIdle?(variant: string): Promise<void>;
} = {}): IAgentReminderService {
  return {
    _serviceBrand: undefined,
    register: input.register ?? (() => toDisposable(() => {})),
    notify: input.notify ?? (() => {}),
    reconcileWhenIdle: input.reconcileWhenIdle ?? (async () => {}),
  } as IAgentReminderService;
}

export function createReminderHarness(
  loop: IAgentLoopService,
  context: IAgentContextMemoryService,
  eventBus?: IEventBus,
): IAgentReminderService {
  const entries = new Map<string, ContextInjectionProvider>();
  let rearm = false;
  eventBus?.subscribe(ContextSpliced, (event) => {
    if (event.deleteCount > 0 && event.messages.some(isCompactionSummaryMessage)) rearm = true;
  });
  loop.hooks.onWillBeginStep.register('test-reminder', async ({ firstStepOfTurn }, next) => {
    const isNewTurn = firstStepOfTurn || rearm;
    rearm = false;
    for (const [variant, provider] of entries) {
      const history = context.get();
      const positions = history.flatMap((message, index) =>
        message.origin?.kind === 'injection' && message.origin.variant === variant ? [index] : [],
      );
      const lastInjectedAt = positions.at(-1) ?? null;
      const lastInjection = lastInjectedAt === null ? undefined : history[lastInjectedAt];
      const value = await provider({
        injectedPositions: positions,
        lastInjectedAt,
        lastInjection,
        lastDisclosure: lastInjection?.origin?.kind === 'injection'
          ? lastInjection.origin.disclosure
          : undefined,
        isNewTurn,
      });
      if (value === undefined) continue;
      const result: ContextInjectionResult =
        typeof value === 'object' && !Array.isArray(value) && 'content' in value
          ? value
          : { content: value as ContextInjectionContent };
      const origin = { kind: 'injection' as const, variant, disclosure: result.disclosure };
      const content = result.content;
      if (typeof content === 'string') {
        if (content.trim().length === 0) continue;
        context.append({
          role: 'user',
          content: [{ type: 'text', text: wrapSystemReminder(content) }],
          toolCalls: [],
          origin,
        });
        continue;
      }
      if (Array.isArray(content)) {
        if (content.length === 0) continue;
        context.append({ role: 'user', content: [...content], toolCalls: [], origin });
        continue;
      }
      const message = (content as { readonly message: ContextInjectionMessage }).message;
      if (message.content.length === 0 && (message.tools === undefined || message.tools.length === 0)) {
        continue;
      }
      context.append({
        role: message.role,
        content: [...message.content],
        toolCalls: [],
        tools: message.tools,
        origin,
      });
    }
    await next();
  });
  return createReminderStub({
    register: (variant, provider) => {
      entries.set(variant, provider as ContextInjectionProvider);
      return toDisposable(() => { entries.delete(variant); });
    },
  });
}
