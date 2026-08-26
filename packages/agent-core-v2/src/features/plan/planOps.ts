/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import '#/agent/contextMemory/conversationTime';

export interface PlanState {
  readonly active: boolean;
  readonly id?: string;
  readonly revisionCount?: Readonly<Record<string, number>>;
}

const planModeEnterSchema = z.object({ agentId: z.string(), id: z.string() });

export class PlanModeEnter extends AgentEvent2<z.infer<typeof planModeEnterSchema>> {
  static override readonly type = 'plan_mode.enter';
  static override readonly durable = true;
  static override readonly schema = planModeEnterSchema;
}
export interface PlanModeEnter {
  readonly agentId: string;
  readonly id: string;
}

const planModeCancelSchema = z.object({
  agentId: z.string(),
  id: z.string().optional(),
});

export class PlanModeCancel extends AgentEvent2<z.infer<typeof planModeCancelSchema>> {
  static override readonly type = 'plan_mode.cancel';
  static override readonly durable = true;
  static override readonly schema = planModeCancelSchema;
}
export interface PlanModeCancel {
  readonly agentId: string;
  readonly id?: string;
}

const planModeExitSchema = z.object({
  agentId: z.string(),
  id: z.string().optional(),
});

export class PlanModeExit extends AgentEvent2<z.infer<typeof planModeExitSchema>> {
  static override readonly type = 'plan_mode.exit';
  static override readonly durable = true;
  static override readonly schema = planModeExitSchema;
}
export interface PlanModeExit {
  readonly agentId: string;
  readonly id?: string;
}

export interface PlanRevisionRecordedEvent {
  readonly agentId: string;
  readonly id: string;
  readonly version: number;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

const planRevisionSchema = z.object({
  agentId: z.string(),
  id: z.string(),
  version: z.number(),
  path: z.string(),
  sha256: z.string(),
  bytes: z.number(),
});

export class PlanRevision extends AgentEvent2<PlanRevisionRecordedEvent> {
  static override readonly type = 'plan.revision';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = planRevisionSchema;
}
export interface PlanRevision extends PlanRevisionRecordedEvent {}

export const planKey = defineState('plan', (): PlanState => ({ active: false }))
  .replayable({ schema: z.custom<PlanState>() })
  .undoable()
  .on(PlanModeEnter, (s, e, ctx) => {
    if (!(s.active && s.id === e.id)) {
      s.active = true;
      s.id = e.id;
    }
    ctx.emit(new AgentStatusUpdated({ agentId: e.agentId, planMode: true }));
  })
  .on(PlanModeCancel, (s, e, ctx) => {
    if (s.active) {
      s.active = false;
      delete s.id;
    }
    ctx.emit(new AgentStatusUpdated({ agentId: e.agentId, planMode: false }));
  })
  .on(PlanModeExit, (s, e, ctx) => {
    if (s.active) {
      s.active = false;
      delete s.id;
    }
    ctx.emit(new AgentStatusUpdated({ agentId: e.agentId, planMode: false }));
  })
  .on(PlanRevision, (s, e) => {
    s.revisionCount = { ...s.revisionCount, [e.id]: e.version };
  });
