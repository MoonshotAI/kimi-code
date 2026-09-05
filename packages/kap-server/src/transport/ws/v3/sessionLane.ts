import type { IDisposable } from '@moonshot-ai/agent-core-v2';

import { ErrorCode } from '../../../protocol/error-codes';
import type { ServerMessage } from '../../../protocol/messages';
import {
  passesSubscriptionFilter,
  type SubscriptionFilter,
  type WsConnectionV3,
} from './wsConnectionV3';
import type { WsV3Logger, WsV3Projection, WsV3SessionLifecycle } from './wsV3Deps';

export interface LaneSubscriber {
  readonly conn: WsConnectionV3;
  readonly filter: SubscriptionFilter;
  recoveryPending: boolean;
}

export interface SessionLaneDeps {
  readonly projection: WsV3Projection;
  readonly lifecycle: WsV3SessionLifecycle;
  readonly onEmpty: (lane: SessionLane) => void;
  readonly logger?: WsV3Logger;
}

export class SessionLane {
  private readonly subscribers = new Set<LaneSubscriber>();
  private queue: Promise<void> = Promise.resolve();
  private attachDisposable?: IDisposable;
  private disposed = false;

  constructor(
    readonly sessionId: string,
    private readonly deps: SessionLaneDeps,
  ) {}

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  addSubscriber(sub: LaneSubscriber, requestId: number): void {
    this.subscribers.add(sub);
    this.enqueue(async () => {
      if (this.disposed || !this.subscribers.has(sub)) return;
      try {
        const exists = await this.deps.lifecycle.sessionExists(this.sessionId);
        if (!exists) {
          this.subscribers.delete(sub);
          sub.conn.untrackSubscription(this.sessionId);
          sub.conn.enqueue({
            type: 'ack',
            id: requestId,
            code: ErrorCode.SESSION_NOT_FOUND,
            msg: `session ${this.sessionId} does not exist`,
          });
          this.disposeIfEmpty();
          return;
        }
        this.ensureAttached();
        sub.conn.enqueue({ type: 'ack', id: requestId, code: ErrorCode.SUCCESS });
        if (this.attachDisposable !== undefined) {
          for (const message of this.deps.projection.recoveryMessages(this.sessionId)) {
            if (passesSubscriptionFilter(sub.filter, message)) sub.conn.enqueue(message);
          }
        }
      } catch (error) {
        this.deps.logger?.warn(
          {
            sessionId: this.sessionId,
            err: error instanceof Error ? error.message : String(error),
          },
          'ws v3: subscription recovery failed, subscriber keeps live traffic without recovery',
        );
        sub.conn.enqueue({
          type: 'ack',
          id: requestId,
          code: ErrorCode.INTERNAL_ERROR,
          msg: 'subscription recovery failed',
        });
      } finally {
        sub.recoveryPending = false;
      }
    });
  }

  removeSubscriber(sub: LaneSubscriber): void {
    if (!this.subscribers.delete(sub)) return;
    this.disposeIfEmpty();
  }

  notifySessionLive(): void {
    this.enqueue(() => {
      if (this.disposed) return;
      try {
        this.attachDisposable?.dispose();
        this.attachDisposable = undefined;
        this.ensureAttached();
        if (this.attachDisposable === undefined) return;
        const recovery = this.deps.projection.recoveryMessages(this.sessionId);
        for (const sub of this.subscribers) {
          for (const message of recovery) {
            if (passesSubscriptionFilter(sub.filter, message)) sub.conn.enqueue(message);
          }
        }
      } catch (error) {
        this.deps.logger?.warn(
          {
            sessionId: this.sessionId,
            err: error instanceof Error ? error.message : String(error),
          },
          'ws v3: session-live recovery failed, subscribers keep live traffic without recovery',
        );
      } finally {
        for (const sub of this.subscribers) sub.recoveryPending = false;
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.attachDisposable?.dispose();
    this.attachDisposable = undefined;
    this.subscribers.clear();
  }

  private ensureAttached(): void {
    if (this.attachDisposable !== undefined) return;
    this.attachDisposable = this.deps.projection.onMessage(this.sessionId, (message) => {
      this.enqueue(() => this.fanout(message));
    });
  }

  private fanout(message: ServerMessage): void {
    if (this.disposed) return;
    for (const sub of this.subscribers) {
      if (sub.recoveryPending) continue;
      if (!passesSubscriptionFilter(sub.filter, message)) continue;
      sub.conn.enqueue(message);
    }
  }

  private disposeIfEmpty(): void {
    if (this.subscribers.size > 0) return;
    this.deps.onEmpty(this);
  }

  private enqueue(task: () => Promise<void> | void): void {
    this.queue = this.queue.then(task).catch((error) => {
      this.deps.logger?.warn(
        {
          sessionId: this.sessionId,
          err: error instanceof Error ? error.message : String(error),
        },
        'ws v3: session lane task failed, lane continues',
      );
    });
  }
}
