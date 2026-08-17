import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionCronService } from '#/session/cron/sessionCronService';

import { ICronDeleteTool, CronDeleteInputSchema, type CronDeleteInput } from './cron-delete';
import CRON_DELETE_DESCRIPTION from './cron-delete.md?raw';

const ID_PATTERN = /^(?:[0-9a-f]{8}|[0-9A-HJKMNP-TV-Z]{26})$/i;

export class CronDeleteTool implements ICronDeleteTool {
  declare readonly _serviceBrand: undefined;

  readonly name = 'CronDelete' as const;
  readonly description = CRON_DELETE_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(
    CronDeleteInputSchema,
  );

  constructor(
    @ISessionCronService private readonly cron: ISessionCronService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {}

  resolveExecution(args: CronDeleteInput): ToolExecution {
    if (!ID_PATTERN.test(args.id)) {
      return {
        isError: true,
        output: `Invalid cron job id ${JSON.stringify(
          args.id,
        )} — must be a ULID.`,
      };
    }

    return {
      description: `Deleting cron ${args.id}`,
      approvalRule: this.name,
      execute: async () => {
        const removed = this.cron.removeTasks([args.id]);
        if (removed.length === 0) {
          return {
            isError: true,
            output: `No cron job with id ${args.id}.`,
          };
        }

        this.cron.emitDeleted(args.id, this.scopeContext.agentId);

        return {
          output: `Deleted cron job ${args.id}.`,
          isError: false,
        };
      },
    };
  }
}

registerScopedService(
  LifecycleScope.Agent,
  ICronDeleteTool,
  CronDeleteTool,
  ScopeActivation.OnScopeCreated,
  'cron',
);
