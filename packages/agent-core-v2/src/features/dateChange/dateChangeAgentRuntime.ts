import { assign, fromCallback, setup } from 'xstate';

import { IAgentProfileService } from '#/agent/profile/profile';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/agent/runtime/agentRuntime';
import { AgentReminder } from '#/features/reminder/reminderAgentRuntime';
import type {
  ContextInjectionContext,
  ContextInjectionResult,
} from '#/features/reminder/types';
import { IHostClock } from '#/os/interface/hostClock';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

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
  readonly runtime: AgentRuntimeContext<null>;
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
    readonly runtime: AgentRuntimeContext<null>;
  };
}) => {
  const runtime = input.runtime;
  const reminder = runtime
    .get(IAgentLifecycleService)
    .resolve(runtime.agent, AgentReminder);
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
  const dateFromProfile = (): DateDisclosure | undefined => {
    if (!belongsToCurrentCwd()) return undefined;
    const profileData = profile.data();
    const date = profileData.environmentDisclosure?.date;
    if (!date?.disclosed) return undefined;
    return {
      ...date.value,
      renderGeneration: profileData.renderGeneration ?? 0,
    };
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
      const profileDate = dateFromProfile();
      const seed = runtime.getLogicState<DateChangeActorContext>().seed;
      const baseline = pickDisclosureBaseline<DateDisclosure>(
        lastDisclosure,
        profileDate,
        seed,
      );
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
      if (lastDisclosure !== undefined || profileDate !== undefined) return undefined;
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
    input: AgentRuntimeContext<null>;
    events: DateChangeDiscloseEvent | AgentRuntimeRestoreEvent;
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

export class DateChangeRuntime {}

export const AgentDateChange = defineAgentRuntimeContract<DateChangeRuntime>('dateChange');

export const dateChangeAgentRuntimeProvider = defineAgentRuntimeProvider<null, DateChangeRuntime>(
  AgentDateChange,
  {
    id: 'dateChange',
    logic: dateChangeActorLogic,
    eager: true,
    createApi: () => new DateChangeRuntime(),
  },
);
