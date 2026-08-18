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

export interface FlowRunState {
  active: boolean;
  flowId?: string;
  task?: string;
  stages?: FlowStageDefinition[];
  currentStageIndex?: number;
}

export const FlowCriterionVerdictSchema = z.object({
  criterion: z.string().describe('One completion criterion of the current stage, quoted or tightly paraphrased.'),
  met: z.boolean().describe('Whether the evidence shows this criterion is satisfied.'),
  evidence: z
    .string()
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
}

export const IAgentFlowService: ServiceIdentifier<IAgentFlowService> =
  createDecorator<IAgentFlowService>('agentFlowService');
