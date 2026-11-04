import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type ToolExecution } from '#/tool/toolContract';

import {
  ISessionMessageService,
  ISessionReadTool,
  SessionReadInputSchema,
  type SessionReadInput,
} from '../session2session';
import DESCRIPTION from './sessionRead.md?raw';

export class SessionReadTool implements ISessionReadTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'session_read' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SessionReadInputSchema);

  constructor(@ISessionMessageService private readonly messages: ISessionMessageService) {}

  resolveExecution(args: SessionReadInput): ToolExecution {
    return {
      description: `Reading the latest assistant output from session ${args.to}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: async () => {
        const result = await this.messages.read(args);
        return { output: JSON.stringify(result, null, 2), isError: result.status === 'error' };
      },
    };
  }
}
