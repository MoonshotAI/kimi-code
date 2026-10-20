import { z } from 'zod';

import type { ToolDefinition } from '@moonshot-ai/agent-core/tool/index';

import DESCRIPTION from './finding.md?raw';
import {
  callerName,
  errorText,
  newTowerStore,
  parseTowerArgs,
  runTowerTool,
  text,
  toInputJsonSchema,
  type TowerToolDeps,
} from './support';

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

export function createTowerFindingTool(deps: TowerToolDeps): ToolDefinition {
  return {
    name: 'TowerFinding',
    description: DESCRIPTION,
    parameters: toInputJsonSchema(TowerFindingToolInputSchema),
    execute({ toolCall }) {
      const parsed = parseTowerArgs(TowerFindingToolInputSchema, toolCall.arguments, 'TowerFinding');
      if ('parseError' in parsed) return Promise.resolve(errorText(parsed.parseError));
      const args = parsed.args;
      return runTowerTool(async () => {
        const store = newTowerStore(deps);
        const state = await store.load();
        const caller = callerName(deps.agentId, store, state);
        const rel = await store.fileFinding(caller, {
          type: args.type,
          title: args.title,
          severity: args.severity,
          summary: args.summary,
          location: args.location,
          details: args.details,
          suggestedFix: args.suggested_fix,
        });
        return text(
          `finding filed: ${rel}\nThe tower will route it — do not fix out-of-scope issues yourself.`,
        );
      });
    },
  };
}
