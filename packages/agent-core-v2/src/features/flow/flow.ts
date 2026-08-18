import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { DeepReadonly } from '#/state/state';

export const FLOW_FLAG_ID = 'flow';

export const FLOW_REVIEWER_PROFILE = 'flow-reviewer';

export const FLOW_START_TOOL_NAME = 'FlowStart';
export const FLOW_ADVANCE_TOOL_NAME = 'FlowAdvance';
export const FLOW_ABORT_TOOL_NAME = 'FlowAbort';

export const FLOWS_PROJECT_DIR = '.kimi-code/flows';

export const FlowGateKindSchema = z.enum(['ai', 'human', 'ai-then-human']);
export type FlowGateKind = z.infer<typeof FlowGateKindSchema>;

export const FlowStageDefinitionSchema = z.object({
  id: z.string(),
  objective: z.string(),
  completion: z.string(),
  gate: FlowGateKindSchema,
  notes: z.string().optional(),
});
export type FlowStageDefinition = z.infer<typeof FlowStageDefinitionSchema>;

export interface FlowDefinition {
  readonly id: string;
  readonly when?: string;
  readonly stages: readonly FlowStageDefinition[];
}

/**
 * Structural schema of a parsed flow definition, used to revalidate a
 * definition carried as opaque `data` on a projected flow skill before an
 * automatic run start.
 */
export const FlowDefinitionSchema = z.object({
  id: z.string().min(1),
  when: z.string().optional(),
  stages: z.array(FlowStageDefinitionSchema).min(1),
});

export interface FlowRunState {
  active: boolean;
  flowId?: string;
  task?: string;
  stages?: FlowStageDefinition[];
  currentStageIndex?: number;
  endedReason?: 'finished' | 'aborted';
  endedNote?: string;
}

export const FlowCriterionVerdictSchema = z.object({
  criterion: z
    .string()
    .trim()
    .min(1)
    .describe('One completion criterion of the current stage, quoted or tightly paraphrased.'),
  met: z.boolean().describe('Whether the evidence shows this criterion is satisfied.'),
  evidence: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Objective evidence backing the verdict: file paths, test output excerpts, produced artifacts. Never the worker summary alone.',
    ),
});
export type FlowCriterionVerdict = z.infer<typeof FlowCriterionVerdictSchema>;

export type FlowVerdictResult = 'pass' | 'reject';
export type FlowVerdictDecider = 'ai' | 'human' | 'auto';

export interface FlowGateRecord {
  readonly stage: string;
  readonly result: FlowVerdictResult;
  readonly decidedBy: FlowVerdictDecider;
  readonly criteria: readonly FlowCriterionVerdict[];
  readonly feedback?: string;
}

export interface FlowGatesState {
  records: FlowGateRecord[];
  flowId?: string;
  task?: string;
}

export interface FlowAdvanceOutcome {
  readonly stage: string;
  readonly result: FlowVerdictResult;
  readonly decidedBy: FlowVerdictDecider;
  readonly criteria: readonly FlowCriterionVerdict[];
  readonly feedback?: string;
}

export interface FlowAdvanceResult {
  readonly recorded: boolean;
  readonly runFinished: boolean;
  readonly nextStage?: DeepReadonly<FlowStageDefinition>;
}

export interface IAgentFlowService {
  readonly _serviceBrand: undefined;

  run(): DeepReadonly<FlowRunState>;
  gates(): DeepReadonly<FlowGatesState>;
  currentStage(): DeepReadonly<FlowStageDefinition> | undefined;
  start(definition: FlowDefinition, task: string): boolean;
  advance(outcome: FlowAdvanceOutcome): FlowAdvanceResult;
  abort(note?: string): void;
  /** Monotonic run generation — bumped on start, abort, and conversation
   *  undo. Lets consumers (stage reminders, gate reviews) tell a restarted
   *  run apart from the one they observed, even when every rendered field
   *  matches. */
  runEpoch(): number;
  /** One-shot check that the user actually approved this call's gate review
   *  (set by the gate hook when the approval resolves approved; consumed by
   *  FlowAdvance's execution so the verdict provenance cannot be inferred
   *  from prepare-time mode/display state). */
  consumeGateApproval(toolCallId: string): boolean;
}

export const IAgentFlowService: ServiceIdentifier<IAgentFlowService> =
  createDecorator<IAgentFlowService>('agentFlowService');
