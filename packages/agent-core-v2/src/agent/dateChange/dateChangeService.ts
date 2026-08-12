/**
 * `dateChange` domain (L4) — `IAgentDateChangeService` implementation.
 *
 * Owns the `date_change` context-injection provider. The system prompt is only
 * re-rendered at profile (re)bind and after compaction, so a session that runs
 * past midnight keeps a stale date; this provider appends a system-reminder at
 * the next step boundary instead. The provider runs only while the profile's
 * rendered snapshot exists and matches the live cwd (an empty recorded cwd
 * means the render did not know it and never blocks), and reads current time
 * through the App-scoped `hostClock`. The baseline prefers the
 * typed disclosure on the newest surviving `date_change` injection, then the
 * persisted rendered snapshot, then a runtime seed kept in `agentState`: a
 * profile whose snapshot declares no date disclosure is seeded with the first
 * observed date (quietly), so a crossed midnight still announces afterwards.
 * Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import {
  IAgentContextInjectorService,
  type ContextInjectionContext,
  type ContextInjectionResult,
} from '#/agent/contextInjector/contextInjector';
import { pickDisclosureBaseline } from '#/agent/contextInjector/disclosureBaseline';
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
    this.states.register(dateChangeSeedKey);
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
    const baseline = pickDisclosureBaseline<DateDisclosure>(
      lastDisclosure,
      this.dateFromProfile(),
      this.states.get(dateChangeSeedKey),
    );
    if (baseline === undefined) {
      this.states.set(dateChangeSeedKey, { ...current, renderGeneration });
      return undefined;
    }
    if (baseline.localDate === current.localDate) return undefined;
    return {
      content: `The date has changed. Today's date is now ${current.localDate}. The date and time stated in your system prompt are stale; rely on this reminder for the current date. DO NOT mention this to the user explicitly.`,
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

registerScopedService(
  LifecycleScope.Agent,
  IAgentDateChangeService,
  AgentDateChangeService,
  ScopeActivation.OnScopeCreated,
  'dateChange',
);
