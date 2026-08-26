import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { activateReminderWhenReady } from '#/features/reminder/internal/reminderActivation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { LOADABLE_TOOLS_VARIANT } from './dynamicTools';
import { IAgentToolSelectService } from './toolSelect';
import { IAgentToolSelectAnnouncementsService } from './toolSelectAnnouncements';

export class AgentToolSelectAnnouncementsService extends Service implements IAgentToolSelectAnnouncementsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentToolSelectService toolSelect: IAgentToolSelectService,
    @IAgentLifecycleService agentLifecycle: IAgentLifecycleService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
  ) {
    super();
    this._register(
      activateReminderWhenReady(agentLifecycle, scopeContext, (reminder) =>
        reminder.register(LOADABLE_TOOLS_VARIANT, ({ isNewTurn }) =>
          isNewTurn ? toolSelect.loadableToolsAnnouncement() : undefined,
        ),
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
