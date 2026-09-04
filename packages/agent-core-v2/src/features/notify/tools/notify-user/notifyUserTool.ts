import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { mainAgentOnlyExecution, NOTIFY_USER_MAIN_AGENT_ONLY } from '#/agent/tools/mainAgentOnly';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type ToolExecution } from '#/tool/toolContract';

import {
  INotifyUserTool,
  NOTIFY_USER_TOOL_NAME,
  NotifyUserInputSchema,
  type NotifyUserInput,
} from './notify-user';
import DESCRIPTION from './notify-user.md?raw';

export const NOTIFY_USER_DELIVERED_OUTPUT = 'Update shown to the user.';
export const NOTIFY_USER_EMPTY_MESSAGE = 'message must not be empty.';

export class NotifyUserTool implements INotifyUserTool {
  declare readonly _serviceBrand: undefined;
  readonly name = NOTIFY_USER_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(NotifyUserInputSchema);

  constructor(@IAgentScopeContext private readonly scopeContext: IAgentScopeContext) {}

  resolveExecution(args: NotifyUserInput): ToolExecution {
    const denied = mainAgentOnlyExecution(this.scopeContext, NOTIFY_USER_MAIN_AGENT_ONLY);
    if (denied !== undefined) return denied;
    if (args.message.trim().length === 0) {
      return { isError: true, output: NOTIFY_USER_EMPTY_MESSAGE };
    }
    return {
      description: 'Notifying the user',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: async () => ({ isError: false, output: NOTIFY_USER_DELIVERED_OUTPUT }),
    };
  }
}
