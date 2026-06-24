

import { ulid } from 'ulid';

import { Disposable, DisposableMap, IApprovalService, IEventService, approvalToBrokerRequest, ILogService, type IDisposable, type ApprovalRequest, type ApprovalResponse } from '@moonshot-ai/agent-core';
import type {
  ApprovalRequest as ProtocolApprovalRequest,
  Event,
} from '@moonshot-ai/protocol';


// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _typeAnchor: typeof IApprovalService = IApprovalService;

export const APPROVAL_DEFAULT_TIMEOUT_MS = 60_000;

export const APPROVAL_RECENTLY_RESOLVED_CAP = 1024;

class PendingApproval implements IDisposable {
  private _settled = false;

  constructor(
    readonly approvalId: string,
    readonly sessionId: string,
    readonly toolCallId: string,
    readonly createdAt: string,
    readonly expiresAt: string,
    readonly protocolRequest: ProtocolApprovalRequest,
    private readonly _resolveFn: (r: ApprovalResponse) => void,
    private readonly _rejectFn: (e: Error) => void,
  ) {}

  markSettled(): void {
    if (this._settled) return;
    this._settled = true;
  }

  resolve(r: ApprovalResponse): void {
    this._resolveFn(r);
  }

  reject(e: Error): void {
    this._rejectFn(e);
  }

  dispose(): void {
    if (this._settled) return;
    this._settled = true;
    try {
      this._rejectFn(new Error('server shutting down'));
    } catch {

    }
  }
}

export class ApprovalService extends Disposable implements IApprovalService {
  readonly _serviceBrand: undefined;

  private readonly _pending: DisposableMap<string, PendingApproval>;

  private readonly _byToolCallId = new Map<string, string>();

  private readonly _recentlyResolved = new Set<string>();
  private readonly _recentlyResolvedCap = APPROVAL_RECENTLY_RESOLVED_CAP;

  constructor(
    @ILogService private readonly logger: ILogService,
    @IEventService private readonly eventService: IEventService,
  ) {
    super();
    this._pending = this._register(new DisposableMap<string, PendingApproval>());

    // The turn's abort signal never reaches this broker: agent-core's
    // `BridgeClientAPI.requestApproval` drops the `{ signal }` option, so an
    // aborted turn would otherwise leave the approval in `_pending` forever
    // (pinning the session in `awaiting_approval` and keeping the web panel
    // open). Settle stale approvals when the in-process bus reports the turn
    // ended for a cancellation reason. This is intentionally session-scoped: a
    // turn has at most one pending approval, and on normal completion the
    // approval is already resolved so this is a no-op.
    this._register(
      this.eventService.onDidPublish((event) => {
        if ((event as { type?: string }).type !== 'turn.ended') return;
        const reason = (event as { reason?: string }).reason;
        if (reason !== 'cancelled' && reason !== 'failed' && reason !== 'filtered') return;
        const sessionId = (event as { sessionId?: string }).sessionId;
        if (sessionId === undefined || sessionId === '') return;
        this.dismissForSession(sessionId);
      }),
    );
  }

  private dismissForSession(sessionId: string): void {
    const ids: string[] = [];
    for (const p of this._pending.values()) {
      if (p.sessionId === sessionId) ids.push(p.approvalId);
    }
    for (const id of ids) {
      // Reuse resolve(): clears `_pending` / `_byToolCallId` and publishes
      // `event.approval.resolved` (decision: 'cancelled') so the web panel
      // closes. The agent-core caller's promise is already rejected by the
      // abort, so the resolved value is only observed by tests.
      this.resolve(id, { decision: 'cancelled' });
    }
  }

  async request(
    req: ApprovalRequest & { sessionId: string; agentId: string },
  ): Promise<ApprovalResponse> {
    if (this._store.isDisposed) {
      throw new Error('approval service disposed');
    }

    const approvalId = ulid();
    const createdAt = new Date().toISOString();
    // `expires_at` is still populated for the protocol/web contract, but the
    // broker no longer enforces it — approvals wait until the user resolves
    // them or the server shuts down.
    const expiresAt = new Date(Date.now() + APPROVAL_DEFAULT_TIMEOUT_MS).toISOString();

    const protocolRequest = approvalToBrokerRequest(req, {
      approvalId,
      sessionId: req.sessionId,
      createdAt,
      expiresAt,
    });

    const event: Event = {
      type: 'event.approval.requested',
      sessionId: req.sessionId,
      agentId: req.agentId,
      ...protocolRequest,
    } as unknown as Event;

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

    return new Promise<ApprovalResponse>((resolve, reject) => {
      this._pending.set(
        approvalId,
        new PendingApproval(
          approvalId,
          req.sessionId,
          req.toolCallId,
          createdAt,
          expiresAt,
          protocolRequest,
          resolve,
          reject,
        ),
      );
      this._byToolCallId.set(req.toolCallId, approvalId);
    });
  }

  resolve(id: string, response: ApprovalResponse): void {
    const p = this._pending.get(id);
    if (!p) return;
    p.markSettled();
    this._pending.deleteAndLeak(id);
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

  isPending(approvalId: string): boolean {
    return this._pending.has(approvalId);
  }

  listPending(sessionId: string): ProtocolApprovalRequest[] {
    return Array.from(this._pending.values())
      .filter((p) => p.sessionId === sessionId)
      .map((p) => p.protocolRequest);
  }

  isRecentlyResolved(approvalId: string): boolean {
    return this._recentlyResolved.has(approvalId);
  }

  markResolved(approvalId: string): void {
    if (this._recentlyResolved.size >= this._recentlyResolvedCap) {

      const oldest = this._recentlyResolved.values().next().value;
      if (oldest !== undefined) this._recentlyResolved.delete(oldest);
    }
    this._recentlyResolved.add(approvalId);
  }

  _pendingCountForTest(): number {
    return this._pending.size;
  }

  _peekPendingForTest(approvalId: string): { sessionId: string; toolCallId: string } | undefined {
    const p = this._pending.get(approvalId);
    if (!p) return undefined;
    return { sessionId: p.sessionId, toolCallId: p.toolCallId };
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    this._byToolCallId.clear();
    this._recentlyResolved.clear();
    super.dispose();
  }
}
