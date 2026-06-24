/**
 * `approval` domain (L7) — `IApprovalService` in-memory broker.
 *
 * Pending approval requests are stored per session. `request` returns a
 * promise that `decide` resolves; `listPending` surfaces the open requests
 * (the reverse-RPC bridge to the client is wired in a later step).
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import {
  type ApprovalDecision,
  type ApprovalRequest,
  IApprovalService,
} from './approval';

interface Pending {
  readonly req: ApprovalRequest;
  readonly resolve: (decision: ApprovalDecision) => void;
}

export class ApprovalService implements IApprovalService {
  declare readonly _serviceBrand: undefined;
  private readonly pending = new Map<string, Pending>();

  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      this.pending.set(req.id, { req, resolve });
    });
  }

  decide(id: string, decision: ApprovalDecision): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    entry.resolve(decision);
  }

  listPending(): readonly ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.req);
  }
}

registerScopedService(LifecycleScope.Session, IApprovalService, ApprovalService, InstantiationType.Delayed, 'approval');
