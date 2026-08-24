import { Disposable } from '#/_base/di/lifecycle';
import { defineState } from '#/state/state';
import {
  IAgentContextInjectorService,
  type ContextInjectionContext,
  type ContextInjectionResult,
} from '#/agent/contextInjector/contextInjector';
import { pickDisclosureBaseline } from './disclosureBaseline';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { IHostClock } from '#/os/interface/hostClock';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { type DateInjectionDisclosure, IAgentDateChangeService } from './dateChange';

const DATE_CHANGE_INJECTION_VARIANT = 'date_change';

export const dateChangeSeedKey = defineState<DateDisclosure | undefined>(
  'dateChange.seed',
  () => undefined,
);

export class AgentDateChangeService extends Disposable implements IAgentDateChangeService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IHostClock private readonly clock: IHostClock,
    @ISessionContext private readonly sessionContext: ISessionContext,
  ) {
    super();
    this._register(this.states.contributeState(dateChangeSeedKey));
    this._register(
      injector.register<DateInjectionDisclosure>(
        DATE_CHANGE_INJECTION_VARIANT,
        (ctx) => this.reminder(ctx),
      ),
    );
  }

  private reminder({
    lastDisclosure,
  }: ContextInjectionContext<DateInjectionDisclosure>): ContextInjectionResult<DateInjectionDisclosure> | undefined {
    const profileData = this.profile.data();
    const environment = profileData.environmentDisclosure;
    if (
      environment !== undefined &&
      environment.cwd !== '' &&
      environment.cwd !== this.sessionContext.cwd
    ) {
      return undefined;
    }
    const renderGeneration = profileData.renderGeneration ?? 0;
    const current = currentDateDisclosure(this.clock);
    const profileDate = this.dateFromProfile();
    const baseline = pickDisclosureBaseline<DateDisclosure>(
      lastDisclosure,
      profileDate,
      this.states.get(dateChangeSeedKey),
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
    if (this.states.get(dateChangeSeedKey) === undefined) {
      this.states.set(dateChangeSeedKey, { ...current, renderGeneration });
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
  }

  private dateFromProfile(): DateDisclosure | undefined {
    const profileData = this.profile.data();
    const environment = profileData.environmentDisclosure;
    if (
      environment !== undefined &&
      environment.cwd !== '' &&
      environment.cwd !== this.sessionContext.cwd
    ) {
      return undefined;
    }
    const date = environment?.date;
    if (!date?.disclosed) return undefined;
    return {
      ...date.value,
      renderGeneration: profileData.renderGeneration ?? 0,
    };
  }
}

interface DateDisclosure {
  readonly localDate: string;
  readonly timeZone: string;
  readonly renderGeneration: number;
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
