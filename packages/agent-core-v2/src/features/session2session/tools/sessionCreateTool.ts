import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type ToolExecution } from '#/tool/toolContract';

import {
  ISessionCreateTool,
  ISessionMessageService,
  SessionCreateInputSchema,
  type SessionCreateInput,
} from '../session2session';
import DESCRIPTION from './sessionCreate.md?raw';

export class SessionCreateTool implements ISessionCreateTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'session_create' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SessionCreateInputSchema);

  constructor(@ISessionMessageService private readonly messages: ISessionMessageService) {}

  resolveExecution(args: SessionCreateInput): ToolExecution {
    return {
      description: inputDescription(args),
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: async () => {
        const result = await this.messages.create(args);
        return { output: JSON.stringify(result, null, 2), isError: result.status === 'error' };
      },
    };
  }
}

function inputDescription(args: SessionCreateInput): string {
  return args.forkFrom === undefined ? 'Creating a session' : `Forking session ${args.forkFrom}`;
}
