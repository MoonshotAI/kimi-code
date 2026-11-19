
import type { SessionAdminBatchOutcome } from './useSessionAdmin';

export type SessionAdminBatchDirection = 'archive' | 'restore';

export interface AdminBatchToastPlan {
  direction: SessionAdminBatchDirection;
  ids: string[];
  succeeded: number;
  failed: number;
}

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

export function undoBatchDirectionOf(
  direction: SessionAdminBatchDirection,
): SessionAdminBatchDirection {
  return direction === 'archive' ? 'restore' : 'archive';
}
