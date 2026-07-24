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

import { t } from '@moonshot-ai/kimi-i18n';

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

  /**
   * Per-goal rejection counter. When the judge rejects completion N times
   * consecutively for the same goal, the tool overrides the judge and allows
   * completion — the judge is advisory, not a hard gate.
   */
  private readonly rejectionCounts = new Map<string, number>();
  /**
   * Tracks whether the most recent judge evaluation for a goal was a rejection.
   * Prevents the agent from immediately calling `blocked` to bypass the judge.
   */
  private readonly pendingJudgeFix = new Set<string>();
  private static readonly MAX_JUDGE_REJECTIONS = 3;

  constructor(
    @IAgentGoalService private readonly goal: IAgentGoalService,
    @IAgentGoalJudgeService private readonly judge: IAgentGoalJudgeService,
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
          // Ask the judge to independently verify goal completion.
          const verdict = await this.judge.evaluate(goalAtExecution);
          if (!verdict.ok) {
            if (verdict.impossible) {
              // Judge says the goal is impossible — transition to blocked.
              this.rejectionCounts.delete(goalAtExecution.goalId);
              const blocked = await this.goal.markBlocked({ reason: verdict.reason }, 'model');
              if (blocked === null) {
                return { output: t('toolsV2.goal.notBlocked') };
              }
              return { output: buildGoalBlockedReasonPrompt(blocked), stopTurn: true };
            }
            // Judge rejects completion — track consecutive rejections.
            const prevCount = this.rejectionCounts.get(goalAtExecution.goalId) ?? 0;
            const newCount = prevCount + 1;
            this.rejectionCounts.set(goalAtExecution.goalId, newCount);

            if (newCount >= UpdateGoalTool.MAX_JUDGE_REJECTIONS) {
              // Judge has rejected 3+ times for this goal — override and allow.
              // The judge is advisory; repeated rejection likely indicates a
              // hallucination or stale context rather than a real gap.
              this.rejectionCounts.delete(goalAtExecution.goalId);
              this.pendingJudgeFix.delete(goalAtExecution.goalId);
              const completed = await this.goal.markComplete({}, 'model');
              if (completed === null) {
                return { output: t('toolsV2.goal.notCompleted') };
              }
              return {
                output: buildGoalCompletionSummaryPrompt(completed) +
                  '\n\n(Note: completion was allowed after the judge rejected it ' +
                  `${newCount} consecutive times. The judge override was applied.)`,
                stopTurn: true,
              };
            }

            // Under the threshold — let the agent continue working.
            this.pendingJudgeFix.add(goalAtExecution.goalId);
            return {
              output: `Goal completion rejected by judge (attempt ${newCount}/${UpdateGoalTool.MAX_JUDGE_REJECTIONS}): ${verdict.reason}\n\n` +
                'You MUST fix the issue described above, then call UpdateGoal("complete") again. ' +
                'Do NOT call UpdateGoal("blocked") — a judge rejection is not a blocking condition; ' +
                'it means there is remaining work you must finish.',
            };
          }
          // Judge approved — reset counter and proceed with completion.
          this.rejectionCounts.delete(goalAtExecution.goalId);
          this.pendingJudgeFix.delete(goalAtExecution.goalId);
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
          // Prevent the agent from using 'blocked' to bypass a judge rejection.
          // If the judge just rejected completion, the agent must fix the issue
          // rather than claim it's blocked.
          if (this.pendingJudgeFix.has(goalAtExecution.goalId)) {
            return {
              output: 'Cannot mark as blocked: the judge identified remaining work that must be completed. ' +
                'Fix the issues the judge reported, then call UpdateGoal("complete") again. ' +
                'Use "blocked" only for genuine external blockers (missing user input, unavailable resources), ' +
                'not for unfinished work.',
            };
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

function changedGoalOutput(status: UpdateGoalToolInput['status']): string {
  if (status === 'complete') return t('toolsV2.goal.goalChanged');
  return t('toolsV2.goal.goalChanged');
}

registerTool(UpdateGoalTool, {
  when: (accessor) => accessor.get(IAgentScopeContext).agentId === 'main',
});
