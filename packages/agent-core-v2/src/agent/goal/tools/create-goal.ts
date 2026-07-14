/**
 * CreateGoalTool — lets the main agent start an explicit goal on the user's
 * behalf. The goal becomes durable, structured state owned by the agent's
 * goal service, not text parsed from a slash command. Registered for the main
 * agent only, mirroring v1's `agent.type === 'main'` gate.
 */

import { z } from 'zod';

import type { ToolInputDisplay } from '@moonshot-ai/protocol';

import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { BuiltinTool, ToolExecution } from '#/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';

import { IAgentGoalService } from '#/agent/goal/goal';
import DESCRIPTION from './create-goal.md?raw';
import { goalForModel } from './serialize';

export const CreateGoalToolInputSchema = z
  .object({
    objective: z.string().min(1).describe('The objective to pursue. Must have a verifiable end state.'),
    completionCriterion: z
      .string()
      .optional()
      .describe('How to verify the goal is complete. Include when the user provides one.'),
    replace: z
      .boolean()
      .optional()
      .describe('Replace an existing active, paused, or blocked goal instead of failing.'),
  })
  .strict();

export type CreateGoalToolInput = z.infer<typeof CreateGoalToolInputSchema>;

export class CreateGoalTool implements BuiltinTool<CreateGoalToolInput> {
  readonly name = 'CreateGoal' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(CreateGoalToolInputSchema);

  constructor(
    @IAgentGoalService private readonly goal: IAgentGoalService,
    @IAgentPermissionModeService private readonly permissionMode: IAgentPermissionModeService,
  ) {}

  resolveExecution(args: CreateGoalToolInput): ToolExecution {
    const goalAtResolution = this.goal.getGoal().goal;
    return {
      description: 'Creating a goal',
      display: this.resolveGoalStartDisplay(args),
      approvalRule: this.name,
      execute: async ({ turnId }) => {
        const currentGoal = this.goal.getGoal().goal;
        if (
          currentGoal?.goalId !== goalAtResolution?.goalId &&
          (currentGoal === null || !this.goal.isGoalToolTarget(turnId, currentGoal.goalId))
        ) {
          return { output: 'Goal not created: the current goal changed.' };
        }
        const snapshot = await this.goal.createGoal(
          {
            objective: args.objective,
            completionCriterion: args.completionCriterion,
            replace: args.replace,
          },
          'model',
        );
        return { output: JSON.stringify({ goal: goalForModel(snapshot) }, null, 2) };
      },
    };
  }

  private resolveGoalStartDisplay(args: CreateGoalToolInput): ToolInputDisplay | undefined {
    const mode = this.permissionMode.mode;
    if (mode === 'auto') return undefined;
    return {
      kind: 'goal_start',
      objective: args.objective,
      completionCriterion: args.completionCriterion,
      mode,
    };
  }
}

registerTool(CreateGoalTool, {
  when: (accessor) => accessor.get(IAgentScopeContext).agentId === 'main',
});
