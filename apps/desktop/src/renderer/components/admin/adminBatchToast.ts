// apps/desktop/src/renderer/components/admin/adminBatchToast.ts
// Toast plan for the session admin page's batch archive/restore: what the
// ActionToast should carry after a batch outcome, and the undo direction.
// Pure — App.vue applies the plan to its shared actionToast state (and shows
// a WarningToast instead when nothing succeeded); tests pin the mapping.

import type { SessionAdminBatchOutcome } from '@moonshot-ai/app-client/client';

export type SessionAdminBatchDirection = 'archive' | 'restore';

export interface AdminBatchToastPlan {
  direction: SessionAdminBatchDirection;
  /** Undo set: exactly the per-item successes. */
  ids: string[];
  succeeded: number;
  failed: number;
}

/** The toast is only shown when at least one item succeeded — an all-failed
 *  batch has nothing to undo and is surfaced as an error notice instead. */
export function planAdminBatchToast(
  direction: SessionAdminBatchDirection,
  outcome: SessionAdminBatchOutcome,
): AdminBatchToastPlan | null {
  if (outcome.succeeded === 0) return null;
  return {
    direction,
    ids: outcome.okIds,
    succeeded: outcome.succeeded,
    failed: outcome.failed,
  };
}

/** Undo of a batch is the same id set through the inverse endpoint. */
export function undoBatchDirectionOf(
  direction: SessionAdminBatchDirection,
): SessionAdminBatchDirection {
  return direction === 'archive' ? 'restore' : 'archive';
}
