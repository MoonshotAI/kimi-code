import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { wrapSystemReminder } from '#/features/reminder/systemReminder';

import { isToolSelectAnnouncementDisclosure, LOADABLE_TOOLS_VARIANT } from './dynamicTools';
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
      reminder.register(LOADABLE_TOOLS_VARIANT, async ({ lastDisclosure, signal }) => {
        await toolSelect.prepareForRequest(signal);
        const announcement = toolSelect.loadableToolsAnnouncement(
          isToolSelectAnnouncementDisclosure(lastDisclosure) ? lastDisclosure : undefined,
        );
        if (announcement?.disclosure.kind !== 'delta') return announcement;
        const tools = announcement.disclosure.added.filter((tool) => tool.origin === 'runtime');
        if (tools.length === 0) return announcement;
        return {
          disclosure: announcement.disclosure,
          content: {
            message: {
              role: 'system' as const,
              content: [{ type: 'text' as const, text: wrapSystemReminder(announcement.content) }],
              tools: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              })),
            },
          },
        };
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
