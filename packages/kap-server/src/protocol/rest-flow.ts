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
  kind: z.literal('verdict').optional(),
  stage: z.string(),
  result: z.enum(['pass', 'reject']),
  decided_by: z.enum(['ai', 'human', 'auto']),
  criteria: z.array(flowCriterionVerdictSchema),
  feedback: z.string().optional(),
});
export type FlowGateRecord = z.infer<typeof flowGateRecordSchema>;

export const flowJumpRecordSchema = z.object({
  kind: z.literal('jump'),
  from_stage: z.string(),
  to_stage: z.string(),
  reason: z.string(),
  decided_by: z.enum(['ai', 'human', 'auto']),
});
export type FlowJumpRecord = z.infer<typeof flowJumpRecordSchema>;

export const flowAuditRecordSchema = z.union([flowGateRecordSchema, flowJumpRecordSchema]);
export type FlowAuditRecord = z.infer<typeof flowAuditRecordSchema>;

export const flowStateResponseSchema = z.object({
  run: z.object({
    active: z.boolean(),
    flow_id: z.string().optional(),
    task: z.string().optional(),
    stages: z.array(flowStageSchema).optional(),
    current_stage_index: z.number().int().nonnegative().optional(),
    jump_policy: z.enum(['disabled', 'approval', 'free']).optional(),
    ended_reason: z.enum(['finished', 'aborted']).optional(),
    ended_note: z.string().optional(),
    run_id: z.string().optional(),
  }),
  gates: z.array(flowAuditRecordSchema),
  gates_flow_id: z.string().optional(),
  gates_task: z.string().optional(),
  gates_run_id: z.string().optional(),
});
export type FlowStateResponse = z.infer<typeof flowStateResponseSchema>;
