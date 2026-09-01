import { assign, fromCallback, setup } from 'xstate';

import { createDecorator, IInstantiationService } from '#/_base/di/instantiation';
import {
  AgentActorService,
  type AgentActorContext,
  type AgentActorRestoreEvent,
} from '#/agent/actorService/agentActorService';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import type {
  ContextInjectionContext,
  ContextInjectionResult,
} from '#/features/reminder/types';
import { IHostClock } from '#/os/interface/hostClock';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IEventDispatcher } from '#/state/eventDispatcher';

import type { DateInjectionDisclosure } from './dateChange';
import { pickDisclosureBaseline } from './disclosureBaseline';

const DATE_CHANGE_INJECTION_VARIANT = 'date_change';

interface DateDisclosure {
  readonly localDate: string;
  readonly timeZone: string;
  readonly renderGeneration: number;
}

interface DateChangeActorContext {
  readonly seed: DateDisclosure | undefined;
  readonly runtime: AgentActorContext<null>;
}

interface DateChangeDiscloseEvent {
  readonly type: 'dateChange.disclose';
  readonly seed: DateDisclosure;
}

function currentDateDisclosure(clock: IHostClock): Omit<DateDisclosure, 'renderGeneration'> {
  const date = clock.now();
  const timeZone = clock.timeZone();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return {
    localDate: `${part('year')}-${part('month')}-${part('day')}`,
    timeZone,
  };
}

const dateChangeInjection = fromCallback(({
  input,
}: {
  input: {
    readonly runtime: AgentActorContext<null>;
  };
}) => {
  const runtime = input.runtime;
  const reminder = runtime.get(IAgentReminderService);
  const profile = runtime.get(IAgentProfileService);
  const clock = runtime.get(IHostClock);
  const sessionContext = runtime.get(ISessionContext);
  const belongsToCurrentCwd = (): boolean => {
    const environment = profile.data().environmentDisclosure;
    return !(
      environment !== undefined &&
      environment.cwd !== '' &&
      environment.cwd !== sessionContext.cwd
    );
  };
  const registration = reminder.register<DateInjectionDisclosure>(
    DATE_CHANGE_INJECTION_VARIANT,
    ({
      lastDisclosure,
    }: ContextInjectionContext<DateInjectionDisclosure>): ContextInjectionResult<DateInjectionDisclosure> | undefined => {
      const profileData = profile.data();
      if (!belongsToCurrentCwd()) return undefined;
      const renderGeneration = profileData.renderGeneration ?? 0;
      const current = currentDateDisclosure(clock);
      const seed = runtime.getLogicState<DateChangeActorContext>().seed;
      const baseline = pickDisclosureBaseline<DateDisclosure>(lastDisclosure, seed);
      if (baseline !== undefined && baseline.localDate !== current.localDate) {
        return {
          content: `The date has changed. Today's date is now ${current.localDate}. Rely on this reminder over any earlier date statement for the current date. DO NOT mention this to the user explicitly.`,
          disclosure: {
            kind: 'date',
            renderGeneration,
            localDate: current.localDate,
            timeZone: current.timeZone,
          },
        };
      }
      if (lastDisclosure !== undefined) return undefined;
      if (seed === undefined) {
        runtime.send({
          type: 'dateChange.disclose',
          seed: { ...current, renderGeneration },
        });
      }
      return {
        content: `Today's date is ${current.localDate}. The current date is restated in a reminder whenever it changes; rely on the latest such reminder for the current date. DO NOT mention this to the user explicitly.`,
        disclosure: {
          kind: 'date',
          renderGeneration,
          localDate: current.localDate,
          timeZone: current.timeZone,
        },
      };
    },
  );
  return () => { registration.dispose(); };
});

const dateChangeActorLogic = setup({
  types: {} as {
    context: DateChangeActorContext;
    input: AgentActorContext<null>;
    events: DateChangeDiscloseEvent | AgentActorRestoreEvent;
  },
  actors: { dateChangeInjection },
}).createMachine({
  context: ({ input }) => ({ seed: undefined, runtime: input }),
  initial: 'beforeRestore',
  states: {
    beforeRestore: {
      on: { 'runtime.restore': 'active' },
    },
    active: {
      invoke: {
        src: 'dateChangeInjection',
        input: ({ context }) => ({ runtime: context.runtime }),
      },
    },
  },
  on: {
    'dateChange.disclose': {
      actions: assign({ seed: ({ event }) => event.seed }),
    },
  },
});

export interface IAgentDateChangeService {
  readonly _serviceBrand: undefined;
}

export const IAgentDateChangeService = createDecorator<IAgentDateChangeService>('agentDateChangeService');

export class AgentDateChangeService extends AgentActorService<null> implements IAgentDateChangeService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEventDispatcher dispatcher: IEventDispatcher,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    super(dispatcher, scopeContext, instantiation);
    this.attachActor(dateChangeActorLogic, { id: 'dateChange' });
  }
}
