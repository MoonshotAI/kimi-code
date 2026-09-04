import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { notifyUserAvailable } from './notifyUserAvailability';
import { INotifyUserTool, NOTIFY_USER_TOOL_NAME } from './tools/notify-user/notify-user';
import { NotifyUserTool } from './tools/notify-user/notifyUserTool';

export class NotifyFeature extends Feature {
  static override readonly name = 'notify';

  constructor() {
    super();
    this.contributeTool(INotifyUserTool, NotifyUserTool, {
      name: NOTIFY_USER_TOOL_NAME,
      domain: 'notify',
      when: (accessor) =>
        notifyUserAvailable(accessor.get(IFlagService), accessor.get(IBootstrapService)),
    });
  }
}

registerFeature(NotifyFeature);
