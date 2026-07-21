/**
 * CreateGoalTool — lets the main agent start an explicit goal on the user's
 * behalf. The goal becomes durable, structured state owned by the agent's
 * goal service, not text parsed from a slash command. Registered for the main
 * agent only, mirroring v1's `agent.type === 'main'` gate.
 */

import { z } from 'zod';

import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

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
      .describe(
        'How to verify the goal is complete — a concrete, checkable condition (e.g. a test passing, a search returning zero matches, a command exiting 0). Required. When the user\\u2019s request is vague, you MUST first ask them — via AskUserQuestion — what \"done\" concretely means and how it will be verified; do not invent a criterion on your own. If the user clearly insists on a vague goal after you warn them, record their own wording as the criterion and proceed.',
      ),
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
        // Reject missing or placeholder completion criteria at the tool boundary
        // so the model is forced to provide a concrete, verifiable check.
        const criterion = args.completionCriterion?.trim();
        if (!criterion || criterion.length < 10) {
          return {
            output:
              'Completion criterion is required and must be at least 10 characters. ' +
              'Provide a concrete, verifiable check — e.g. what test to run, what command should succeed, ' +
              'what condition must hold. If the user\'s request is vague, ask them via AskUserQuestion first.',
          };
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
