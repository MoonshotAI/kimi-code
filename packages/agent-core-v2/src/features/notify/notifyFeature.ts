import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { AgentNotifyUserNudgeService, IAgentNotifyUserNudgeService } from './notifyUserNudgeService';
import { ISessionNotify } from './sessionNotify';
import { INotifyUserTool, NOTIFY_USER_TOOL_NAME } from './tools/notify-user/notify-user';
import { NotifyUserTool } from './tools/notify-user/notifyUserTool';

export class NotifyFeature extends Feature {
  static override readonly name = 'notify';

  constructor() {
    super();
    this.contributeTool(INotifyUserTool, NotifyUserTool, {
      name: NOTIFY_USER_TOOL_NAME,
      domain: 'notify',
      when: (accessor) => accessor.get(ISessionNotify).enabled,
    });
    this.contributeAgentService(IAgentNotifyUserNudgeService, AgentNotifyUserNudgeService);
  }
}

registerFeature(NotifyFeature);
