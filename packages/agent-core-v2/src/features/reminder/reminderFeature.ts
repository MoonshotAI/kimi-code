import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { AgentReminderService, IAgentReminderService } from '#/features/reminder/reminderService';

export class ReminderFeature extends Feature {
  static override readonly name = 'reminder';

  constructor() {
    super();
    this.contributeAgentService(IAgentReminderService, AgentReminderService);
  }
}

registerFeature(ReminderFeature);
