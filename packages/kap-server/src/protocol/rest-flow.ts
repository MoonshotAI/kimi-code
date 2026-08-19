import { z } from 'zod';

export const flowStageSchema = z.object({
  id: z.string(),
  objective: z.string(),
  completion: z.string(),
  gate: z.enum(['ai', 'human', 'ai-then-human']),
  notes: z.string().optional(),
});
export type FlowStage = z.infer<typeof flowStageSchema>;

export const flowCriterionVerdictSchema = z.object({
  criterion: z.string(),
  met: z.boolean(),
  evidence: z.string(),
});

export const flowGateRecordSchema = z.object({
  stage: z.string(),
  result: z.enum(['pass', 'reject']),
  decided_by: z.enum(['ai', 'human', 'auto']),
  criteria: z.array(flowCriterionVerdictSchema),
  feedback: z.string().optional(),
});
export type FlowGateRecord = z.infer<typeof flowGateRecordSchema>;

export const flowStateResponseSchema = z.object({
  run: z.object({
    active: z.boolean(),
    flow_id: z.string().optional(),
    task: z.string().optional(),
    stages: z.array(flowStageSchema).optional(),
    current_stage_index: z.number().int().nonnegative().optional(),
    ended_reason: z.enum(['finished', 'aborted']).optional(),
    ended_note: z.string().optional(),
    run_id: z.string().optional(),
  }),
  gates: z.array(flowGateRecordSchema),
  gates_flow_id: z.string().optional(),
  gates_task: z.string().optional(),
  gates_run_id: z.string().optional(),
});
export type FlowStateResponse = z.infer<typeof flowStateResponseSchema>;
