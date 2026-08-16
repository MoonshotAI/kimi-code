/**
 * `tools` domain — `TowerTeardownTool` implementation (the `TowerTeardown`
 * tool).
 *
 * Tears the workspace down through the protocol `TowerStore` rooted at the
 * session cwd (`sessionContext`) and exits tower mode via `tower`; the comms
 * directory stays on disk as the audit trail. Registered for the main agent
 * only. Bound at Agent scope.
 */

import { IAgentTowerService } from '#/features/tower/tower';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ToolExecution } from '#/tool/toolContract';

import { newTowerStore, runTowerTool } from '../support';
import DESCRIPTION from './teardown.md?raw';
import {
  ITowerTeardownTool,
  TowerTeardownToolInputSchema,
  type TowerTeardownToolInput,
} from './teardown';

export class TowerTeardownTool implements ITowerTeardownTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TowerTeardown' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerTeardownToolInputSchema);

  constructor(
    @ISessionContext private readonly sessionContext: ISessionContext,
    @IAgentTowerService private readonly tower: IAgentTowerService,
  ) {}

  resolveExecution(args: TowerTeardownToolInput): ToolExecution {
    return {
      description: `Tearing down tower workspace${args.force === true ? ' (force)' : ''}`,
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newTowerStore(this.sessionContext);
          const report = await store.teardown({ force: args.force });
          this.tower.exit();
          return {
            output: [
              'tower teardown:',
              ...report.map((line) => `- ${line}`),
              '',
              'Tower mode exited. .tower/comms/ (state, inbox, findings, reviews, activity log) is kept as the audit trail — remove it by hand only if you are sure.',
            ].join('\n'),
          };
        }),
    };
  }
}

