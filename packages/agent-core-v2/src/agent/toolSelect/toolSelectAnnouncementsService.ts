import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentMcpService } from '#/agent/mcp/mcp';

import { LOADABLE_TOOLS_VARIANT } from './dynamicTools';
import { IAgentToolSelectService } from './toolSelect';
import { IAgentToolSelectAnnouncementsService } from './toolSelectAnnouncements';

export class AgentToolSelectAnnouncementsService extends Service implements IAgentToolSelectAnnouncementsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentToolSelectService toolSelect: IAgentToolSelectService,
    @IAgentReminderService reminder: IAgentReminderService,
    @IAgentMcpService mcp: IAgentMcpService,
  ) {
    super();
    this._register(
      reminder.register(LOADABLE_TOOLS_VARIANT, async ({ isNewTurn, signal }) => {
        if (!isNewTurn || !toolSelect.enabled()) return undefined;
        await mcp.waitForInitialLoad(signal);
        return toolSelect.loadableToolsAnnouncement();
      }),
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
