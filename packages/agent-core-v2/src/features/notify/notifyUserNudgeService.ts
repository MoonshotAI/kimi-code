import { fromCallback, setup } from 'xstate';

import { createDecorator, IInstantiationService } from '#/_base/di/instantiation';
import {
  AgentActorService,
  type AgentActorContext,
  type AgentActorRestoreEvent,
} from '#/agent/actorService/agentActorService';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IFlagService } from '#/app/flag/flag';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { NOTIFY_USER_FLAG_ID } from './flag';
import {
  NOTIFY_USER_NUDGE_VARIANT,
  lastMidResponsePosition,
  renderMidResponseHint,
  renderNotifyUserNudge,
  shouldNudgeMidResponse,
  shouldNudgeNotifyUser,
  toolCallsSinceLastNotify,
  toolCallsSincePosition,
} from './notifyUserNudge';
import { NOTIFY_USER_TOOL_NAME } from './tools/notify-user/notify-user';

interface NotifyUserNudgeActorContext {
  readonly runtime: AgentActorContext<null>;
}

const notifyUserNudgeReminders = fromCallback(({
  input,
}: {
  input: {
    readonly runtime: AgentActorContext<null>;
  };
}) => {
  const runtime = input.runtime;
  if (!runtime.get(IFlagService).enabled(NOTIFY_USER_FLAG_ID)) return () => {};
  const registration = runtime.get(IAgentReminderService).register(
    NOTIFY_USER_NUDGE_VARIANT,
    ({ lastInjectedAt }): string | undefined => {
      if (!runtime.get(IFlagService).enabled(NOTIFY_USER_FLAG_ID)) return undefined;
      if (runtime.get(IAgentToolRegistryService).resolve(NOTIFY_USER_TOOL_NAME) === undefined) {
        return undefined;
      }
      const history = runtime.get(IAgentContextMemoryService).get();
      const streak = toolCallsSinceLastNotify(history);
      const callsSinceLastNudge =
        lastInjectedAt === null ? null : toolCallsSincePosition(history, lastInjectedAt);
      if (shouldNudgeNotifyUser(streak, callsSinceLastNudge)) return renderNotifyUserNudge(streak);
      if (shouldNudgeMidResponse(lastMidResponsePosition(history), lastInjectedAt)) {
        return renderMidResponseHint();
      }
      return undefined;
    },
  );
  return () => {
    registration.dispose();
  };
});

const notifyUserNudgeActorLogic = setup({
  types: {} as {
    context: NotifyUserNudgeActorContext;
    input: AgentActorContext<null>;
    events: AgentActorRestoreEvent;
  },
  actors: { notifyUserNudgeReminders },
}).createMachine({
  context: ({ input }) => ({ runtime: input }),
  initial: 'beforeRestore',
  states: {
    beforeRestore: {
      on: { 'runtime.restore': 'active' },
    },
    active: {
      invoke: {
        src: 'notifyUserNudgeReminders',
        input: ({ context }) => ({ runtime: context.runtime }),
      },
    },
  },
});

export interface IAgentNotifyUserNudgeService {
  readonly _serviceBrand: undefined;
}

export const IAgentNotifyUserNudgeService = createDecorator<IAgentNotifyUserNudgeService>(
  'agentNotifyUserNudgeService',
);

export class AgentNotifyUserNudgeService
  extends AgentActorService<null>
  implements IAgentNotifyUserNudgeService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEventDispatcher dispatcher: IEventDispatcher,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    super(dispatcher, scopeContext, instantiation);
    this.attachActor(notifyUserNudgeActorLogic, { id: 'notifyUserNudge' });
  }
}
