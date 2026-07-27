/**
 * `workflow` domain (L4) — wire Model (`WorkflowModel`) and the `workflow_mode.enter` /
 * `workflow_mode.exit` Ops (`workflowModeEnter` / `workflowModeExit`) for the
 * agent's workflow mode.
 *
 * Declares workflow mode as a `WorkflowModeTrigger | null` wire Model (the
 * trigger is retained so enter/exit can be replayed) plus the two Ops that
 * set and clear it. The `workflowMode` slice of `agent.status.updated` is
 * declared centrally in `usageOps`. Consumed by the Agent-scope
 * `workflowModeService`.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

import type { WorkflowModeTrigger } from './workflowMode';

export const WorkflowModel = defineModel<WorkflowModeTrigger | null>('workflow', () => null);

declare module '#/wire/types' {
  interface PersistedOpMap {
    'workflow_mode.enter': typeof workflowModeEnter;
    'workflow_mode.exit': typeof workflowModeExit;
  }
}

export const workflowModeEnter = WorkflowModel.defineOp('workflow_mode.enter', {
  schema: z.object({ trigger: z.custom<WorkflowModeTrigger>() }),
  apply: (_s, p) => p.trigger,
  toEvent: () => ({ type: 'agent.status.updated' as const, workflowMode: true }),
});

export const workflowModeExit = WorkflowModel.defineOp('workflow_mode.exit', {
  schema: z.object({}),
  apply: () => null,
  toEvent: () => ({ type: 'agent.status.updated' as const, workflowMode: false }),
});
