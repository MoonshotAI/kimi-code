/**
 * `profile` domain (L4) — `IAgentSkillListingReminderService` implementation.
 *
 * Subscribes the session skill catalog's `onDidChange` and registers one
 * context-injection provider into the agent's `contextInjector`; the provider
 * stays silent until an injection pass runs at a new turn (`isNewTurn`), then
 * clears the pending flag and returns the change note plus the current
 * `sessionSkillCatalog` model listing, which the injector appends as a system
 * reminder. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';

import {
  IAgentSkillListingReminderService,
  SKILL_CATALOG_CHANGED_INJECTION_VARIANT,
} from './agentSkillListingReminder';

export class AgentSkillListingReminderService
  extends Disposable
  implements IAgentSkillListingReminderService
{
  declare readonly _serviceBrand: undefined;

  private pending = false;

  constructor(
    @IAgentContextInjectorService injector: IAgentContextInjectorService,
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
  ) {
    super();
    this._register(
      this.skillCatalog.onDidChange(() => {
        this.pending = true;
      }),
    );
    this._register(
      injector.register(SKILL_CATALOG_CHANGED_INJECTION_VARIANT, ({ isNewTurn }) => {
        if (!isNewTurn || !this.pending) return undefined;
        this.pending = false;
        return this.renderReminder();
      }),
    );
  }

  private renderReminder(): string {
    const listing = this.skillCatalog.catalog.getModelSkillListing();
    if (listing === '') {
      return (
        'The skill catalog changed during this session; there are currently no invocable skills. ' +
        'This supersedes any earlier skill listing reminder in this session.'
      );
    }
    return (
      'The skill catalog changed during this session; the listing below supersedes any earlier ' +
      'skill listing reminder in this session.' +
      `\n\n${listing}`
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSkillListingReminderService,
  AgentSkillListingReminderService,
  InstantiationType.Eager,
  'profile',
);
