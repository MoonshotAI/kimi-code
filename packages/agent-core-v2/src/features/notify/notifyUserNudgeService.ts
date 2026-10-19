import { fromCallback, setup } from 'xstate';

import { createDecorator, IInstantiationService } from '#/_base/di/instantiation';
import {
  AgentActorService,
  type AgentActorContext,
  type AgentActorRestoreEvent,
} from '#/agent/actorService/agentActorService';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import type { NotifyUserNudgeShownEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { notifyUserAvailable } from './notifyUserAvailability';
import {
  NOTIFY_USER_NUDGE_VARIANT,
  notifyStreak,
  renderNotifyUserNudge,
  shouldNudgeNotifyUser,
  toolCallRoundsSincePosition,
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
  const available = (): boolean =>
    notifyUserAvailable(runtime.get(IFlagService), runtime.get(IBootstrapService));
  if (!available()) return () => {};
  const registration = runtime.get(IAgentReminderService).register(
    NOTIFY_USER_NUDGE_VARIANT,
    ({ lastInjectedAt }): string | undefined => {
      if (!available()) return undefined;
      if (runtime.get(IAgentToolRegistryService).resolve(NOTIFY_USER_TOOL_NAME) === undefined) {
        return undefined;
      }
      const history = runtime.get(IAgentContextMemoryService).get();
      const streak = notifyStreak(history);
      const roundsSinceLastNudge =
        lastInjectedAt === null ? null : toolCallRoundsSincePosition(history, lastInjectedAt);
      if (!shouldNudgeNotifyUser(streak.rounds, roundsSinceLastNudge)) return undefined;
      const properties: NotifyUserNudgeShownEvent = {
        turn_id: runtime.get(IAgentLoopService).snapshot().activeTurnId,
        rounds_since_notify: streak.rounds,
        nudge_index: streak.nudges + 1,
      };
      runtime.get(ITelemetryService).track2('notify_user_nudge_shown', properties);
      return renderNotifyUserNudge(streak.rounds);
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
