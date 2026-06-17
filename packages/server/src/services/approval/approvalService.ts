

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

export class ApprovalExpiredError extends Error {
  constructor(public readonly approvalId: string, timeoutMs: number) {
    super(`approval ${approvalId} expired after ${timeoutMs}ms`);
    this.name = 'ApprovalExpiredError';
  }
}

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
    private readonly _timer: NodeJS.Timeout,
  ) {}

  markSettled(): void {
    if (this._settled) return;
    this._settled = true;
    clearTimeout(this._timer);
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
    clearTimeout(this._timer);
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
  private _timeoutMs = APPROVAL_DEFAULT_TIMEOUT_MS;
  private readonly _recentlyResolvedCap = APPROVAL_RECENTLY_RESOLVED_CAP;

  constructor(
    @ILogService private readonly logger: ILogService,
    @IEventService private readonly eventService: IEventService,
  ) {
    super();
    this._pending = this._register(new DisposableMap<string, PendingApproval>());
  }

  async request(
    req: ApprovalRequest & { sessionId: string; agentId: string },
  ): Promise<ApprovalResponse> {
    if (this._store.isDisposed) {
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
      const timer = setTimeout(() => this._expire(approvalId), this._timeoutMs);
      timer.unref?.();
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
          timer,
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

  _setTimeoutMsForTests(ms: number): void {
    this._timeoutMs = ms;
  }

  private _expire(approvalId: string): void {
    const p = this._pending.get(approvalId);
    if (!p) return;
    p.markSettled();
    this._pending.deleteAndLeak(approvalId);
    this._byToolCallId.delete(p.toolCallId);

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
    if (this._store.isDisposed) return;
    this._byToolCallId.clear();
    this._recentlyResolved.clear();
    super.dispose();
  }
}
