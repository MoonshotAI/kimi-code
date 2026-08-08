/**
 * TowerFindingTool — file a structured finding (bug / improve / vuln / idea)
 * for the tower to route. Workers use this for anything notable outside
 * their mission scope instead of fixing it directly.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { callerName, newStore, runTowerTool } from './support';

export const TowerFindingToolInputSchema = z
  .object({
    type: z.enum(['bug', 'improve', 'vuln', 'idea']).describe('Finding category'),
    title: z.string().describe('Short finding title'),
    severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    summary: z.string().describe('What was found, in a sentence or two'),
    location: z.string().optional().describe('File/symbol the finding concerns'),
    details: z.string().describe('Full details: evidence, reproduction, impact'),
    suggested_fix: z.string().describe('What you would do about it'),
  })
  .strict();

export type TowerFindingToolInput = z.infer<typeof TowerFindingToolInputSchema>;

export class TowerFindingTool implements BuiltinTool<TowerFindingToolInput> {
  readonly name = 'TowerFinding' as const;
  readonly description: string = `File a structured finding (bug / improve / vuln / idea) into .tower/comms/findings/ for the tower to route.

Use this for anything notable OUTSIDE your mission scope — fixing it directly would violate scope isolation. Include enough detail that another agent can act on it without re-discovering the context.`;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TowerFindingToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: TowerFindingToolInput): ToolExecution {
    return {
      description: `Filing tower ${args.type} finding: ${args.title}`,
      approvalRule: this.name,
      execute: () =>
        runTowerTool(async () => {
          const store = newStore(this.agent);
          const state = await store.load();
          const caller = callerName(this.agent, state);
          const rel = await store.fileFinding(caller, {
            type: args.type,
            title: args.title,
            severity: args.severity,
            summary: args.summary,
            location: args.location,
            details: args.details,
            suggestedFix: args.suggested_fix,
          });
          return {
            output: `finding filed: ${rel}\nThe tower will route it — do not fix out-of-scope issues yourself.`,
          };
        }),
    };
  }
}
