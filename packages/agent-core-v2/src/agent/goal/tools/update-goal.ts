/**
 * UpdateGoalTool — the model's single lever over the goal lifecycle. It updates
 * the goal's status directly; the turn driver reads the status at each turn
 * boundary and stops (`complete` / `blocked`) or keeps going.
 *
 * The model can only set `complete` or `blocked`. Pause/resume/budget changes
 * are controlled by the user or system through dedicated commands/tools.
 *
 * The argument is intentionally just a status enum — no reason or evidence. The
 * model explains itself in its own reply; the status is the machine-readable
 * signal. Registered for the main agent only, mirroring v1's
 * `agent.type === 'main'` gate.
 */

import { z } from 'zod';

import { toInputJsonSchema } from '#/tool/input-schema';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { BuiltinTool, ToolExecution } from '#/tool/toolContract';
import { registerTool } from '#/agent/toolRegistry/toolContribution';

import { IAgentGoalService } from '#/agent/goal/goal';
import { IAgentGoalJudgeService } from '#/agent/goal/judge/goalJudgeService';
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
        'The lifecycle status to set for the current goal. Use `complete` only when the objective has actually been achieved and no required work remains, verified against the actual current state. Use `blocked` for impossible, unsafe, or contradictory objectives, or after the same blocking condition repeats for at least 3 consecutive goal turns and you cannot make meaningful progress without user input or an external-state change.',
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
    @IAgentGoalJudgeService private readonly judge: IAgentGoalJudgeService,
  ) {}

  resolveExecution(args: UpdateGoalToolInput): ToolExecution {
    if (!isUpdateGoalStatus(args.status)) {
      return {
        isError: true,
        output: 'Invalid goal status. Use `complete` or `blocked`.',
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
          // Ask the judge to independently verify goal completion.
          const verdict = await this.judge.evaluate(goalAtExecution);
          if (!verdict.ok) {
            if (verdict.impossible) {
              // Judge says the goal is impossible — transition to blocked.
              const blocked = await this.goal.markBlocked({ reason: verdict.reason }, 'model');
              if (blocked === null) {
                return { output: 'Goal not blocked: no active goal.' };
              }
              return { output: buildGoalBlockedReasonPrompt(blocked), stopTurn: true };
            }
            // Judge rejects completion — let the agent continue working.
            return {
              output: `Goal completion rejected by judge: ${verdict.reason}\nContinue working toward the goal objective.`,
            };
          }
          // Judge approved — proceed with completion.
          const completed = await this.goal.markComplete({}, 'model');
          if (completed === null) {
            return { output: 'Goal not completed: no active goal.' };
          }
          return { output: buildGoalCompletionSummaryPrompt(completed), stopTurn: true };
        }
        if (status === 'blocked') {
          if (goalAtExecution.status !== 'active') {
            return { output: 'Goal not blocked: no active goal.' };
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
            return { output: 'Goal not blocked: no active goal.' };
          }
          return { output: buildGoalBlockedReasonPrompt(blocked), stopTurn: true };
        }
        return {
          isError: true,
          output: 'Invalid goal status. Use `complete` or `blocked`.',
        };
      },
    };
  }
}

function isUpdateGoalStatus(status: unknown): status is UpdateGoalToolInput['status'] {
  return status === 'complete' || status === 'blocked';
}

function missingGoalOutput(status: UpdateGoalToolInput['status']): string {
  if (status === 'complete') return 'Goal not completed: no active goal.';
  return 'Goal not blocked: no active goal.';
}

function changedGoalOutput(status: UpdateGoalToolInput['status']): string {
  if (status === 'complete') return 'Goal not completed: the current goal changed.';
  return 'Goal not blocked: the current goal changed.';
}

registerTool(UpdateGoalTool, {
  when: (accessor) => accessor.get(IAgentScopeContext).agentId === 'main',
});
