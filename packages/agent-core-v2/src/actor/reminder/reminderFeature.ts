import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { reminderAgentRuntimeProvider } from './reminderAgentRuntime';

export class ReminderFeature extends Feature {
  static override readonly name = 'reminder';

  constructor() {
    super();
    this.contributeAgentRuntime(reminderAgentRuntimeProvider);
  }
}

registerFeature(ReminderFeature);
