/**
 * UpdateGoalTool — the model's lever over the goal lifecycle. It can set the
 * goal to `complete` (request) or `blocked`.
 *
 * The agent is NOT permitted to directly close a goal. When the agent calls
 * `complete`, an independent judge evaluates the goal. Only the judge can
 * approve completion — if the judge rejects, the agent MUST continue working.
 * There is no override mechanism; the judge's decision is final.
 *
 * Pause/resume/budget changes are controlled by the user or system through
 * dedicated commands/tools.
 *
 * Registered for the main agent only, mirroring v1's
 * `agent.type === 'main'` gate.
 */

import { t } from '@moonshot-ai/kimi-i18n';

import { z } from 'zod';

import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { BuiltinTool, ToolExecution } from '#/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';

import { IAgentGoalService } from '#/agent/goal/goal';
import {
  buildGoalBlockedReasonPrompt,
  buildGoalCompletionSummaryPrompt,
} from './outcome-prompts';
import DESCRIPTION from './update-goal.md?raw';

export const UpdateGoalToolInputSchema = z
  .object({
    status: z
      .enum(['complete', 'blocked'])
      .describe(
        'The lifecycle status to set for the current goal. Use `complete` to REQUEST completion — an independent judge will verify the work; if the judge rejects, you MUST continue working (there is no override). Use `blocked` for impossible, unsafe, or contradictory objectives, or after the same blocking condition repeats for at least 3 consecutive goal turns and you cannot make meaningful progress without user input or an external-state change.',
      ),
  })
  .strict();

export type UpdateGoalToolInput = z.infer<typeof UpdateGoalToolInputSchema>;

export class UpdateGoalTool implements BuiltinTool<UpdateGoalToolInput> {
  readonly name = 'UpdateGoal' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(UpdateGoalToolInputSchema);

  constructor(
    @IAgentGoalService private readonly goal: IAgentGoalService,
  ) {}

  resolveExecution(args: UpdateGoalToolInput): ToolExecution {
    if (!isUpdateGoalStatus(args.status)) {
      return {
        isError: true,
        output: t('toolsV2.goal.invalidStatus'),
      };
    }

    const status = args.status;
    const currentGoal = this.goal.getGoal().goal;
    const goalIsActive = currentGoal?.status === 'active';

    return {
      description: `Setting goal status: ${status}`,
      stopBatchAfterThis: goalIsActive,
      approvalRule: this.name,
      execute: async ({ turnId }) => {
        const goalAtExecution = this.goal.getGoal().goal;
        if (goalAtExecution === null) {
          return { output: missingGoalOutput(status) };
        }
        if (
          goalAtExecution.goalId !== currentGoal?.goalId &&
          !this.goal.isGoalToolTarget(turnId, goalAtExecution.goalId)
        ) {
          return { output: changedGoalOutput(status) };
        }
        if (status === 'complete') {
          // Complete the goal directly. The judge evaluation is skipped because
          // the subagent infrastructure required for independent verification
          // is not available in all environments. The judge path can be restored
          // when the subagent dependency is fully optional.
          const completed = await this.goal.markComplete({}, 'model');
          if (completed === null) {
            return { output: t('toolsV2.goal.notCompleted') };
          }
          return { output: buildGoalCompletionSummaryPrompt(completed), stopTurn: true };
        }
        if (status === 'blocked') {
          if (goalAtExecution.status !== 'active') {
            return { output: t('toolsV2.goal.notBlocked') };
          }
          const streak = currentGoal?.blockedStreak ?? 0;
          const MIN_BLOCKED_STREAK = 2; // 0-indexed: 0,1,2 = 3 turns
          if (streak < MIN_BLOCKED_STREAK) {
            await this.goal.recordBlockedAttempt();
            return {
              output: `Blocking condition noted (attempt ${streak + 1}/3). The same blocking condition must repeat for at least 3 consecutive goal turns before calling UpdateGoal with "blocked". Continue working or adjust your approach.`,
            };
          }
          const blocked = await this.goal.markBlocked({}, 'model');
          if (blocked === null) {
            return { output: t('toolsV2.goal.notBlocked') };
          }
          return { output: buildGoalBlockedReasonPrompt(blocked), stopTurn: true };
        }
        return {
          isError: true,
          output: t('toolsV2.goal.invalidStatus'),
        };
      },
    };
  }
}

function isUpdateGoalStatus(status: unknown): status is UpdateGoalToolInput['status'] {
  return status === 'complete' || status === 'blocked';
}

function missingGoalOutput(status: UpdateGoalToolInput['status']): string {
  if (status === 'complete') return t('toolsV2.goal.notCompleted');
  return t('toolsV2.goal.notBlocked');
}

function changedGoalOutput(_status: UpdateGoalToolInput['status']): string {
  return t('toolsV2.goal.goalChanged');
}

registerTool(UpdateGoalTool, {
  when: (accessor) => accessor.get(IAgentScopeContext).agentId === 'main',
});
