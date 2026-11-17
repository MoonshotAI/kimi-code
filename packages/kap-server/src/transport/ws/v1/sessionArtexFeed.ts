import { ARTEX_FLAG_ID, IFlagService, type IDisposable, type ISessionScopeHandle } from '@moonshot-ai/agent-core-v2';
import { ISessionEventBus } from '@moonshot-ai/agent-core-v2/app/event/eventBus';

import type { ArtexWsMessage } from '../../../protocol/ws-artex';

export type ArtexFeedSend = (message: ArtexWsMessage) => void;

const ARTEX_EVENT_PREFIX = 'artex.';

export class SessionArtexFeed implements IDisposable {
  private readonly subscriptions: IDisposable[] = [];

  constructor(
    private readonly sessionId: string,
    session: ISessionScopeHandle,
    flags: IFlagService | undefined,
    private readonly send: ArtexFeedSend,
  ) {
    if (flags === undefined || !flags.enabled(ARTEX_FLAG_ID)) return;
    let bus: ISessionEventBus;
    try {
      bus = session.accessor.get(ISessionEventBus);
    } catch {
      return;
    }
    this.subscriptions.push(
      bus.subscribe((event: unknown) => {
        const type =
          typeof event === 'object' && event !== null && 'type' in event
            ? String((event as { type: string }).type)
            : (event as { constructor?: { type?: string } }).constructor?.type;
        if (type === undefined || !type.startsWith(ARTEX_EVENT_PREFIX)) return;
        const now = new Date().toISOString();
        const payload =
          typeof event === 'object' && event !== null && 'payload' in event
            ? (event as { payload: unknown }).payload
            : event;
        if (type === 'artex.exploration.updated') {
          const explorationId = (payload as { explorationId?: number }).explorationId;
          this.send({
            type: 'artex.exploration.updated',
            session_id: this.sessionId,
            event_created_at: now,
            exploration_id: explorationId,
            payload,
          });
          return;
        }
        if (type === 'artex.finding.reported') {
          const explorationId = (payload as { explorationId: number }).explorationId;
          this.send({
            type: 'artex.finding.reported',
            session_id: this.sessionId,
            event_created_at: now,
            exploration_id: explorationId,
            payload,
          });
          return;
        }
        if (type === 'artex.activity.appended') {
          const explorationId = (payload as { explorationId: number }).explorationId;
          this.send({
            type: 'artex.activity.appended',
            session_id: this.sessionId,
            event_created_at: now,
            exploration_id: explorationId,
            payload,
          });
          return;
        }
        if (type === 'artex.traffic.captured') {
          this.send({
            type: 'artex.traffic.captured',
            session_id: this.sessionId,
            event_created_at: now,
            payload,
          });
        }
      }),
    );
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.length = 0;
  }
}