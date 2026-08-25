import { toDisposable } from '#/_base/di/lifecycle';
import { AgentContextMemory, ContextMemoryRuntime } from '#/features/contextMemory/contextMemoryAgentRuntime';
import { isCompactionSummaryMessage } from '#/features/contextMemory/compactionHandoff';
import { ContextSpliced } from '#/features/contextMemory/contextEvents';
import type { IAgentLoopService } from '#/agent/loop/loop';
import type { IEventBus } from '#/app/event/eventBus';
import { AgentPermissionMode } from '#/features/permissionMode/permissionModeAgentRuntime';
import type { PermissionModeRuntime } from '#/features/permissionMode/permissionModeAgentRuntime';
import { AgentProfile, type ProfileRuntime } from '#/features/profile/profileAgentRuntime';
import { wrapSystemReminder } from '#/features/reminder/systemReminder';
import type { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { ReminderRuntime } from '#/features/reminder/reminderAgentRuntime';
import { AgentUsage, type UsageRuntime } from '#/features/usage/usageAgentRuntime';
import type {
  ContextInjectionContent,
  ContextInjectionMessage,
  ContextInjectionProvider,
  ContextInjectionResult,
  ReminderNotification,
} from '#/features/reminder/types';

import { stubContextMemory } from '../contextMemory/stubs';
import { stubPermissionModeRuntime } from '../permissionMode/stubs';
import { stubProfileRuntime } from '../profile/stubs';
import { stubUsage } from '../usage/stubs';

export function createReminderStub(input: {
  register?<D>(variant: string, provider: ContextInjectionProvider<D>): { dispose(): void };
  notify?(content: string, notification: ReminderNotification): void;
  reconcileWhenIdle?(variant: string): Promise<void>;
} = {}): ReminderRuntime {
  return {
    register: input.register ?? (() => toDisposable(() => {})),
    notify: input.notify ?? (() => {}),
    reconcileWhenIdle: input.reconcileWhenIdle ?? (async () => {}),
  } as ReminderRuntime;
}

export function lifecycleWithReminder(
  reminder: ReminderRuntime,
  contextMemory: ContextMemoryRuntime = stubContextMemory(),
  usage: UsageRuntime = stubUsage(),
  permissionMode: PermissionModeRuntime = stubPermissionModeRuntime(() => 'manual'),
  profile: ProfileRuntime = stubProfileRuntime(),
): IAgentLifecycleService {
  return {
    resolve: (_agent: unknown, definition: unknown) => {
      if (definition === AgentContextMemory) return contextMemory;
      if (definition === AgentUsage) return usage;
      if (definition === AgentPermissionMode) return permissionMode;
      if (definition === AgentProfile) return profile;
      return reminder;
    },
    handleOf: () => ({}),
    onDidCreateScope: () => toDisposable(() => {}),
  } as unknown as IAgentLifecycleService;
}

export function createReminderHarness(
  loop: IAgentLoopService,
  context: ContextMemoryRuntime,
  eventBus?: IEventBus,
): ReminderRuntime {
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
        void context.append({
          role: 'user',
          content: [{ type: 'text', text: wrapSystemReminder(content) }],
          toolCalls: [],
          origin,
        });
        continue;
      }
      if (Array.isArray(content)) {
        if (content.length === 0) continue;
        void context.append({ role: 'user', content: [...content], toolCalls: [], origin });
        continue;
      }
      const message = (content as { readonly message: ContextInjectionMessage }).message;
      if (message.content.length === 0 && (message.tools === undefined || message.tools.length === 0)) {
        continue;
      }
      void context.append({
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
