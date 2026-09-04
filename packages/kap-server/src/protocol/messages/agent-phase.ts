import { z } from 'zod';

const phaseTurnId = z.number().int().nonnegative();
const phaseStep = z.number().int().nonnegative();
const phaseSince = z.number();
const phaseAt = z.number();

export const agentPhaseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('idle'),
  }),
  z.object({
    kind: z.literal('running'),
    turn_id: phaseTurnId,
    step: phaseStep,
    step_id: z.string().min(1),
    since: phaseSince,
  }),
  z.object({
    kind: z.literal('streaming'),
    turn_id: phaseTurnId,
    step: phaseStep,
    step_id: z.string().min(1),
    stream: z.enum(['assistant', 'thinking', 'tool_call']),
    tool_call_id: z.string().min(1).optional(),
    tool_name: z.string().optional(),
    since: phaseSince,
  }),
  z.object({
    kind: z.literal('tool_call'),
    turn_id: phaseTurnId,
    step: phaseStep,
    tool_call_id: z.string().min(1),
    name: z.string().min(1),
    since: phaseSince,
  }),
  z.object({
    kind: z.literal('retrying'),
    turn_id: phaseTurnId,
    step: phaseStep,
    step_id: z.string().min(1),
    failed_attempt: z.number().int().positive(),
    next_attempt: z.number().int().positive(),
    max_attempts: z.number().int().positive(),
    delay_ms: z.number().nonnegative(),
    error_name: z.string().optional(),
    status_code: z.number().int().optional(),
    since: phaseSince,
  }),
  z.object({
    kind: z.literal('awaiting_approval'),
    turn_id: phaseTurnId,
    step: phaseStep.optional(),
    approval: z.unknown().optional(),
    since: phaseSince,
  }),
  z.object({
    kind: z.literal('interrupted'),
    turn_id: phaseTurnId,
    step: phaseStep.optional(),
    reason: z.enum(['aborted', 'max_steps', 'error']),
    message: z.string().optional(),
    at: phaseAt,
  }),
  z.object({
    kind: z.literal('ended'),
    turn_id: phaseTurnId,
    reason: z.enum(['completed', 'cancelled', 'failed', 'blocked']),
    duration_ms: z.number().nonnegative().optional(),
    at: phaseAt,
  }),
]);

export type AgentPhase = z.infer<typeof agentPhaseSchema>;
