import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolAccesses, type ToolExecution } from '#/tool/toolContract';

import {
  ISessionMessageService,
  ISessionSendTool,
  SessionSendInputSchema,
  type SessionSendInput,
} from '../session2session';
import DESCRIPTION from './sessionSend.md?raw';

export class SessionSendTool implements ISessionSendTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'session_send' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SessionSendInputSchema);

  constructor(@ISessionMessageService private readonly messages: ISessionMessageService) {}

  resolveExecution(args: SessionSendInput): ToolExecution {
    return {
      description: `Sending a message to session ${args.to}`,
      accesses: ToolAccesses.none(),
      approvalRule: this.name,
      execute: async () => {
        const result = await this.messages.send(args);
        return { output: JSON.stringify(result, null, 2), isError: result.status === 'error' };
      },
    };
  }
}
