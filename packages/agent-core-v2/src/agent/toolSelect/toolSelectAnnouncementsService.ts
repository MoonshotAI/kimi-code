import { onScopeDispose } from '@vue/reactivity';

import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentReminderService } from '#/features/reminder/reminderService';

import { isToolSelectAnnouncementDisclosure, LOADABLE_TOOLS_VARIANT } from './dynamicTools';
import { IAgentToolSelectService } from './toolSelect';
import { IAgentToolSelectAnnouncementsService } from './toolSelectAnnouncements';

export class AgentToolSelectAnnouncementsService extends Service implements IAgentToolSelectAnnouncementsService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentToolSelectService private readonly toolSelect: IAgentToolSelectService,
    @IAgentReminderService private readonly reminder: IAgentReminderService,
  ) {
    super();
  }

  override setup(): void {
    const registration = this.reminder.register(LOADABLE_TOOLS_VARIANT, async ({ lastDisclosure, signal }) => {
      if (!this.toolSelect.featureEnabled()) return undefined;
      await this.toolSelect.prepareForRequest(signal);
      return this.toolSelect.loadableToolsAnnouncement(
        isToolSelectAnnouncementDisclosure(lastDisclosure) ? lastDisclosure : undefined,
      );
    });
    onScopeDispose(() => {
      registration.dispose();
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolSelectAnnouncementsService,
  AgentToolSelectAnnouncementsService,
  ScopeActivation.OnScopeCreated,
  'toolSelect',
);
