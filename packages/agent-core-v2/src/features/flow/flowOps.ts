/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import {
  FlowCriterionVerdictSchema,
  FlowStageDefinitionSchema,
  type FlowGatesState,
  type FlowRunState,
} from './flow';

import '#/agent/contextMemory/conversationTime';

const flowRunStartedSchema = z.object({
  flowId: z.string(),
  task: z.string(),
  stages: z.array(FlowStageDefinitionSchema),
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
});

export class FlowVerdict extends Event2<z.infer<typeof flowVerdictSchema>> {
  static override readonly type = 'flow_run.verdict';
  static override readonly durable = true;
  static override readonly schema = flowVerdictSchema;
}
export interface FlowVerdict extends z.infer<typeof flowVerdictSchema> {}

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

export const flowKey = defineState('flow', (): FlowRunState => ({ active: false }))
  .replayable({ schema: z.custom<FlowRunState>() })
  .undoable()
  .on(FlowRunStarted, (s, e) => {
    s.active = true;
    s.flowId = e.flowId;
    s.task = e.task;
    s.stages = e.stages;
    s.currentStageIndex = 0;
  })
  .on(FlowVerdict, (s, e) => {
    if (!s.active) return;
    if (e.result !== 'pass') return;
    const index = s.currentStageIndex ?? 0;
    if (s.stages?.[index]?.id !== e.stage) return;
    s.currentStageIndex = index + 1;
  })
  .on(FlowRunEnded, (s) => {
    s.active = false;
    delete s.flowId;
    delete s.task;
    delete s.stages;
    delete s.currentStageIndex;
  });

export const flowGatesKey = defineState('flow.gates', (): FlowGatesState => ({ records: [] }))
  .replayable({ schema: z.custom<FlowGatesState>() })
  .on(FlowRunStarted, (s) => {
    s.records = [];
  })
  .on(FlowVerdict, (s, e) => {
    s.records.push({
      stage: e.stage,
      result: e.result,
      decidedBy: e.decidedBy,
      criteria: e.criteria,
      feedback: e.feedback,
    });
  });
