/**
 * UpdateGoalTool — the model's lever over the goal lifecycle. It can set the
 * goal to `complete` (request) or `blocked`.
 *
 * The agent is NOT permitted to directly close a goal. When the agent calls
 * `complete`, an independent verifier evaluates the goal. Only the verifier can
 * approve completion — if it rejects, the agent MUST continue working.
 * There is no override mechanism; the verifier's decision is final.
 *
 * Pause/resume/budget changes are controlled by the user or system through
 * dedicated commands/tools.
 *
 * @deprecated This v1 engine is no longer the primary runtime. The active goal
 * path is `@moonshot-ai/agent-core-v2`.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';
import { t } from '@moonshot-ai/kimi-i18n';

import {
  buildGoalBlockedReasonPrompt,
  buildGoalCompletionSummaryPrompt,
  buildGoalVerificationFailedPrompt,
} from './outcome-prompts';
import { runGoalCompletionVerifier } from '../../../agent/goal/completion-verifier';
import type { BuiltinTool } from '../../../agent/tool';
import type { ToolExecution } from '../../../loop/types';
import { toInputJsonSchema } from '../../support/input-schema';
import { tryNativeGoalEngineDecideBlockedAudit } from '../native-tools';
import DESCRIPTION from './update-goal.md?raw';

export const UpdateGoalToolInputSchema = z
  .object({
    status: z
      .enum(['complete', 'blocked'])
      .describe(
        'The lifecycle status to set for the current goal. Use `complete` to REQUEST completion — an independent verifier will check the work; if it rejects, you MUST continue working (there is no override). Use `blocked` for impossible, unsafe, or contradictory objectives, or after the same blocking condition repeats for at least 3 consecutive goal turns and you cannot make meaningful progress without user input or an external-state change.',
      ),
  })
  .strict();

export type UpdateGoalToolInput = z.infer<typeof UpdateGoalToolInputSchema>;

export class UpdateGoalTool implements BuiltinTool<UpdateGoalToolInput> {
  readonly name = 'UpdateGoal' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(UpdateGoalToolInputSchema);

  constructor(private readonly agent: Agent) {}

  resolveExecution(args: UpdateGoalToolInput): ToolExecution {
    if (!isUpdateGoalStatus(args.status)) {
      return {
        isError: true,
        output: t('toolsV2.goal.invalidStatus'),
      };
    }

    const status = args.status;
    const goal = this.agent.goal;
    const currentGoal = goal.getGoal().goal;
    const goalIsActive = currentGoal?.status === 'active';

    return {
      description: `Setting goal status: ${status}`,
      stopBatchAfterThis: goalIsActive,
      approvalRule: this.name,
      execute: async (ctx) => {
        if (status === 'complete') {
          if (!goalIsActive || currentGoal === undefined) {
            return { output: t('toolsV2.goal.notCompleted') };
          }
          // The agent cannot complete a goal on its own. An independent
          // verifier checks the work. Only the verifier can approve completion.
          // There is NO override — the verifier's decision is final.
          const verifierEnabled =
            this.agent.experimentalFlags?.enabled('goal_completion_verifier') === true;
          const verification = verifierEnabled
            ? await runGoalCompletionVerifier(this.agent, currentGoal, '', ctx.signal)
            : { passed: true, feedback: '' };
          if (!verification.passed) {
            // Verifier rejects — no override, agent must fix issues.
            return {
              output: buildGoalVerificationFailedPrompt(
                verification.feedback,
                1,
                Infinity, // No override threshold — verifier's decision is final
              ) + '\n\nThe verifier\'s decision is final. There is no override. Fix the issues and try again.',
            };
          }
          // Verifier approved — only the verifier can grant completion.
          const completed = await goal.markComplete({}, 'model');
          if (completed === null) {
            return { output: t('toolsV2.goal.notCompleted') };
          }
          const output = buildGoalCompletionSummaryPrompt(completed);
          return { output, stopTurn: true };
        }
        if (status === 'blocked') {
          if (!goalIsActive) {
            return { output: t('toolsV2.goal.notBlocked') };
          }
          // Engine owns the 3-turn blocked audit (native-first, TS fallback).
          const auditResult = tryNativeGoalEngineDecideBlockedAudit(
            JSON.stringify({ goal: currentGoal }),
          );
          let shouldBlock: boolean;
          let attemptMessage: string | undefined;
          if (auditResult?.action === 'record_attempt') {
            shouldBlock = false;
            attemptMessage = auditResult.message;
          } else if (auditResult?.action === 'mark_blocked') {
            shouldBlock = true;
          } else {
            // Native unavailable — fall back to inline TS audit.
            const streak = currentGoal?.blockedStreak ?? 0;
            const MIN_BLOCKED_STREAK = 2; // 0-indexed: 0,1,2 = 3 turns
            shouldBlock = streak >= MIN_BLOCKED_STREAK;
            if (!shouldBlock) {
              attemptMessage = `Blocking condition noted (attempt ${streak + 1}/3). The same blocking condition must repeat for at least 3 consecutive goal turns before calling UpdateGoal with "blocked". Continue working or adjust your approach.`;
            }
          }
          if (!shouldBlock) {
            await goal.recordBlockedAttempt();
            return { output: attemptMessage ?? 'Blocking condition noted.' };
          }
          const blocked = await goal.markBlocked({}, 'model');
          if (blocked === null) {
            return { output: t('toolsV2.goal.notBlocked') };
          }
          const output = buildGoalBlockedReasonPrompt(blocked);
          return { output, stopTurn: true };
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
