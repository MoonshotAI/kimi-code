import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type ToolExecution } from '#/tool/toolContract';

import {
  ISessionListTool,
  ISessionMessageService,
  SessionListInputSchema,
  type SessionListInput,
} from '../session2session';
import DESCRIPTION from './sessionList.md?raw';

export class SessionListTool implements ISessionListTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'session_list' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SessionListInputSchema);

  constructor(@ISessionMessageService private readonly messages: ISessionMessageService) {}

  resolveExecution(args: SessionListInput): ToolExecution {
    return {
      description: 'Listing sessions',
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: async () => ({
        output: JSON.stringify(await this.messages.list(args.filter), null, 2),
      }),
    };
  }
}
