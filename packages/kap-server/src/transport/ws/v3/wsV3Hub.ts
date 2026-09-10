import type { IDisposable } from '@moonshot-ai/agent-core-v2';

import { ErrorCode } from '../../../protocol/error-codes';
import type { ServerMessage, SubscribeMessage } from '../../../protocol/messages';
import { GlobalMessageTranslator } from './globalTranslator';
import { SessionLane, type LaneSubscriber } from './sessionLane';
import { makeSubscriptionFilter, type WsConnectionV3 } from './wsConnectionV3';
import type {
  WsV3GlobalSource,
  WsV3Logger,
  WsV3Projection,
  WsV3SessionLifecycle,
} from './wsV3Deps';

export interface WsV3HubDeps {
  readonly projection: WsV3Projection;
  readonly lifecycle: WsV3SessionLifecycle;
  readonly globalSource: WsV3GlobalSource;
  readonly logger?: WsV3Logger;
}

export class WsV3Hub {
  private readonly lanes = new Map<string, SessionLane>();
  private readonly connections = new Set<WsConnectionV3>();
  private readonly translator: GlobalMessageTranslator;
  private readonly lifecycleDisposable: IDisposable;

  constructor(private readonly deps: WsV3HubDeps) {
    this.translator = new GlobalMessageTranslator(
      deps.globalSource,
      (message) => this.broadcastGlobal(message),
      deps.logger,
    );
    this.lifecycleDisposable = deps.lifecycle.onDidCreateSession((event) => {
      this.lanes.get(event.sessionId)?.notifySessionLive();
    });
  }

  addConnection(conn: WsConnectionV3): void {
    this.connections.add(conn);
  }

  subscribeSession(conn: WsConnectionV3, frame: SubscribeMessage): void {
    const lane = this.laneFor(frame.session_id);
    const previous = conn.subscriptionFor(frame.session_id);
    const sub: LaneSubscriber = {
      conn,
      filter: makeSubscriptionFilter(frame),
      recoveryPending: true,
    };
    conn.trackSubscription(frame.session_id, sub);
    lane.addSubscriber(sub, frame.id);
    if (previous !== undefined) lane.removeSubscriber(previous);
  }

  unsubscribeSession(conn: WsConnectionV3, sessionId: string, requestId: number): void {
    const sub = conn.subscriptionFor(sessionId);
    if (sub !== undefined) {
      conn.untrackSubscription(sessionId);
      this.lanes.get(sessionId)?.removeSubscriber(sub);
    }
    conn.enqueue({ type: 'ack', id: requestId, code: ErrorCode.SUCCESS });
  }

  dropConnection(conn: WsConnectionV3): void {
    this.connections.delete(conn);
    for (const sessionId of conn.subscriptionSessionIds) {
      const sub = conn.subscriptionFor(sessionId);
      if (sub !== undefined) this.lanes.get(sessionId)?.removeSubscriber(sub);
      conn.untrackSubscription(sessionId);
    }
  }

  dispose(): void {
    this.lifecycleDisposable.dispose();
    this.translator.dispose();
    for (const lane of this.lanes.values()) lane.dispose();
    this.lanes.clear();
    this.connections.clear();
  }

  private broadcastGlobal(message: ServerMessage): void {
    for (const conn of this.connections) conn.enqueue(message);
  }

  private laneFor(sessionId: string): SessionLane {
    const existing = this.lanes.get(sessionId);
    if (existing !== undefined) return existing;
    const lane = new SessionLane(sessionId, {
      projection: this.deps.projection,
      lifecycle: this.deps.lifecycle,
      onEmpty: (empty) => {
        if (this.lanes.get(empty.sessionId) === empty) this.lanes.delete(empty.sessionId);
        empty.dispose();
      },
      logger: this.deps.logger,
    });
    this.lanes.set(sessionId, lane);
    return lane;
  }
}
