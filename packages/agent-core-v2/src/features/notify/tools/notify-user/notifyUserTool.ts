import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type ToolExecution } from '#/tool/toolContract';
import { notifyUserAvailable } from '../../notifyUserAvailability';

import {
  INotifyUserTool,
  NOTIFY_USER_TOOL_NAME,
  NotifyUserInputSchema,
  type NotifyUserInput,
} from './notify-user';
import DESCRIPTION from './notify-user.md?raw';

export const NOTIFY_USER_DELIVERED_OUTPUT = 'Update shown to the user.';
export const NOTIFY_USER_EMPTY_MESSAGE = 'message must not be empty.';
export const NOTIFY_USER_SUPPRESSED_OUTPUT = 'Notifications are disabled; the update was not displayed.';

export class NotifyUserTool implements INotifyUserTool {
  declare readonly _serviceBrand: undefined;
  readonly name = NOTIFY_USER_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(NotifyUserInputSchema);

  constructor(
    @IFlagService private readonly flags: IFlagService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {}

  resolveExecution(args: NotifyUserInput): ToolExecution {
    if (args.message.trim().length === 0) {
      return { isError: true, output: NOTIFY_USER_EMPTY_MESSAGE };
    }
    return {
      description: 'Notifying the user',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: async () =>
        notifyUserAvailable(this.flags, this.bootstrap)
          ? { isError: false, output: NOTIFY_USER_DELIVERED_OUTPUT }
          : { isError: false, output: NOTIFY_USER_SUPPRESSED_OUTPUT },
    };
  }
}
