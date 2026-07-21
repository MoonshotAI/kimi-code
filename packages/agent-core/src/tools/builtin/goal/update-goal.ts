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
 * signal.
 */

import type { Agent } from '#/agent';
import { z } from 'zod';

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

/** Consecutive verifier-rejected completions before the goal is marked blocked. */
const MAX_COMPLETION_REJECTIONS = 2;

export const UpdateGoalToolInputSchema = z
  .object({
    status: z
      .enum(['complete', 'blocked'])
      .describe(
        'The lifecycle status to set for the current goal. Use `complete` only when the objective has actually been achieved and no required work remains, verified against the actual current state — note that an independent verifier will check the work before completion is granted, and will reject it if the objective or completion criterion is not verifiably satisfied. Use `blocked` for impossible, unsafe, or contradictory objectives, or after the same blocking condition repeats for at least 3 consecutive goal turns and you cannot make meaningful progress without user input or an external-state change.',
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
        output: 'Invalid goal status. Use `complete` or `blocked`.',
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
            return { output: 'Goal not completed: no active goal.' };
          }
          // Completion is not granted on the worker's own say-so: an isolated
          // verifier independently checks the work against the objective and
          // completion criterion first (gated by an experimental flag).
          const verifierEnabled =
            this.agent.experimentalFlags?.enabled('goal_completion_verifier') === true;
          const verification = verifierEnabled
            ? await runGoalCompletionVerifier(this.agent, currentGoal, '', ctx.signal)
            : { passed: true, feedback: '' };
          if (!verification.passed) {
            const rejections = await goal.recordCompletionRejection();
            if (rejections >= MAX_COMPLETION_REJECTIONS) {
              const blocked = await goal.markBlocked(
                { reason: `Completion verifier rejected the goal: ${verification.feedback}` },
                'model',
              );
              if (blocked === null) {
                return { output: 'Goal not blocked: no active goal.' };
              }
              return { output: buildGoalBlockedReasonPrompt(blocked), stopTurn: true };
            }
            return {
              output: buildGoalVerificationFailedPrompt(
                verification.feedback,
                rejections,
                MAX_COMPLETION_REJECTIONS,
              ),
            };
          }
          const completed = await goal.markComplete({}, 'model');
          if (completed === null) {
            return { output: 'Goal not completed: no active goal.' };
          }
          const output =
            buildGoalCompletionSummaryPrompt(completed);
          return { output, stopTurn: true };
        }
        if (status === 'blocked') {
          if (!goalIsActive) {
            return { output: 'Goal not blocked: no active goal.' };
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
            return { output: 'Goal not blocked: no active goal.' };
          }
          const output = buildGoalBlockedReasonPrompt(blocked);
          return { output, stopTurn: true };
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
