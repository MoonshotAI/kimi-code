/**
 * `ApprovalService` (daemon-side `IApprovalService` impl).
 *
 * One-shot broker that handles the full reverse-RPC path:
 *
 *   1. `request(req)` (called by `BridgeClientAPI.requestApproval` from
 *      `KimiCore`):
 *        - Mints `approval_id = ulid()` (daemon-allocated, REST path key).
 *        - Records `Map<approvalId, toolCallId>` for correlation (REST
 *          handler resolves by `approval_id`; we keep the original SDK
 *          `toolCallId` so the in-process interface contract stays satisfied).
 *        - Builds protocol `ApprovalRequest` via the services adapter
 *          (`approvalToBrokerRequest`).
 *        - Broadcasts `event.approval.requested` through
 *          `IEventService.publish` (which routes to all WS subscribers AND
 *          ring-buffers the event for replay).
 *        - Holds the Promise + 60s timer; on resolve, settles; on timeout,
 *          broadcasts `event.approval.expired` and rejects with
 *          `ApprovalExpiredError`.
 *
 *   2. `resolve(approvalId, response)` (called by the REST route):
 *        - Settles the Promise.
 *        - Broadcasts `event.approval.resolved` so all subscribers (including
 *          the originating client) see the answer.
 *        - Marks the id in `_recentlyResolved` so a subsequent REST call gets
 *          `40902 already_resolved` (vs `40404 not_found` for typo'd ids).
 *
 * **Synthetic event shape**: `event.approval.*` is NOT in agent-core's
 * `AgentEvent` union (`packages/agent-core/src/rpc/events.ts:287-318`) — the
 * daemon synthesizes them, same pattern as `prompt.completed` /
 * `prompt.aborted` in `PromptService`. The wire payload (per WS.md §4.5)
 * carries the protocol-shaped `ApprovalRequest` fields directly at the top
 * level of the event object (which becomes `envelope.payload` after the
 * `EventService.publish → buildEventEnvelope` wrap).
 *
 * **approval_id ↔ toolCallId correlation**: the in-process `IApprovalService`
 * contract says `resolve(id, ...)`'s `id` matches
 * `req.toolCallId`. The REST path uses daemon-minted `approval_id`. We
 * satisfy BOTH by indexing the pending map by `approvalId` (the daemon's
 * authoritative key) and tracking `toolCallId` alongside for back-compat.
 * The REST handler is the only `resolve()` caller in production today.
 *
 * **Anti-corruption**: this file imports `@moonshot-ai/services` (service
 * interface + adapter) and `@moonshot-ai/protocol` (Event type for the
 * publish call). No direct node-sdk references — agent-core's in-process
 * `ApprovalRequest`/`ApprovalResponse` flow through the services re-export.
 */

import { ulid } from 'ulid';

import { Disposable } from '@moonshot-ai/agent-core';
import type {
  ApprovalRequest as ProtocolApprovalRequest,
  Event,
} from '@moonshot-ai/protocol';
import {
  IApprovalService,
  IEventService,
  approvalToBrokerRequest,
  type ApprovalRequest,
  type ApprovalResponse,
} from '@moonshot-ai/services';

import { ILogService } from '#/services/logger';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _typeAnchor: typeof IApprovalService = IApprovalService;

/** Default 60s timeout per SCHEMAS §6.1. Overridable for tests. */
export const APPROVAL_DEFAULT_TIMEOUT_MS = 60_000;

/** Cap on the recently-resolved bookkeeping ring (idempotency window). */
export const APPROVAL_RECENTLY_RESOLVED_CAP = 1024;

/**
 * Thrown when the 60s timer fires before `resolve()` is called.
 *
 * agent-core's promise chain treats this as "no answer" — the calling tool
 * surfaces it upstream. The error type is identifiable so unit tests can
 * distinguish timeout vs other rejections.
 */
export class ApprovalExpiredError extends Error {
  constructor(public readonly approvalId: string, timeoutMs: number) {
    super(`approval ${approvalId} expired after ${timeoutMs}ms`);
    this.name = 'ApprovalExpiredError';
  }
}

interface PendingApproval {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly protocolRequest: ProtocolApprovalRequest;
  resolve: (r: ApprovalResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class ApprovalService extends Disposable implements IApprovalService {
  readonly _serviceBrand: undefined;

  /** Indexed by daemon-minted `approval_id` (REST path key). */
  private readonly _pending = new Map<string, PendingApproval>();
  /** Reverse lookup for `toolCallId` (legacy in-process interface compatibility). */
  private readonly _byToolCallId = new Map<string, string>();
  /**
   * Bounded set of recently-resolved approval ids. REST re-POST on a resolved
   * id returns 40902 (vs 40404 for never-existed). FIFO eviction at
   * `_recentlyResolvedCap`.
   */
  private readonly _recentlyResolved = new Set<string>();
  private _timeoutMs = APPROVAL_DEFAULT_TIMEOUT_MS;
  private readonly _recentlyResolvedCap = APPROVAL_RECENTLY_RESOLVED_CAP;

  constructor(
    @ILogService private readonly logger: ILogService,
    @IEventService private readonly eventService: IEventService,
  ) {
    super();
  }

  async request(
    req: ApprovalRequest & { sessionId: string; agentId: string },
  ): Promise<ApprovalResponse> {
    if (this._isDisposed) {
      throw new Error('approval service disposed');
    }

    const approvalId = ulid();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + this._timeoutMs).toISOString();

    const protocolRequest = approvalToBrokerRequest(req, {
      approvalId,
      sessionId: req.sessionId,
      createdAt,
      expiresAt,
    });

    // Synthesize the wire event. The event union accepts arbitrary `type`
    // strings (see PromptService precedent); we spread the protocol request
    // fields at top level so envelope.payload carries them directly (WS.md
    // §4.5: payload IS ApprovalRequest). `sessionId` (camelCase) is required
    // for `EventService.extractSessionId` routing.
    const event: Event = {
      type: 'event.approval.requested',
      sessionId: req.sessionId,
      agentId: req.agentId,
      ...protocolRequest,
    } as unknown as Event;

    // Broadcast the request BEFORE awaiting — `publish` is synchronous
    // (fan-out + ring-buffer entry) so subscribers see this frame before any
    // resolve/timeout follow-up.
    this.eventService.publish(event);

    this.logger.info(
      {
        approvalId,
        sessionId: req.sessionId,
        agentId: req.agentId,
        toolCallId: req.toolCallId,
      },
      'approval requested',
    );

    return await new Promise<ApprovalResponse>((resolve, reject) => {
      const timer = setTimeout(() => this._expire(approvalId), this._timeoutMs);
      timer.unref?.();
      this._pending.set(approvalId, {
        approvalId,
        sessionId: req.sessionId,
        toolCallId: req.toolCallId,
        createdAt,
        expiresAt,
        protocolRequest,
        resolve,
        reject,
        timer,
      });
      this._byToolCallId.set(req.toolCallId, approvalId);
    });
  }

  /**
   * Settle a pending approval by `approval_id`. Broadcasts
   * `event.approval.resolved` BEFORE settling the Promise so subscribers
   * observe the resolution in order with downstream events. Silent no-op for
   * unknown ids — REST routes pre-check via `isPending()` and emit
   * 40404 / 40902.
   */
  resolve(id: string, response: ApprovalResponse): void {
    const p = this._pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this._pending.delete(id);
    this._byToolCallId.delete(p.toolCallId);
    this.markResolved(p.approvalId);

    const resolvedAt = new Date().toISOString();
    const resolvedEvent: Event = {
      type: 'event.approval.resolved',
      sessionId: p.sessionId,
      agentId: 'main',
      approval_id: p.approvalId,
      decision: response.decision,
      scope: response.scope,
      feedback: response.feedback,
      selected_label: response.selectedLabel,
      resolved_at: resolvedAt,
    } as unknown as Event;
    this.eventService.publish(resolvedEvent);

    p.resolve(response);
  }

  /**
   * Has-pending check used by REST routes to discriminate `40404 not_found`
   * (never-existed-or-expired) vs proceed-to-resolve. Pairs with
   * `isRecentlyResolved` for `40902 already_resolved`.
   */
  isPending(approvalId: string): boolean {
    return this._pending.has(approvalId);
  }

  listPending(sessionId: string): ProtocolApprovalRequest[] {
    return Array.from(this._pending.values())
      .filter((p) => p.sessionId === sessionId)
      .map((p) => p.protocolRequest);
  }

  /**
   * Has-recently-resolved check used by REST routes to emit
   * `40902 already_resolved` on idempotent re-POST.
   */
  isRecentlyResolved(approvalId: string): boolean {
    return this._recentlyResolved.has(approvalId);
  }

  /**
   * Mark an id as resolved for idempotency. Called automatically by
   * `resolve()`; exposed publicly so the REST route can also stamp the
   * idempotency mark on the route-level idempotent path (no-op if already
   * marked).
   */
  markResolved(approvalId: string): void {
    if (this._recentlyResolved.size >= this._recentlyResolvedCap) {
      // FIFO-ish eviction: drop the first inserted entry. Set iteration order
      // is insertion order in ES2015+, so `next().value` gives the oldest.
      const oldest = this._recentlyResolved.values().next().value;
      if (oldest !== undefined) this._recentlyResolved.delete(oldest);
    }
    this._recentlyResolved.add(approvalId);
  }

  /** Test helper — number of pending approvals (0 by default). */
  _pendingCountForTest(): number {
    return this._pending.size;
  }

  /** Test helper — pending entry snapshot for assertions. */
  _peekPendingForTest(approvalId: string): { sessionId: string; toolCallId: string } | undefined {
    const p = this._pending.get(approvalId);
    if (!p) return undefined;
    return { sessionId: p.sessionId, toolCallId: p.toolCallId };
  }

  /** Test helper — override the default 60s timeout. */
  _setTimeoutMsForTests(ms: number): void {
    this._timeoutMs = ms;
  }

  private _expire(approvalId: string): void {
    const p = this._pending.get(approvalId);
    if (!p) return;
    this._pending.delete(approvalId);
    this._byToolCallId.delete(p.toolCallId);
    // Mark as resolved-style for idempotency — a late REST resolve on this id
    // gets 40902 rather than 40404 (matches "expired ≈ already_resolved" UX).
    this.markResolved(p.approvalId);

    const expiredEvent: Event = {
      type: 'event.approval.expired',
      sessionId: p.sessionId,
      agentId: 'main',
      approval_id: p.approvalId,
    } as unknown as Event;
    this.eventService.publish(expiredEvent);

    p.reject(new ApprovalExpiredError(p.approvalId, this._timeoutMs));
  }

  override dispose(): void {
    if (this._isDisposed) return;
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      try {
        p.reject(new Error('daemon shutting down'));
      } catch {
        // ignore — the awaiter may not have a catch handler attached yet.
      }
    }
    this._pending.clear();
    this._byToolCallId.clear();
    this._recentlyResolved.clear();
    super.dispose();
  }
}
