/**
 * `plan` domain — the plan-mode state (`planKey`) and the durable
 * `plan_mode.enter` / `plan_mode.cancel` / `plan_mode.exit` / `plan.revision`
 * events that mirror the plan-mode lifecycle into a persisted, replayable
 * `{ active, id }` state.
 *
 * The state holds the persistent, replayable fields — whether plan mode is
 * active, the plan id, and the last recorded revision version per plan id —
 * participating in conversation undo through the undoable state protocol
 * so plan mode stays aligned with it. The lifecycle records keep exactly v1's field set
 * (`{ id }`); the plan file path is NOT persisted — it is derived from the id
 * at read time, matching v1's `restoreEnter`. Plan content is recorded
 * separately: every ExitPlanMode submit snapshots the plan file into blob
 * storage and persists a `plan.revision` record carrying only the reference
 * (`{ id, version, path, sha256, bytes }`, `path` homeDir-relative) — never
 * the content. `revisionCount` tracks the latest version per plan id so
 * `recordRevision` can mint the next version replay-consistently; it is kept
 * across enter/exit so a re-entered plan id continues its counter instead of
 * overwriting earlier blobs. Each fold keeps the same reference on a no-op
 * (re-entering the same plan, or cancelling/exiting while already inactive)
 * so the state's reference-equality stays quiet. The side effects —
 * `telemetryContext` mode, plan-directory/file fs I/O, and the blob write —
 * are NOT part of the folds: they run after dispatch on the live path, and
 * restore rebuilds the state silently from the persisted `plan_mode.*` /
 * `plan.revision` records. The lifecycle folds emit the
 * `agent.status.updated` planMode slice live (never on replay), and
 * `PlanRevision` is itself observable so the live transcript projector can
 * map it onto a marker plus the plan badge.
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { z } from 'zod';

import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import '#/agent/contextMemory/conversationTime';

export interface PlanState {
  readonly active: boolean;
  readonly id?: string;
  readonly revisionCount?: Readonly<Record<string, number>>;
}

const planModeEnterSchema = z.object({ id: z.string() });

export class PlanModeEnter extends Event2<z.infer<typeof planModeEnterSchema>> {
  static override readonly type = 'plan_mode.enter';
  static override readonly durable = true;
  static override readonly schema = planModeEnterSchema;
}
export interface PlanModeEnter extends z.infer<typeof planModeEnterSchema> {}

const planModeCancelSchema = z.object({ id: z.string().optional() });

export class PlanModeCancel extends Event2<z.infer<typeof planModeCancelSchema>> {
  static override readonly type = 'plan_mode.cancel';
  static override readonly durable = true;
  static override readonly schema = planModeCancelSchema;
}
export interface PlanModeCancel extends z.infer<typeof planModeCancelSchema> {}

const planModeExitSchema = z.object({ id: z.string().optional() });

export class PlanModeExit extends Event2<z.infer<typeof planModeExitSchema>> {
  static override readonly type = 'plan_mode.exit';
  static override readonly durable = true;
  static override readonly schema = planModeExitSchema;
}
export interface PlanModeExit extends z.infer<typeof planModeExitSchema> {}

export interface PlanRevisionRecordedEvent {
  readonly id: string;
  readonly version: number;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

const planRevisionSchema = z.object({
  id: z.string(),
  version: z.number(),
  path: z.string(),
  sha256: z.string(),
  bytes: z.number(),
});

export class PlanRevision extends Event2<PlanRevisionRecordedEvent> {
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
    ctx.emit(new AgentStatusUpdated({ planMode: true }));
  })
  .on(PlanModeCancel, (s, e, ctx) => {
    if (s.active) {
      s.active = false;
      delete s.id;
    }
    ctx.emit(new AgentStatusUpdated({ planMode: false }));
  })
  .on(PlanModeExit, (s, e, ctx) => {
    if (s.active) {
      s.active = false;
      delete s.id;
    }
    ctx.emit(new AgentStatusUpdated({ planMode: false }));
  })
  .on(PlanRevision, (s, e) => {
    s.revisionCount = { ...s.revisionCount, [e.id]: e.version };
  });
