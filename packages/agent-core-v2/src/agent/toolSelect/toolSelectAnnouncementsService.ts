import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentReminderService } from '#/features/reminder/reminderService';

import { LOADABLE_TOOLS_VARIANT } from './dynamicTools';
import { IAgentToolSelectService } from './toolSelect';
import { IAgentToolSelectAnnouncementsService } from './toolSelectAnnouncements';

export class AgentToolSelectAnnouncementsService extends Service implements IAgentToolSelectAnnouncementsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentToolSelectService toolSelect: IAgentToolSelectService,
    @IAgentReminderService reminder: IAgentReminderService,
  ) {
    super();
    this._register(
      reminder.register(LOADABLE_TOOLS_VARIANT, ({ isNewTurn }) =>
        isNewTurn ? toolSelect.loadableToolsAnnouncement() : undefined,
      ),
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolSelectAnnouncementsService,
  AgentToolSelectAnnouncementsService,
  ScopeActivation.OnScopeCreated,
  'toolSelect',
);
