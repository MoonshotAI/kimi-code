/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentStatusUpdated, type AgentFlowRunStatus } from '#/agent/usage/usageEvents';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import {
  FlowCriterionVerdictSchema,
  FlowJumpPolicySchema,
  FlowStageDefinitionSchema,
  type FlowGatesState,
  type FlowRunState,
} from './flow';

import '#/agent/contextMemory/conversationTime';

const flowRunStartedSchema = z.object({
  flowId: z.string(),
  task: z.string(),
  stages: z.array(FlowStageDefinitionSchema),
  runId: z.string().optional(),
  jumpPolicy: FlowJumpPolicySchema.optional(),
});

export class FlowRunStarted extends Event2<z.infer<typeof flowRunStartedSchema>> {
  static override readonly type = 'flow_run.started';
  static override readonly durable = true;
  static override readonly schema = flowRunStartedSchema;
}
export interface FlowRunStarted extends z.infer<typeof flowRunStartedSchema> {}

const flowVerdictSchema = z.object({
  stage: z.string(),
  result: z.enum(['pass', 'reject']),
  decidedBy: z.enum(['ai', 'human', 'auto']),
  criteria: z.array(FlowCriterionVerdictSchema),
  feedback: z.string().optional(),
  flowId: z.string().optional(),
  task: z.string().optional(),
  runId: z.string().optional(),
});

export class FlowVerdict extends Event2<z.infer<typeof flowVerdictSchema>> {
  static override readonly type = 'flow_run.verdict';
  static override readonly durable = true;
  static override readonly schema = flowVerdictSchema;
}
export interface FlowVerdict extends z.infer<typeof flowVerdictSchema> {}

const flowJumpedSchema = z.object({
  fromStage: z.string(),
  toStage: z.string(),
  reason: z.string(),
  decidedBy: z.enum(['ai', 'human', 'auto']),
  flowId: z.string().optional(),
  task: z.string().optional(),
  runId: z.string().optional(),
});

export class FlowJumped extends Event2<z.infer<typeof flowJumpedSchema>> {
  static override readonly type = 'flow_run.jumped';
  static override readonly durable = true;
  static override readonly schema = flowJumpedSchema;
}
export interface FlowJumped extends z.infer<typeof flowJumpedSchema> {}

const flowRunEndedSchema = z.object({
  reason: z.enum(['finished', 'aborted']),
  note: z.string().optional(),
});

export class FlowRunEnded extends Event2<z.infer<typeof flowRunEndedSchema>> {
  static override readonly type = 'flow_run.ended';
  static override readonly durable = true;
  static override readonly schema = flowRunEndedSchema;
}
export interface FlowRunEnded extends z.infer<typeof flowRunEndedSchema> {}

function flowRunStatus(s: FlowRunState): AgentFlowRunStatus | null {
  if (!s.active || s.flowId === undefined) return null;
  const index = s.currentStageIndex ?? 0;
  const stage = s.stages?.[index];
  if (stage === undefined) return null;
  return {
    flowId: s.flowId,
    stageId: stage.id,
    stageIndex: index,
    stageTotal: s.stages?.length ?? 0,
    gate: stage.gate,
  };
}

export const flowKey = defineState('flow', (): FlowRunState => ({ active: false }))
  .replayable({ schema: z.custom<FlowRunState>() })
  .undoable()
  .on(FlowRunStarted, (s, e, ctx) => {
    if (s.active) return;
    s.active = true;
    s.flowId = e.flowId;
    s.task = e.task;
    if (e.runId === undefined) delete s.runId;
    else s.runId = e.runId;
    s.stages = e.stages;
    s.currentStageIndex = 0;
    if (e.jumpPolicy === undefined) delete s.jumpPolicy;
    else s.jumpPolicy = e.jumpPolicy;
    delete s.endedReason;
    delete s.endedNote;
    ctx.emit(new AgentStatusUpdated({ agentId: MAIN_AGENT_ID, flowRun: flowRunStatus(s) }));
  })
  .on(FlowJumped, (s, e, ctx) => {
    if (!s.active) return;
    const target = s.stages?.findIndex((stage) => stage.id === e.toStage) ?? -1;
    if (target < 0) return;
    s.currentStageIndex = target;
    ctx.emit(new AgentStatusUpdated({ agentId: MAIN_AGENT_ID, flowRun: flowRunStatus(s) }));
  })
  .on(FlowVerdict, (s, e, ctx) => {
    if (!s.active) return;
    const index = s.currentStageIndex ?? 0;
    if (s.stages?.[index]?.id !== e.stage) return;
    if (e.result === 'pass') s.currentStageIndex = index + 1;
    if ((s.currentStageIndex ?? 0) >= (s.stages?.length ?? 0)) {
      s.active = false;
      s.endedReason = 'finished';
    }
    ctx.emit(new AgentStatusUpdated({ agentId: MAIN_AGENT_ID, flowRun: flowRunStatus(s) }));
  })
  .on(FlowRunEnded, (s, e, ctx) => {
    s.active = false;
    delete s.stages;
    delete s.currentStageIndex;
    s.endedReason = e.reason;
    if (e.note === undefined) delete s.endedNote;
    else s.endedNote = e.note;
    ctx.emit(new AgentStatusUpdated({ agentId: MAIN_AGENT_ID, flowRun: null }));
  });

export const flowGatesKey = defineState('flow.gates', (): FlowGatesState => ({ records: [] }))
  .replayable({ schema: z.custom<FlowGatesState>() })
  .on(FlowRunStarted, (s, e) => {
    s.records = [];
    s.flowId = e.flowId;
    s.task = e.task;
    if (e.runId === undefined) delete s.runId;
    else s.runId = e.runId;
  })
  .on(FlowVerdict, (s, e) => {
    openAuditSegment(s, e);
    s.records.push({
      stage: e.stage,
      result: e.result,
      decidedBy: e.decidedBy,
      criteria: e.criteria,
      feedback: e.feedback,
    });
  })
  .on(FlowJumped, (s, e) => {
    openAuditSegment(s, e);
    s.records.push({
      kind: 'jump',
      fromStage: e.fromStage,
      toStage: e.toStage,
      reason: e.reason,
      decidedBy: e.decidedBy,
    });
  });

function openAuditSegment(
  s: FlowGatesState,
  e: { readonly flowId?: string; readonly task?: string; readonly runId?: string },
): void {
  const identityDiffers =
    e.runId !== undefined && s.runId !== undefined
      ? e.runId !== s.runId
      : e.flowId !== undefined && s.flowId !== undefined && e.flowId !== s.flowId;
  if (!identityDiffers) return;
  s.records = [];
  if (e.flowId === undefined) delete s.flowId;
  else s.flowId = e.flowId;
  if (e.task === undefined) delete s.task;
  else s.task = e.task;
  if (e.runId === undefined) delete s.runId;
  else s.runId = e.runId;
}
