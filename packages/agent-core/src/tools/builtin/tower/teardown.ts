/**
 * TowerTeardownTool — end the tower session: remove mission worktrees
 * (dirty ones are kept unless force), exit tower mode, and report what
 * happened. The comms directory stays on disk as the audit trail.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { newStore, runTowerTool } from './support';

export const TowerTeardownToolInputSchema = z
  .object({
    force: z
      .boolean()
      .optional()
      .describe('Remove worktrees even when they contain uncommitted changes'),
  })
  .strict();

export type TowerTeardownToolInput = z.infer<typeof TowerTeardownToolInputSchema>;

export class TowerTeardownTool implements BuiltinTool<TowerTeardownToolInput> {
  readonly name = 'TowerTeardown' as const;
  readonly description: string = `Tear down the tower workspace after all missions are merged (or abandoned).

Removes the mission worktrees — worktrees with uncommitted changes are kept and listed unless force is set. Exits tower mode. The .tower/comms/ directory (state, inbox, findings, reviews, activity log) is always kept as the audit trail.`;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerTeardownToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: TowerTeardownToolInput): ToolExecution {
    return {
      description: `Tearing down tower workspace${args.force === true ? ' (force)' : ''}`,
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newStore(this.agent);
          const report = await store.teardown({ force: args.force });
          this.agent.towerMode.exit();
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
