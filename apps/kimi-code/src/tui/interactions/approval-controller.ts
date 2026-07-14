/**
 * Pending-model approval controller.
 *
 * Consumes the session's approval broker (`session.approvals`): every pending
 * approval is projected into the panel view and presented through the modal
 * `PanelQueue` (one panel at a time, arrival order, approve-for-session
 * auto-resolution for queued same-action pendings). The user's choice is
 * written back with `approvals.decide`; pendings resolved outside the panel
 * (another client, policy) are retracted from the queue via `onDidResolve`.
 * Detach retracts the UI without deciding — pendings stay parked in the
 * engine and are re-presented on the next attach.
 */

import type { ApprovalResponse, CoreSession, PendingApproval } from '#/core/index';

import { adaptApprovalRequest } from './approval-adapter';
import { PanelQueue, type PanelQueueUIHooks } from './panel-queue';
import type { ApprovalPanelData } from './types';

class ApprovalPanelQueue extends PanelQueue<ApprovalPanelData, ApprovalResponse> {
  protected override autoResolveFor(
    resolvedPayload: ApprovalPanelData,
    response: ApprovalResponse,
    queuedPayload: ApprovalPanelData,
  ): ApprovalResponse | undefined {
    if (response.decision !== 'approved') return undefined;
    if (response.scope !== 'session') return undefined;
    if (resolvedPayload.action !== queuedPayload.action) return undefined;
    // Inherit the session-scoped approval. Drop `feedback` and
    // `selectedLabel` — those described the user's interaction with the
    // first request only and would be misleading on auto-resolved ones.
    return { decision: 'approved', scope: 'session' };
  }
}

export interface ApprovalControllerEvents {
  /** Fired after a decision made through the panel flow is written back. */
  readonly onDecided?: (pending: PendingApproval, response: ApprovalResponse) => void;
}

export class ApprovalController {
  private readonly queue = new ApprovalPanelQueue();
  /** Pending ids currently owned by a `present()` loop (dedupes re-scans). */
  private readonly inFlight = new Set<string>();
  private teardowns: Array<() => void> = [];

  setUIHooks(hooks: PanelQueueUIHooks<ApprovalPanelData>): void {
    this.queue.setUIHooks(hooks);
  }

  /** Called by the UI after the user makes a panel choice. */
  respond(response: ApprovalResponse): void {
    this.queue.respond(response);
  }

  hasPending(): boolean {
    return this.queue.hasPending();
  }

  /** Subscribe to the session's approval broker; returns the teardown. */
  attach(session: CoreSession, events: ApprovalControllerEvents = {}): () => void {
    this.teardowns = [
      session.approvals.onDidChangePending(() => {
        this.scan(session, events);
      }),
      session.approvals.onDidResolve((id) => {
        this.inFlight.delete(id);
        // Resolved outside the panel flow: fold the panel/queue entry away.
        this.queue.retract((payload) => payload.id === id);
      }),
    ];
    // Pendings parked before the TUI attached (resume, reload) present now.
    this.scan(session, events);
    return () => {
      this.detach();
    };
  }

  /** Drop broker subscriptions and retract panels without deciding. */
  detach(): void {
    const teardowns = this.teardowns;
    this.teardowns = [];
    for (const teardown of teardowns) teardown();
    this.inFlight.clear();
    this.queue.retractAll();
  }

  private scan(session: CoreSession, events: ApprovalControllerEvents): void {
    for (const pending of session.approvals.list()) {
      if (this.inFlight.has(pending.id)) continue;
      this.inFlight.add(pending.id);
      void this.present(session, pending, events);
    }
  }

  private async present(
    session: CoreSession,
    pending: PendingApproval,
    events: ApprovalControllerEvents,
  ): Promise<void> {
    try {
      const response = await this.queue.show(adaptApprovalRequest(pending.request, pending.id));
      // Retracted: resolved externally or the session detached — never decide.
      if (response === undefined) return;
      session.approvals.decide(pending.id, response);
      events.onDecided?.(pending, response);
    } catch (error) {
      // The panel path must settle the pending; otherwise the turn hangs.
      const feedback = `Approval UI failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      try {
        const response: ApprovalResponse = { decision: 'cancelled', feedback };
        session.approvals.decide(pending.id, response);
        events.onDecided?.(pending, response);
      } catch {
        /* best-effort: the pending may have been resolved concurrently */
      }
    } finally {
      this.inFlight.delete(pending.id);
    }
  }
}
