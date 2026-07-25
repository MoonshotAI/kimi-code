import { z } from 'zod';

export const goalStatusSchema = z.enum(['active', 'paused', 'blocked', 'complete']);
export type GoalStatus = z.infer<typeof goalStatusSchema>;

export const goalBudgetReportSchema = z.object({
  tokenBudget: z.number().nullable(),
  turnBudget: z.number().nullable(),
  wallClockBudgetMs: z.number().nullable(),
  remainingTokens: z.number().nullable(),
  remainingTurns: z.number().nullable(),
  remainingWallClockMs: z.number().nullable(),
  tokenBudgetReached: z.boolean(),
  turnBudgetReached: z.boolean(),
  wallClockBudgetReached: z.boolean(),
  overBudget: z.boolean(),
});
export type GoalBudgetReport = z.infer<typeof goalBudgetReportSchema>;

export const goalSnapshotSchema = z.object({
  goalId: z.string(),
  objective: z.string(),
  completionCriterion: z.string().optional(),
  status: goalStatusSchema,
  turnsUsed: z.number(),
  tokensUsed: z.number(),
  wallClockMs: z.number(),
  budget: goalBudgetReportSchema,
  terminalReason: z.string().optional(),
});
export type GoalSnapshotWire = z.infer<typeof goalSnapshotSchema>;
